import type { Component } from '@nya/core'
import type { OwnedCall } from '../../contracts.js'
import { credentialReadServiceKey } from '../../credentials/port.js'
import type { CredentialReadPort } from '../../credentials/port.js'
import { LLMFailure, llmServiceKey } from '../port.js'
import type { LLMPlan, LLMPort, ModelReply } from '../port.js'
import {
  buildChatCompletionRequest, chatCompletionsEndpoint, parseChatCompletion, validateDeepSeekConfiguration,
} from './domain.js'
import type { DeepSeekConfiguration, DeepSeekSelection } from './domain.js'

export interface DeepSeekTransport {
  /** Override only when routing through a compatible endpoint. */
  readonly baseUrl?: string
  /** Lets a host or test supply the HTTP transport. */
  readonly fetch?: typeof globalThis.fetch
}

/** The credential this component reads once per run. The host stores the key under it through `credentials.manage`. */
export const deepSeekCredentialId = 'llm/deepseek-chat-completions/default'

/** The application's LLM API component for DeepSeek's non-streaming Chat Completions. */
export function createDeepSeekChatCompletionsComponent(
  config: DeepSeekConfiguration, transport: DeepSeekTransport = {},
): Component.Object<void, { [credentialReadServiceKey]: CredentialReadPort }> {
  const selections = validateDeepSeekConfiguration(config)
  const endpoint = chatCompletionsEndpoint(transport?.baseUrl)
  const request = transport?.fetch ?? globalThis.fetch
  if (typeof request !== 'function') throw new TypeError('DeepSeek fetch must be a function')
  return {
    name: 'deepseek-chat-completions',
    inject: [credentialReadServiceKey],
    async apply(ctx, _config, deps) {
      const plans = new WeakMap<LLMPlan, DeepSeekSelection>()
      const runKeys = new WeakMap<LLMPlan, Promise<string>>()
      const active = new Set<OwnedCall<ModelReply>>()
      const failures: unknown[] = []
      let accepting = true

      ctx.effect(() => async () => {
        accepting = false
        const pending = [...active]
        for (const call of pending) call.cancel('llm-disposed')
        await Promise.allSettled(pending.map(call => call.done))
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) throw new AggregateError(failures, 'DeepSeek request cleanup failed')
      }, 'abort and join DeepSeek requests')

      const service: LLMPort = {
        supportsTools: true,
        prepare(profileId) {
          if (!accepting) throw new LLMFailure('dependency-unavailable')
          const selection = selections.get(profileId)
          if (!selection) throw new LLMFailure('model-unavailable')
          const plan: LLMPlan = Object.freeze({
            snapshot: Object.freeze({ profileId: selection.id, configVersion: selection.configVersion }),
          })
          plans.set(plan, selection)
          return plan
        },
        call(input) {
          if (!accepting) throw new LLMFailure('dependency-unavailable')
          const selection = plans.get(input.plan)
          if (!selection) throw new LLMFailure('model-unavailable')
          const body = JSON.stringify(buildChatCompletionRequest(selection, input.messages, input.tools))
          const controller = new AbortController()
          let timedOut = false
          let cleanupFailed = false
          let rejectOnTimeout!: (error: LLMFailure) => void
          const timeout = new Promise<never>((_, reject) => { rejectOnTimeout = reject })
          void timeout.catch(() => {})
          const timer = setTimeout(() => {
            timedOut = true
            controller.abort('timeout')
            rejectOnTimeout(new LLMFailure('timeout'))
          }, selection.timeoutMs)
          const operation = (async (): Promise<ModelReply> => {
            let key = runKeys.get(input.plan)
            if (!key) {
              key = (async () => {
                let value: string | undefined
                try { value = await deps[credentialReadServiceKey].read(deepSeekCredentialId, controller.signal) }
                catch { throw new LLMFailure('credential-unavailable') }
                if (!value?.trim()) throw new LLMFailure('credential-missing')
                return value
              })()
              runKeys.set(input.plan, key)
            }
            const apiKey = await key
            if (controller.signal.aborted) throw new LLMFailure(timedOut ? 'timeout' : 'provider-failure')
            let response: Response
            try {
              response = await request(endpoint, {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body,
                signal: controller.signal,
              })
            } catch { throw new LLMFailure(timedOut ? 'timeout' : 'provider-failure') }
            if (!response.ok) {
              try { await response.body?.cancel() } catch { cleanupFailed = true }
              throw new LLMFailure('provider-failure')
            }
            let payload: unknown
            try { payload = await response.json() } catch { throw new LLMFailure(timedOut ? 'timeout' : 'invalid-response') }
            return parseChatCompletion(payload, Boolean(input.tools?.length))
          })()
          // The request has exited once fetch and body consumption settled, whatever the business result.
          const done = operation.then(() => {}, () => {}).then(() => {
            clearTimeout(timer)
            if (cleanupFailed) throw new LLMFailure('cleanup-failure')
          })
          const call: OwnedCall<ModelReply> = {
            result: Promise.race([operation, timeout]),
            done: done.finally(() => { active.delete(call) }),
            cancel(reason) { controller.abort(reason); rejectOnTimeout(new LLMFailure('provider-failure')) },
          }
          active.add(call)
          void call.result.catch(() => {})
          void call.done.catch(error => { failures.push(error) })
          return call
        },
      }
      ctx.provide(llmServiceKey, service)
    },
  }
}

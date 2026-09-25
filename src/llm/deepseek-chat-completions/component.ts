import type { Component } from '@nya/core'
import type { OwnedCall } from '../../contracts.js'
import { LLMFailure, llmServiceKey } from '../port.js'
import type { LLMPlan, LLMPort } from '../port.js'
import {
  buildChatCompletionRequest, chatCompletionsEndpoint, parseChatCompletion, validateDeepSeekConfiguration,
} from './domain.js'
import type { DeepSeekConfiguration, DeepSeekSelection } from './domain.js'

export interface DeepSeekTransport {
  /** Read once when the component starts. The key stays in this component's closure. */
  readonly apiKey: () => string
  /** Override only when routing through a compatible endpoint. */
  readonly baseUrl?: string
  /** Lets a host or test supply the HTTP transport. */
  readonly fetch?: typeof globalThis.fetch
}

/** The application's LLM API component for DeepSeek's non-streaming Chat Completions. */
export function createDeepSeekChatCompletionsComponent(
  config: DeepSeekConfiguration, transport: DeepSeekTransport,
): Component.Object<void> {
  const selections = validateDeepSeekConfiguration(config)
  const endpoint = chatCompletionsEndpoint(transport?.baseUrl)
  const request = transport?.fetch ?? globalThis.fetch
  if (typeof transport?.apiKey !== 'function' || typeof request !== 'function') {
    throw new TypeError('DeepSeek API key provider and fetch are required')
  }
  return {
    name: 'deepseek-chat-completions',
    apply(ctx) {
      const apiKey = transport.apiKey()
      if (typeof apiKey !== 'string' || !apiKey.trim()) throw new TypeError('DeepSeek API key is required')
      const authorization = `Bearer ${apiKey}`
      const plans = new WeakMap<LLMPlan, DeepSeekSelection>()
      const active = new Set<OwnedCall<string>>()
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
          const body = JSON.stringify(buildChatCompletionRequest(selection, input.messages))
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
          const operation = (async (): Promise<string> => {
            let response: Response
            try {
              response = await request(endpoint, {
                method: 'POST',
                headers: { Authorization: authorization, 'Content-Type': 'application/json' },
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
            return parseChatCompletion(payload)
          })()
          // The request has exited once fetch and body consumption settled, whatever the business result.
          const done = operation.then(() => {}, () => {}).then(() => {
            clearTimeout(timer)
            if (cleanupFailed) throw new LLMFailure('cleanup-failure')
          })
          const call: OwnedCall<string> = {
            result: Promise.race([operation, timeout]),
            done: done.finally(() => { active.delete(call) }),
            cancel(reason) { controller.abort(reason) },
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

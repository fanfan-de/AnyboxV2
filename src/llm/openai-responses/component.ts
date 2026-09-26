import type { Component } from '@nya/core'
import type { OwnedCall } from '../../contracts.js'
import { credentialReadServiceKey } from '../../credentials/port.js'
import type { CredentialReadPort } from '../../credentials/port.js'
import { LLMFailure, llmServiceKey } from '../port.js'
import type { LLMPlan, LLMPort, ModelReply } from '../port.js'
import { buildResponsesRequest, parseResponsesOutput, responsesEndpoint, validateOpenAIResponsesConfiguration } from './domain.js'
import type { OpenAIResponsesConfiguration, OpenAIResponsesSelection } from './domain.js'

export interface OpenAIResponsesTransport {
  /** Override when routing through a Responses-compatible endpoint. */
  readonly baseUrl?: string
  readonly fetch?: typeof globalThis.fetch
}

/** The host writes this credential through credentials.manage; each call reads it once. */
export const openAIResponsesCredentialId = 'llm/openai-responses/default'

/** One non-streaming OpenAI Responses API implementation of the project's llm port. */
export function createOpenAIResponsesComponent(
  config: OpenAIResponsesConfiguration, transport: OpenAIResponsesTransport = {},
): Component.Object<void, { [credentialReadServiceKey]: CredentialReadPort }> {
  const selections = validateOpenAIResponsesConfiguration(config)
  const endpoint = responsesEndpoint(transport?.baseUrl)
  const request = transport?.fetch ?? globalThis.fetch
  if (typeof request !== 'function') throw new TypeError('OpenAI Responses fetch must be a function')
  return {
    name: 'openai-responses',
    inject: [credentialReadServiceKey],
    async apply(ctx, _config, deps) {
      const plans = new WeakMap<LLMPlan, OpenAIResponsesSelection>()
      const active = new Set<OwnedCall<ModelReply>>()
      const failures: unknown[] = []
      let accepting = true

      ctx.effect(() => async () => {
        accepting = false
        const pending = [...active]
        for (const call of pending) call.cancel('llm-disposed')
        await Promise.allSettled(pending.map(call => call.done))
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) throw new AggregateError(failures, 'OpenAI Responses request cleanup failed')
      }, 'abort and join OpenAI Responses requests')

      const service: LLMPort = {
        supportsTools: false,
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
          if (input.tools?.length) throw new LLMFailure('unsupported-request')
          const selection = plans.get(input.plan)
          if (!selection) throw new LLMFailure('model-unavailable')
          const body = JSON.stringify(buildResponsesRequest(selection, input.messages))
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
          const abortedFailure = () => new LLMFailure(timedOut ? 'timeout' : 'provider-failure')
          const operation = (async (): Promise<ModelReply> => {
            let apiKey: string | undefined
            try { apiKey = await deps[credentialReadServiceKey].read(openAIResponsesCredentialId, controller.signal) }
            catch { throw new LLMFailure('credential-unavailable') }
            if (controller.signal.aborted) throw abortedFailure()
            if (!apiKey?.trim()) throw new LLMFailure('credential-missing')
            let response: Response
            try {
              response = await request(endpoint, {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body,
                signal: controller.signal,
              })
            } catch { throw abortedFailure() }
            if (!response.ok) {
              try { await response.body?.cancel() } catch { cleanupFailed = true }
              throw new LLMFailure('provider-failure')
            }
            if (controller.signal.aborted) throw abortedFailure()
            let payload: unknown
            try { payload = await response.json() } catch {
              throw controller.signal.aborted ? abortedFailure() : new LLMFailure('invalid-response')
            }
            if (controller.signal.aborted) throw abortedFailure()
            return Object.freeze({ kind: 'final' as const, text: parseResponsesOutput(payload) })
          })()
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

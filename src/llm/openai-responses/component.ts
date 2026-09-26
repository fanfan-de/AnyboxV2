import type { Component } from '@nya/core'
import type { OwnedCall } from '../../contracts.js'
import { credentialReadServiceKey } from '../../credentials/port.js'
import type { CredentialReadPort } from '../../credentials/port.js'
import { LLMFailure, llmServiceKey } from '../port.js'
import type { LLMPlan, LLMPort, ModelReply } from '../port.js'
import { buildResponsesRequest, parseResponsesOutput, responsesContinuation, responsesEndpoint,
  snapshotResponsesMessages, validateOpenAIResponsesConfiguration } from './domain.js'
import type { OpenAIResponsesConfiguration, OpenAIResponsesSelection, ResponsesContinuation } from './domain.js'

export interface OpenAIResponsesTransport {
  /** Override when routing through a Responses-compatible endpoint. */
  readonly baseUrl?: string
  readonly fetch?: typeof globalThis.fetch
}

/** The host manages this credential; each Run's first call reads it once. */
export const openAIResponsesCredentialId = 'llm/openai-responses/default'

interface PlanState {
  readonly selection: OpenAIResponsesSelection
  key: Promise<string> | undefined
  busy: boolean
  continuation: ResponsesContinuation | undefined
}

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
      let plans = new WeakMap<LLMPlan, PlanState>()
      const active = new Set<OwnedCall<ModelReply>>()
      const failures: unknown[] = []
      let accepting = true

      ctx.effect(() => async () => {
        accepting = false
        const pending = [...active]
        for (const call of pending) call.cancel('llm-disposed')
        await Promise.allSettled(pending.map(call => call.done))
        plans = new WeakMap()
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) throw new AggregateError(failures, 'OpenAI Responses request cleanup failed')
      }, 'abort and join OpenAI Responses requests')

      const service: LLMPort = {
        supportsTools: true,
        prepare(profileId) {
          if (!accepting) throw new LLMFailure('dependency-unavailable')
          const selection = selections.get(profileId)
          if (!selection) throw new LLMFailure('model-unavailable')
          const plan: LLMPlan = Object.freeze({
            snapshot: Object.freeze({ profileId: selection.id, configVersion: selection.configVersion }),
          })
          plans.set(plan, { selection, key: undefined, busy: false, continuation: undefined })
          return plan
        },
        call(input) {
          if (!accepting) throw new LLMFailure('dependency-unavailable')
          const state = plans.get(input.plan)
          if (!state) throw new LLMFailure('model-unavailable')
          if (state.busy) throw new LLMFailure('unsupported-request')
          const { selection } = state
          const messages = snapshotResponsesMessages(input.messages)
          const nativeRequest = buildResponsesRequest(selection, messages, input.tools, state.continuation)
          let body: string
          try { body = JSON.stringify(nativeRequest) }
          catch { throw new LLMFailure('unsupported-request') }
          const toolsOffered = Boolean(nativeRequest.tools?.length)
          const controller = new AbortController()
          let timedOut = false
          let cleanupFailed = false
          let succeeded = false
          let continuation: ResponsesContinuation | undefined
          let rejectOnTimeout!: (error: LLMFailure) => void
          const timeout = new Promise<never>((_, reject) => { rejectOnTimeout = reject })
          void timeout.catch(() => {})
          const timer = setTimeout(() => {
            timedOut = true
            controller.abort('timeout')
            rejectOnTimeout(new LLMFailure('timeout'))
          }, selection.timeoutMs)
          const abortedFailure = () => new LLMFailure(timedOut ? 'timeout' : 'provider-failure')
          state.busy = true
          const operation = (async (): Promise<ModelReply> => {
            if (!state.key) {
              state.key = (async () => {
                let value: string | undefined
                try { value = await deps[credentialReadServiceKey].read(openAIResponsesCredentialId, controller.signal) }
                catch { throw new LLMFailure('credential-unavailable') }
                if (!value?.trim()) throw new LLMFailure('credential-missing')
                return value
              })()
            }
            const apiKey = await state.key
            if (controller.signal.aborted) throw abortedFailure()
            let response: Response
            try {
              response = await request(endpoint, {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body,
                signal: controller.signal,
              })
            } catch { throw abortedFailure() }
            // Even a late successful fetch owns a body that must exit before done resolves.
            if (!response.ok || controller.signal.aborted) {
              try { await response.body?.cancel() } catch { cleanupFailed = true }
              throw abortedFailure()
            }
            let payload: unknown
            try { payload = await response.json() } catch {
              throw controller.signal.aborted ? abortedFailure() : new LLMFailure('invalid-response')
            }
            if (controller.signal.aborted) throw abortedFailure()
            const parsed = parseResponsesOutput(payload, toolsOffered)
            continuation = responsesContinuation(messages, nativeRequest, parsed)
            succeeded = true
            return parsed.reply
          })()
          const done = operation.then(() => {}, () => {}).then(() => {
            clearTimeout(timer)
            try {
              if (cleanupFailed) throw new LLMFailure('cleanup-failure')
              if (succeeded && !controller.signal.aborted) state.continuation = continuation
            } finally {
              // Commit and unlock in the same exit step so cancellation cannot split them.
              state.busy = false
              active.delete(call)
            }
          })
          const call: OwnedCall<ModelReply> = {
            result: Promise.race([operation, timeout]),
            done,
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

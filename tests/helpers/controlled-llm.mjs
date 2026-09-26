import { LLMFailure, llmServiceKey } from '../../dist/llm/port.js'

export function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export function ids() {
  let next = 0
  return () => `id-${++next}`
}

/**
 * A controlled stand-in for the application's single LLM API component.
 * It honours the LLMPort contract and its cleanup order so Run behaviour is tested without HTTP.
 * Each recorded call exposes deferred `result` and `done` plus the cancellation reasons it received.
 */
export function controlledLLM({ version = 'v1', profiles = ['default'], call } = {}) {
  const calls = []
  const events = []
  const record = input => {
    const result = deferred()
    const done = deferred()
    const cancelled = deferred()
    const entry = { input, result, done, cancellations: [], cancelled }
    calls.push(entry)
    return {
      result: result.promise,
      done: done.promise,
      cancel(reason) {
        entry.cancellations.push(reason)
        if (entry.cancellations.length === 1) cancelled.resolve(reason)
      },
    }
  }
  const api = {
    calls, events, call,
    component: () => ({
      name: 'controlled-llm',
      apply(ctx) {
        const plans = new WeakMap()
        const active = new Set()
        let accepting = true
        ctx.effect(() => async () => {
          accepting = false
          const pending = [...active]
          for (const item of pending) { try { item.cancel('llm-disposed') } catch {} }
          await Promise.allSettled(pending.map(item => item.done))
          events.push('disposed')
        }, 'join controlled LLM calls')
        ctx.provide(llmServiceKey, {
          supportsTools: true,
          prepare(profileId) {
            if (!accepting) throw new LLMFailure('dependency-unavailable')
            if (!profiles.includes(profileId)) throw new LLMFailure('model-unavailable')
            const plan = Object.freeze({ snapshot: Object.freeze({ profileId, configVersion: version }) })
            plans.set(plan, profileId)
            return plan
          },
          call(input) {
            if (!accepting) throw new LLMFailure('dependency-unavailable')
            if (!plans.has(input.plan)) throw new LLMFailure('model-unavailable')
            const raw = (api.call ?? record)(input)
            const owned = {
              result: raw.result.then(value => typeof value === 'string' ? { kind: 'final', text: value } : value),
              done: raw.done,
              cancel: reason => raw.cancel(reason),
            }
            active.add(owned)
            void owned.done.then(() => active.delete(owned), () => active.delete(owned))
            void owned.result.catch(() => {})
            return owned
          },
        })
      },
    }),
  }
  return api
}

import type { Component } from '@nya/core'
import type { OwnedCall } from './contracts.js'

export const modelServiceKey = 'h0.model'
export const runServiceKey = 'h0.runs'

export interface RunProbePort {
  start(prompt: string): OwnedCall<string>
}

/** H0 deliberately retains its original string input while the Harness model port evolves. */
export interface ProbeModelPort {
  call(prompt: string): OwnedCall<string>
}

/** A small Nya component used to prove ownership before defining the Run API. */
export function createResourceProbe(): Component<void, { 'h0.model': ProbeModelPort }> {
  return {
    name: 'h0-resource-probe',
    inject: [modelServiceKey],
    apply(ctx, _config, deps) {
      let accepting = true
      const active = new Map<OwnedCall<string>, Promise<void>>()
      const failures: unknown[] = []

      ctx.effect(() => async () => {
        accepting = false
        const calls = [...active.keys()]
        const pending = [...active.values()]
        const errors = [...failures]
        for (const call of calls) {
          try { call.cancel('owner-disposed') } catch (error) { errors.push(error) }
        }
        for (const outcome of await Promise.allSettled(pending)) {
          if (outcome.status === 'rejected') errors.push(outcome.reason)
        }
        const unique = errors.filter((error, index) => errors.findIndex(other => Object.is(other, error)) === index)
        if (unique.length === 1) throw unique[0]
        if (unique.length > 1) throw new AggregateError(unique, 'owned call cleanup failed')
      }, 'wait for owned model calls')

      const service: RunProbePort = {
        start(prompt) {
          if (!accepting) throw new Error('run owner is closing')
          const call = deps[modelServiceKey].call(prompt)
          const settled = call.done.finally(() => { active.delete(call) })
          active.set(call, settled)
          void settled.catch(error => { failures.push(error) })
          return call
        },
      }
      ctx.provide(runServiceKey, service)
    },
  }
}

import type { Component } from '@nya/core'
import type { Owned, StateService } from '@anybox/agent-contracts/spi'

/** Own asynchronous provider acquisition before it can race component disposal. */
export function createStateComponent(factory: () => Owned<StateService> | Promise<Owned<StateService>>): Component.Object {
  return { name: 'agent-state', async apply(ctx) {
    let service: StateService | undefined
    const acquired = Promise.resolve().then(factory).then(owned => {
      service = owned.service
      return () => owned.close()
    })
    ctx.effect(() => acquired, 'agent state acquisition')
    await acquired
    ctx.provide('agent.state', service!)
  } }
}

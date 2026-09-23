import type { Component } from '@nya/core'
import type { Owned, StateService } from '@anybox/agent-contracts/spi'
import { createMemoryState } from '../state/memory.js'

export function createMemoryStateComponent(factory: () => Owned<StateService> = createMemoryState): Component.Object {
  return { name: 'memory-state', apply(ctx) {
    const owned = factory()
    ctx.effect(() => () => owned.close(), 'memory state')
    ctx.provide('agent.state', owned.service)
  } }
}

export const MemoryStateComponent = createMemoryStateComponent()

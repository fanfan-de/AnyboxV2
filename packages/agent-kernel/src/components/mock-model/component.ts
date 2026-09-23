import type { Component } from '@nya/core'
import type { Owned, ModelService } from '@anybox/agent-contracts/spi'
import { createMockModel } from './mock.js'

export function createMockModelComponent(factory: () => Owned<ModelService> = createMockModel): Component.Object {
  return { name: 'mock-model', apply(ctx) {
    const owned = factory()
    ctx.effect(() => () => owned.close(), 'mock model')
    ctx.provide('agent.model', owned.service)
  } }
}

export const MockModelComponent = createMockModelComponent()

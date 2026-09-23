import { FiberState } from '@nya/core'
import type { Component } from '@nya/core'
import type { RunLimits } from '@anybox/agent-contracts'
import type { StateService, ModelService, ToolService } from '@anybox/agent-contracts/spi'
import { createRunCoordinator } from './coordinator.js'
import type { CoordinatorSetup } from './coordinator.js'

export function createHarnessComponent(factories: CoordinatorSetup = {}): Component.Object<Partial<RunLimits> | undefined, {
  'agent.state': StateService; 'agent.model': ModelService; 'agent.tools': ToolService
}> {
  return { name: 'agent-harness', inject: ['agent.state', 'agent.model', 'agent.tools'], apply(ctx, config, deps) {
    const owned = createRunCoordinator({ state: deps['agent.state'], model: deps['agent.model'], tools: deps['agent.tools'],
      config, ...factories, available: () => ctx.fiber.state === FiberState.ACTIVE })
    ctx.effect(() => () => owned.close(), 'agent harness')
    ctx.provide('agent.kernel', owned.service)
  } }
}

export const HarnessComponent = createHarnessComponent()

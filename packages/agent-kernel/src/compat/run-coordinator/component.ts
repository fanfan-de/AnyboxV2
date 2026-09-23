import { FiberState } from '@nya/core'
import type { Component } from '@nya/core'
import type { RunLimits } from '@anybox/agent-contracts'
import type { StateService, ModelService } from '@anybox/agent-contracts/spi'
import { createRunCoordinator } from '../../components/harness/coordinator.js'
import type { CoordinatorSetup } from '../../components/harness/coordinator.js'

/** Legacy text-only composition; new applications use the Harness component. */
export function createRunCoordinatorComponent(factories: CoordinatorSetup = {}): Component.Object<Partial<RunLimits> | undefined, {
  'agent.state': StateService; 'agent.model': ModelService
}> {
  return { name: 'run-coordinator', inject: ['agent.state', 'agent.model'], apply(ctx, config, deps) {
    const owned = createRunCoordinator({ state: deps['agent.state'], model: deps['agent.model'], config, ...factories,
      available: () => ctx.fiber.state === FiberState.ACTIVE })
    ctx.effect(() => () => owned.close(), 'run coordinator')
    ctx.provide('agent.kernel', owned.service)
  } }
}

export const RunCoordinatorComponent = createRunCoordinatorComponent()

import { FiberState } from '@nya/core'
import type { Component } from '@nya/core'
import type { AgentDefinition } from '@anybox/agent-contracts'
import { KernelFault } from '@anybox/agent-contracts/api'
import type { AgentApi, KernelApi } from '@anybox/agent-contracts/api'

/** Each component generation initializes its injected kernel and exposes an application facade. */
export function createAgentComponent(definition: AgentDefinition): Component.Object<undefined, { 'agent.kernel': KernelApi }> {
  const acceptedDefinition = structuredClone(definition)
  return { name: 'agent-application', inject: ['agent.kernel'], async apply(ctx, _config, deps) {
    const kernel = deps['agent.kernel']
    if (kernel.describe().stateDurability !== 'persistent') {
      throw new KernelFault({ code: 'INVALID_ARGUMENT', message: 'Agent application requires persistent state' })
    }
    const agent = await kernel.initialize({ definition: acceptedDefinition })
    const assertActive = () => {
      if (ctx.fiber.state !== FiberState.ACTIVE) throw new KernelFault({ code: 'CLOSED', message: 'Agent application generation is unavailable' })
    }
    const invoke = async <T>(operation: () => Promise<T>): Promise<T> => { assertActive(); return operation() }
    const api: AgentApi = {
      describe: () => { assertActive(); return kernel.describe() },
      sessions: {
        create: () => invoke(() => kernel.sessions.create()),
        list: request => invoke(() => kernel.sessions.list(request)),
        get: request => invoke(() => kernel.sessions.get(request)),
        messages: request => invoke(() => kernel.sessions.messages(request)),
      },
      tasks: {
        submit: request => invoke(() => kernel.runs.start({ ...request, agentId: agent.id, agentGeneration: agent.generation })),
        list: request => invoke(() => kernel.runs.list(request)),
        get: request => invoke(() => kernel.runs.get(request)),
        inspect: request => invoke(() => kernel.runs.inspect(request)),
        events: request => invoke(() => kernel.runs.events(request)),
        cancel: request => invoke(() => kernel.runs.cancel(request)),
        wait: request => invoke(() => kernel.runs.wait(request)),
      },
    }
    ctx.provide('agent.application', api)
  } }
}

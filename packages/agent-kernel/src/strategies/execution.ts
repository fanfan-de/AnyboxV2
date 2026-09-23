import type { ExecutionStrategy, RunExecutionStrategy } from '@anybox/agent-contracts/spi'

export function createTextStrategy(): ExecutionStrategy {
  return { execute: (_request, call) => call().result }
}
export function createAgentLoop(): RunExecutionStrategy {
  return { async execute(context) {
    while (true) {
      const step = await context.modelStep()
      if (step.outcome === 'final') return { finalStepId: step.stepId }
      await context.executeTools({ stepId: step.stepId })
    }
  } }
}

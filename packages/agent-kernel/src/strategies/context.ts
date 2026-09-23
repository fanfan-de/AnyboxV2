import type { ContextBuilder } from '@anybox/agent-contracts/spi'
import { fault } from '../shared/errors.js'

export function createContextBuilder(): ContextBuilder {
  return { build({ state, run, history }) {
    const input = state.messages.get(run.inputMessageId)
    if (input?.role !== 'user') throw fault('INTERNAL', 'run input is missing')
    return { instructions: run.basis.definition.instructions, history, input: input.content,
      continuation: [...state.messages.values()].filter(message => message.runId === run.id && message.id !== input.id),
      tools: run.basis.tools }
  } }
}

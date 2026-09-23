import type { SessionPolicy } from '@anybox/agent-contracts/spi'
import { fault } from '../shared/errors.js'
import { terminal } from '../shared/utils.js'

export function createSessionPolicy(): SessionPolicy {
  return {
    validateStart(state, request) {
      const agent = state.agent
      if (!agent) throw fault('NOT_READY', 'initialize the agent first')
      if (request.agentId !== agent.id || request.agentGeneration !== agent.generation) throw fault('CONFLICT', 'agent generation does not match')
      const session = state.sessions.get(request.sessionId)
      if (!session || session.agentId !== agent.id) throw fault('NOT_FOUND', 'session not found')
      if ([...state.runs.values()].some(run => run.sessionId === session.id && !terminal(run))) throw fault('SESSION_BUSY', 'session already has an active run')
      if (session.version !== request.expectedSessionVersion) throw fault('CONFLICT', 'session version does not match')
      return session
    },
    history(state, current) {
      // Failed/cancelled runs with tool requests remain visible, including settlement outcomes.
      const toolRuns = new Set([...state.toolCalls.values()].map(call => call.runId))
      return [...state.messages.values()].filter(message => message.sessionId === current.sessionId
        && message.runId !== current.id && (state.runs.get(message.runId)?.status === 'completed' || toolRuns.has(message.runId)))
    },
  }
}

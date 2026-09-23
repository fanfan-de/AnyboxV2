import type { AgentDefinition, RunResult, StartRunRequest } from '@anybox/agent-contracts'
import { KernelFault, type KernelApi, type AgentApi } from '@anybox/agent-contracts/api'
import type { ModelService, Owned, StateService, StateSnapshot, StateDraft, ExecutionStrategy, SessionPolicy, RunExecutionStrategy, ToolService } from '@anybox/agent-contracts/spi'

export async function run(api: KernelApi, definition: AgentDefinition): Promise<RunResult> {
  const agent = await api.initialize({ definition })
  const session = await api.sessions.create()
  const request: StartRunRequest = {
    agentId: agent.id, agentGeneration: agent.generation, sessionId: session.id,
    expectedSessionVersion: session.version, requestKey: 'first', input: [{ type: 'text', text: 'hello' }],
  }
  const accepted = await api.runs.start(request)
  return api.runs.wait({ runId: accepted.runId, signal: new AbortController().signal })
}

export function model(): Owned<ModelService> {
  return {
    service: { call: () => ({ result: Promise.resolve({ content: [] }), done: Promise.resolve(), cancel() {} }) },
    close: () => Promise.resolve(),
  }
}

export const strategy: ExecutionStrategy = { execute: (_request, call) => call().result }
export const policy: SessionPolicy = {
  validateStart(state, request) {
    const session = state.sessions.get(request.sessionId)
    if (!session) throw new KernelFault({ code: 'NOT_FOUND', message: 'session not found' })
    return session
  },
  history: (state, run) => [...state.messages.values()].filter(message => message.sessionId === run.sessionId),
}
export const snapshot = (state: StateService) => state.readSnapshot()

// Compiled by the standalone-consumer test; these writes must remain type errors.
export function readonlySnapshot(state: StateSnapshot, draft: StateDraft): void {
  const view: StateSnapshot = draft
  draft.sessions.clear()
  // @ts-expect-error Snapshot collections cannot be changed.
  state.sessions.clear()
  // @ts-expect-error Snapshot fields cannot be replaced.
  state.runs = new Map()
  // @ts-expect-error Event arrays are read-only as well as their Map.
  state.events.get('run')?.push()
  const run = view.runs.get('run')
  if (run) {
    // @ts-expect-error Record fields remain read-only through the snapshot.
    run.status = 'running'
    // @ts-expect-error Nested domain records remain read-only.
    run.basis.definition.instructions = 'changed'
  }
}

export async function readonlyProvider(state: StateService): Promise<void> {
  const view = await state.readSnapshot()
  // @ts-expect-error State providers expose a read-only snapshot.
  view.toolCalls.clear()
}

export const loop: RunExecutionStrategy = { async execute(context) {
  while (true) {
    const step = await context.modelStep()
    if (step.outcome === 'final') return { finalStepId: step.stepId }
    await context.executeTools({ stepId: step.stepId })
  }
} }
export const tools: ToolService = {
  definitions: () => [{ id: 'echo', revision: 1, description: 'Echo text', inputSchema: { type: 'string' } }],
  call: request => ({ result: Promise.resolve({ status: 'succeeded', output: request.request.input }),
    done: Promise.resolve(), cancel() {} }),
}
export const inspect = (api: KernelApi, runId: string) => api.runs.inspect({ runId })
export const events = (api: KernelApi, runId: string) => api.runs.events({ runId, afterSeq: 0 })
export const submitTask = (api: AgentApi, request: Parameters<AgentApi['tasks']['submit']>[0]) => api.tasks.submit(request)

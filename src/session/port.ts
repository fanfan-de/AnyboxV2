import type { Session, ConversationNode, NodePage, NodeQuery } from './domain.js'
import type { Run, RunInput, RunOutcome, RunQuery } from '../run/domain.js'
import type { ActiveRunEvent, RunEvent, RunExecution } from '../run/execution.js'
import type { ExecutionSnapshot } from '@anybox/models'
import type { PromptSnapshot } from '../prompt/domain.js'

export const sessionServiceKey = 'harness.sessions'
export const sessionRunServiceKey = 'harness.session-runs'

/** Public session facts. Run commands and in-flight resources belong to the execution components. */
export interface SessionPort {
  createSession(projectId: string, agentId: string, modelId?: string): Promise<Session>
  selectSessionModel(sessionId: string, modelId: string): Promise<Session>
  getSession(id: string): Promise<Session | undefined>
  listSessions(projectId: string): Promise<readonly Session[]>
  getNode(sessionId: string, id: string): Promise<ConversationNode | undefined>
  getNodePath(sessionId: string, id: string | null): Promise<readonly ConversationNode[]>
  listNodes(sessionId: string, parentId: string | null, query?: NodeQuery): Promise<NodePage>
  getRun(id: string): Promise<Run | undefined>
  getRunByKey(sessionId: string, key: string): Promise<Run | undefined>
  listRuns(sessionId: string, query?: RunQuery): Promise<readonly Run[]>
  getRunEvents(id: string, afterSeq?: number): Promise<readonly RunEvent[] | undefined>
}

/** One read of an accepted Run's durable inputs; no live model plan or provider context. */
export interface RunContext {
  readonly run: Run
  readonly projectId: string
  readonly history: readonly ConversationNode[]
  readonly prompts: readonly PromptSnapshot[]
}

/** Trusted execution-facing operations on the same Session owner, not an access boundary. */
export interface SessionRunPort {
  findAcceptedRun(input: RunInput): Promise<Run | undefined>
  registerRun(id: string, input: RunInput, now: string,
    prompts: readonly PromptSnapshot[], model: ExecutionSnapshot): Promise<{ readonly run: Run; readonly created: boolean }>
  loadRunContext(id: string): Promise<RunContext | undefined>
  getRun(id: string): Promise<Run | undefined>
  getRunExecution(id: string): Promise<RunExecution | undefined>
  recordRunEvent(id: string, event: ActiveRunEvent, at: string): Promise<RunExecution | undefined>
  requestCancellation(id: string, now: string): Promise<Run | undefined>
  /** AgentLoop must observe every owned call's actual exit before requesting a successful settlement. */
  settleRun(id: string, outcome: RunOutcome, now: string): Promise<Run>
}

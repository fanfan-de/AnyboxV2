import type {
  AgentDefinition, AgentInstance, CancelRunReceipt, KernelDescription, RunAccepted,
  RunResult, RunSnapshot, Session, SessionHistory, StartRunRequest, RunInspection, RunEventPage, SubmitTaskRequest,
} from './index.js'

export { KernelFault } from './fault.js'

/** 嵌入调用接口；业务失败返回终态，操作拒绝使用 KernelFault。 */
export interface KernelApi {
  initialize(request: { readonly definition: AgentDefinition }): Promise<AgentInstance>
  describe(): KernelDescription
  readonly sessions: {
    create(): Promise<Session>
    list(request?: { readonly offset?: number; readonly limit?: number }): Promise<readonly Session[]>
    get(request: { readonly sessionId: string }): Promise<Session>
    messages(request: { readonly sessionId: string }): Promise<SessionHistory>
  }
  readonly runs: {
    list(request?: { readonly sessionId?: string; readonly offset?: number; readonly limit?: number }): Promise<readonly RunSnapshot[]>
    start(request: StartRunRequest): Promise<RunAccepted>
    get(request: { readonly runId: string }): Promise<RunSnapshot>
    inspect(request: { readonly runId: string }): Promise<RunInspection>
    /** Committed events only; afterSeq is exclusive. No live subscription or token streaming. */
    events(request: { readonly runId: string; readonly afterSeq?: number; readonly limit?: number }): Promise<RunEventPage>
    cancel(request: { readonly runId: string; readonly reason?: string }): Promise<CancelRunReceipt>
    /** 业务失败返回 failed；signal 仅取消本次等待。 */
    wait(request: { readonly runId: string; readonly signal?: AbortSignal }): Promise<RunResult>
  }
}

/** Initialized application-facing facade. Each task is one durable Run in this first version. */
export interface AgentApi {
  describe(): KernelDescription
  readonly sessions: KernelApi['sessions']
  readonly tasks: Omit<KernelApi['runs'], 'start'> & {
    submit(request: SubmitTaskRequest): Promise<RunAccepted>
  }
}

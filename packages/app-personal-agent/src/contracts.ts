/** Personal Agent owns these versioned business records; no model credentials enter them. */
export interface AgentConfiguration {
  name: string
  description: string
  systemPrompt: string
  memory: string
  skills: string
  modelId: string | null
  /** Explicit character budget for the complete instruction and supplied text context. */
  contextLimit: number
}
export interface Agent extends AgentConfiguration {
  id: string
  revision: number
  createdAt: string
  updatedAt: string
}
export type WorkKind = 'conversation' | 'task'
export type WorkStatus = 'open' | 'running' | 'waiting' | 'completed' | 'cancelled'
export interface Work {
  id: string
  agentId: string
  kind: WorkKind
  title: string
  goal: string
  status: WorkStatus
  waitReason: string
  progress: string
  contextSegment: number
  sourceWorkId: string | null
  createdAt: string
  updatedAt: string
  revision: number
}
export type RunStatus = 'running' | 'succeeded' | 'cancelled' | 'failed' | 'interrupted'
export interface Run {
  id: string
  workId: string
  status: RunStatus
  contextSegment: number
  agent: Agent
  input: string
  /** Exact application-owned text supplied to Models; native state stays in Models. */
  instruction: string
  context: string
  output: string
  error: string | null
  modelRevision: number | null
  protocolId: string | null
  createdAt: string
  finishedAt: string | null
}
export interface Artifact {
  id: string
  workId: string
  runId: string | null
  title: string
  content: string
  createdAt: string
}
export interface WorkspaceState {
  agents: Agent[]
  works: Work[]
  preferredAgentId: string | null
}
export interface WorkDetail { work: Work; runs: Run[]; artifacts: Artifact[]; delegations: Work[] }
export interface ModelChoice { id: string; name: string; protocolId: string; available: boolean; unavailableReason?: string }
export interface ModelConnection {
  id: string; name: string; protocolId: string; baseUrl: string; revision: number; credentialConfigured: boolean
}
export interface ModelState { models: ModelChoice[]; connections: ModelConnection[] }
export interface PersonalAgentPort {
  state(): Promise<WorkspaceState>
  detail(id: string): Promise<WorkDetail>
  saveAgent(input: AgentConfiguration & { id?: string; expectedRevision?: number }): Promise<Agent>
  preferAgent(agentId: string): Promise<void>
  createWork(input: { agentId: string; kind: WorkKind; title: string; goal: string }): Promise<Work>
  updateWork(id: string, input: { expectedRevision: number; status?: Exclude<WorkStatus, 'running'>; waitReason?: string; progress?: string }): Promise<Work>
  startRun(id: string, input: { input: string; expectedRevision: number }): Promise<Run>
  cancelRun(workId: string, runId: string): Promise<Run>
  newContext(id: string, expectedRevision: number): Promise<Work>
  delegate(id: string, input: { agentId: string; title: string; goal: string }): Promise<Work>
  saveArtifact(id: string, input: { title: string; content: string; runId?: string }): Promise<Artifact>
}
export const personalAgentServiceKey = 'personal-agent.workspace'
export const personalAgentHttpServiceKey = 'personal-agent.http'
export const personalAgentAdmissionServiceKey = 'personal-agent.admission'
export interface PersonalAgentAdmissionPort {
  closeAdmission(): void
  busy(): boolean
  pauseIfIdle(): (() => void) | undefined
}

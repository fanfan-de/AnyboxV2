import type { AgentDefinition, AgentApplicationStatus, RunLimits } from '@anybox/agent-contracts'
import type { AgentApi } from '@anybox/agent-contracts/api'
import type { Owned, StateService, ModelService, ToolService } from '@anybox/agent-contracts/spi'
import type { CoordinatorFactories } from '@anybox/agent-kernel'
import type { Application, ApplicationOptions } from '@anybox/application'

export interface AgentApplicationOptions extends ApplicationOptions {
  readonly definition: AgentDefinition
  readonly state: () => Owned<StateService> | Promise<Owned<StateService>>
  readonly model: () => Owned<ModelService>
  readonly tools?: () => Owned<ToolService>
  readonly limits?: Partial<RunLimits>
  readonly strategies?: CoordinatorFactories
}
export interface AgentApplication extends AgentApi {
  readonly context: Application['context']
  readonly failure: Promise<unknown>
  readonly configuration: Pick<Application, 'previewConfig' | 'saveConfig' | 'refreshConfig' | 'recover'>
  status(): AgentApplicationStatus
  start(): Promise<void>
  close(): Promise<void>
}

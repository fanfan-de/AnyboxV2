import type { Message, RunSnapshot, Session, StartRunRequest } from '../index.js'
import type { ModelCallHandle, ModelOutput, ModelRequest } from './model.js'
import type { StateSnapshot } from './state.js'

export interface SessionPolicy {
  validateStart(state: StateSnapshot, request: StartRunRequest): Session
  history(state: StateSnapshot, run: RunSnapshot): readonly Message[]
}
/** 受控执行只获得一次模型入口，不能绕过取消、状态或资源管理。 */
export interface ExecutionStrategy {
  /** 取消时必须退出自有工作并清理后再 settle；不得保留脱离此 Promise 的任务。 */
  execute(request: ModelRequest, call: () => ModelCallHandle, signal: AbortSignal): Promise<ModelOutput>
}

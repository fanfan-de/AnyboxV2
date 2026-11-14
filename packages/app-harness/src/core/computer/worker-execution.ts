import type { JsonValue } from '@anybox/models'
import type { OwnedCall } from '../contracts.js'
import type { ToolObservation, ValidatedToolRequest } from '../run/domain.js'
import type { BashPort } from '@anybox/computer-tools/bash'
import type { ApplyPatchPort } from '@anybox/computer-tools/apply-patch'
import type { ProcessToolsPort, ProcessScope } from '@anybox/computer-tools/processes'
import type { FileToolsPort } from '@anybox/computer-tools/files'
import { adaptFileToolCall, adaptProcessToolCall } from '@anybox/computer-tools/adapters'
import type { WorkspaceBinding } from '../workspace/port.js'
import { computerToolExecutor } from './tool-support.js'

export interface WorkerExecution {
  execute(request: ValidatedToolRequest, binding: WorkspaceBinding): OwnedCall<ToolObservation>
  hasProcesses(): boolean
  close(): OwnedCall<JsonValue>
}

function map<T>(call: OwnedCall<T>, convert: (value: T) => ToolObservation): OwnedCall<ToolObservation> {
  return { result: call.result.then(convert), done: call.done, cancel: reason => call.cancel(reason) }
}
/** The independent worker owns this scope and its tool dependency generation. */
export function createWorkerExecution(input: {
  readonly runId: string; readonly sessionId: string; readonly projectId: string; readonly imageInput: boolean
  readonly signal: AbortSignal; readonly bash: BashPort; readonly patch: ApplyPatchPort
  readonly processes: ProcessToolsPort; readonly files: FileToolsPort
}): WorkerExecution {
  let processes: ProcessScope | undefined
  return {
    execute(request, binding) {
      const target = { workspacePath: binding.path }
      const scope = () => processes ??= input.processes.openScope({ ...target, scopeId: input.runId })
      const executor = computerToolExecutor(request.name)
      if (request.name === 'bash') return map(input.bash.execute({ ...target, command: String(request.arguments.command) }), result => ({ name: 'bash', result: JSON.parse(JSON.stringify(result)) as JsonValue }))
      if (request.name === 'apply_patch') return map(input.patch.execute({ ...target, patch: String(request.arguments.patch) }), result => ({ name: 'apply_patch', result: JSON.parse(JSON.stringify(result)) as JsonValue }))
      const name = request.name, args = request.arguments
      if (executor === 'processes') {
        const adapted = adaptProcessToolCall(name, args), current = scope()
        const call = adapted.operation === 'execute' ? current.execute(adapted.input) : adapted.operation === 'write' ? current.write(adapted.input) : current.foreground(adapted.input)
        return map(call, result => ({ name, result }))
      }
      if (executor === 'apply-patch') return map(input.patch.execute({ ...target, patch: String(args.patch) }), result => ({ name, result: JSON.parse(JSON.stringify(result)) as JsonValue }))
      return map(input.files.execute({ ...target, scopeId: input.sessionId, request: adaptFileToolCall(name, args),
        signal: input.signal, imageInput: input.imageInput }), value => ({ name, ...value }))
    },
    hasProcesses: () => processes !== undefined,
    close: () => processes?.close() ?? { result: Promise.resolve({ processes: [] }), done: Promise.resolve(), cancel() {} },
  }
}

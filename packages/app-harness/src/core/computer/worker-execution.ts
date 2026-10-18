import type { JsonValue } from '@anybox/models'
import type { OwnedCall } from '../contracts.js'
import type { ToolObservation, ValidatedToolRequest } from '../run/domain.js'
import type { BashPort } from '../tool/bash-component.js'
import type { ApplyPatchPort } from '../tool/apply-patch-component.js'
import type { ProcessToolsPort, ProcessRunScope } from '../tool/process-component.js'
import type { FileToolsPort } from '../tool/files-component.js'
import type { WorkspaceBinding } from '../workspace/port.js'

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
  let processes: ProcessRunScope | undefined
  return {
    execute(request, binding) {
      const target = { projectId: input.projectId, workspacePath: binding.path }
      const scope = () => processes ??= input.processes.openRun({ ...target, runId: input.runId })
      if (request.name === 'bash') return map(input.bash.execute({ ...target, command: request.arguments.command }), result => ({ name: 'bash', result }))
      if (request.name === 'apply_patch') return map(input.patch.execute({ ...target, patch: request.arguments.patch }), result => ({ name: 'apply_patch', result }))
      const name = request.name, args = request.arguments
      if (name === 'codex_exec_command' || name === 'codex_write_stdin') return map(scope().execute(name, args), result => ({ name, result }))
      if (name === 'claude_code_Bash' || name === 'deepseek_harness_bash') return map(scope().foreground({
        command: String(args.command), ...(typeof (args.timeout ?? args.timeoutMs) === 'number' ? { timeoutMs: Number(args.timeout ?? args.timeoutMs) } : {}),
        ...(typeof args.workdir === 'string' ? { workdir: args.workdir } : {}),
      }), result => ({ name, result }))
      if (name === 'codex_apply_patch') return map(input.patch.execute({ ...target, patch: String(args.patch) }), result => ({ name, result: JSON.parse(JSON.stringify(result)) as JsonValue }))
      return map(input.files.execute({ ...target, runId: input.runId, sessionId: input.sessionId, name, args,
        signal: input.signal, imageInput: input.imageInput }), value => ({ name, ...value }))
    },
    hasProcesses: () => processes !== undefined,
    close: () => processes?.close() ?? { result: Promise.resolve({ processes: [] }), done: Promise.resolve(), cancel() {} },
  }
}

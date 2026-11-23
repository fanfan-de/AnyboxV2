import { createHash } from 'node:crypto'
import type { PromptSnapshot } from '../prompt/domain.js'

/** Non-secret execution facts are fixed alongside the initial tool declarations. */
export function toolEnvironmentPrompt(platform: string, projectPath: string, workspace?: { name: string; prefix: string; primary?: boolean }): PromptSnapshot {
  const placement = workspace ? `Computer workspace ${JSON.stringify(workspace.name)}, tool name prefix ${workspace.prefix}.\n` : ''
  const handoff = workspace?.primary ? 'Each Computer has its own filesystem and process handles. Use the workspace prefix for every call. ' +
    'For a requested deployment, fix failing tests and wait for a passing result. Deliver the tested commit or artifact digest through the project’s release channel and verify that same version and its logs on the target. ' +
    'If a deployment reply is lost, query the original release request before considering another submission.\n' : ''
  const execCommand = (workspace?.prefix ?? '') + 'codex_exec_command'
  const content = placement + handoff + `Computer execution environment:\nOperating system: ${platform}.\nProject directory (JSON string): ${JSON.stringify(projectPath)}.\n` +
    (platform === 'win32' ? `${execCommand} defaults to PowerShell 7; use PowerShell syntax and native Windows paths. ` :
      platform === 'darwin' || platform === 'linux' ? `${execCommand} defaults to Bash; use POSIX shell syntax. ` : 'The default shell is unknown; select an explicit shell. ') +
    'An explicit shell selects that shell and its syntax. Tools named Bash or bash always execute Bash, including the native Windows Bash runtime. ' +
    'Commands use pipes, not a terminal. Processes belong to this Run and are cleaned up when the Run finishes; independent background jobs are unsupported.'
  return Object.freeze({ documentId: workspace ? 'builtin:computer-environment:' + workspace.prefix : 'builtin:computer-environment', versionId: `builtin:computer-environment:v2:${createHash('sha256').update(content).digest('hex')}`,
    kind: 'context', role: 'system', content })
}

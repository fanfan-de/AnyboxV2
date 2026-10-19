import { createHash } from 'node:crypto'
import type { PromptSnapshot } from '../prompt/domain.js'

/** Non-secret execution facts are fixed alongside the initial tool declarations. */
export function toolEnvironmentPrompt(platform: string, projectPath: string): PromptSnapshot {
  const content = `Computer execution environment:\nOperating system: ${platform}.\nProject directory (JSON string): ${JSON.stringify(projectPath)}.\n` +
    (platform === 'win32' ? 'codex_exec_command defaults to PowerShell 7; use PowerShell syntax and native Windows paths. ' :
      platform === 'darwin' || platform === 'linux' ? 'codex_exec_command defaults to Bash; use POSIX shell syntax. ' : 'The default shell is unknown; select an explicit shell. ') +
    'An explicit shell selects that shell and its syntax. Tools named Bash or bash always execute Bash, including the native Windows Bash runtime. ' +
    'Commands use pipes, not a terminal. Processes belong to this Run and are cleaned up when the Run finishes; independent background jobs are unsupported.'
  return Object.freeze({ documentId: 'builtin:computer-environment', versionId: `builtin:computer-environment:v1:${createHash('sha256').update(content).digest('hex')}`,
    kind: 'context', role: 'developer', content })
}

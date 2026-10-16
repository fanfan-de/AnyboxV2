import { posix, win32 } from 'node:path'
import type { EnvironmentView } from '../view.js'

export interface ResolveExecutableInput {
  readonly override?: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly platform: string
  readonly homeDirectory: string
  /** True when the path names an existing regular file. */
  readonly isFile: (path: string) => boolean
}
export type ResolvedExecutable = EnvironmentView['executable']
const windowsShims: ReadonlySet<string> = new Set(['.cmd', '.bat', '.ps1'])
/** npm installs ship a launcher shim the SDK cannot spawn; the real entry sits in the package next to it. */
const windowsPackageEntries = [['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'], ['node_modules', '@anthropic-ai', 'claude-code', 'cli.js']] as const
const missingMessage = '未找到 `claude` 命令。请在执行设备上安装 Claude 并运行 `claude --version` 与 `claude auth login` 确认可用，或用 ANYBOX_CLAUDE_AGENT_BINARY 指定可执行文件的绝对路径。'

/**
 * Pure resolution of the user's own `claude` executable: explicit override, PATH (with PATHEXT on Windows), then the
 * official installer location on Unix. GUI-launched desktop processes inherit a minimal PATH, hence the fallback.
 */
export function resolveClaudeExecutable(input: ResolveExecutableInput): ResolvedExecutable {
  const windows = input.platform === 'win32', path = windows ? win32 : posix
  const unshim = (candidate: string, source: ResolvedExecutable['source']): ResolvedExecutable => {
    if (!windows || !windowsShims.has(path.extname(candidate).toLowerCase())) return { path: candidate, source }
    const directory = path.dirname(candidate)
    for (const segments of windowsPackageEntries) {
      const entry = path.join(directory, ...segments)
      if (input.isFile(entry)) return { path: entry, source }
    }
    return { path: null, source: null, error: { code: 'claude-binary-shim', message: `${candidate} 是无法直接启动的启动脚本，请用 ANYBOX_CLAUDE_AGENT_BINARY 指定 claude.exe 或 cli.js 的路径。` } }
  }
  if (input.override !== undefined) {
    if (!input.isFile(input.override)) return { path: null, source: null, error: { code: 'claude-binary-missing', message: `ANYBOX_CLAUDE_AGENT_BINARY 指向的文件不存在：${input.override}` } }
    return unshim(input.override, 'override')
  }
  const extensions = windows ? [...new Set(['', ...(input.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(value => value.toLowerCase())])] : ['']
  const entries = (input.env.PATH ?? input.env.Path ?? '').split(windows ? ';' : ':').map(entry => entry.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)
  for (const entry of entries) for (const extension of extensions) {
    const candidate = path.join(entry, `claude${extension}`)
    if (input.isFile(candidate)) return unshim(candidate, 'path')
  }
  if (!windows) {
    const fallback = path.join(input.homeDirectory, '.local', 'bin', 'claude')
    if (input.isFile(fallback)) return { path: fallback, source: 'fallback' }
  }
  return { path: null, source: null, error: { code: 'claude-binary-missing', message: missingMessage } }
}

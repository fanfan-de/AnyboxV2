import { existsSync } from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { resolveRuntimeDirectory } from './runtime-path.js'

export interface ShellCommand { readonly executable: string; readonly args: readonly string[]; readonly env: NodeJS.ProcessEnv; readonly windowsVerbatimArguments?: boolean }

function firstFile(paths: readonly (string | undefined)[]): string | undefined {
  return paths.find((path): path is string => !!path && existsSync(path))
}
function fromPath(name: string): string | undefined {
  const paths = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean)
  return firstFile(paths.map(path => join(path, name)))
}
function configured(name: 'ANYBOX_BASH' | 'ANYBOX_POWERSHELL'): string | undefined {
  const value = process.env[name]
  if (value === undefined) return undefined
  if (!isAbsolute(value) || !existsSync(value)) throw new Error(`${name} must name an installed shell by absolute path`)
  return value
}

/** Never select Windows' bash.exe/wsl.exe launcher for a native Bash contract. */
export function bashExecutable(): string {
  const explicit = configured('ANYBOX_BASH')
  if (explicit) {
    if (process.platform === 'win32' && /[\\/]windows[\\/](?:system32|sysnative)[\\/]/i.test(explicit)) throw new Error('WSL is not a native Bash runtime')
    return explicit
  }
  if (process.platform !== 'win32') return firstFile(['/bin/bash', '/usr/bin/bash']) ?? 'bash'
  const git = fromPath('git.exe'), runtime = resolveRuntimeDirectory()
  const found = firstFile([
    runtime && join(runtime, 'bash/bin/bash.exe'),
    git && resolve(dirname(git), '../bin/bash.exe'),
    git && resolve(dirname(git), '../../bin/bash.exe'),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Git/bin/bash.exe'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs/Git/bin/bash.exe'),
  ])
  if (!found) throw new Error('Native Bash is unavailable; install the complete Anybox runtime or configure ANYBOX_BASH')
  return found
}
export function powershellExecutable(): string {
  const runtime = resolveRuntimeDirectory()
  const found = configured('ANYBOX_POWERSHELL') ?? firstFile([
    runtime && join(runtime, 'powershell/pwsh.exe'), fromPath('pwsh.exe'),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'PowerShell/7/pwsh.exe'),
  ])
  if (!found) throw new Error('PowerShell 7 is unavailable; install the complete Anybox runtime or configure ANYBOX_POWERSHELL')
  return found
}

/** Deliberately excludes provider credentials and application configuration. */
export function toolEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  const allowed = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SystemRoot', 'SystemDrive', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']
  for (const name of allowed) {
    const actual = Object.keys(process.env).find(key => process.platform === 'win32' ? key.toLowerCase() === name.toLowerCase() : key === name)
    if (actual !== undefined) env[name] = process.env[actual]
  }
  env.PATH ??= process.platform === 'win32' ? '' : '/usr/bin:/bin'
  env.HOME ??= process.env.USERPROFILE ?? ''
  env.LANG ??= 'C.UTF-8'
  return env
}

/** Shell text remains code; only the shell's own invocation syntax is adapted. */
export function prepareShellCommand(input: { command: string; shell?: string; login?: boolean; bash?: boolean }): ShellCommand {
  let executable = input.bash ? bashExecutable() : input.shell ?? (process.platform === 'win32' ? powershellExecutable() : bashExecutable())
  const kind = basename(executable).toLowerCase().replace(/\.exe$/, '')
  if (process.platform === 'win32') {
    if (['wsl', 'wslhost'].includes(kind) || kind === 'bash' && /[\\/]windows[\\/](?:system32|sysnative)[\\/]/i.test(executable)) throw new Error('WSL is not a native shell')
    if (!isAbsolute(executable)) {
      if (kind === 'bash') executable = bashExecutable()
      else if (kind === 'pwsh') executable = powershellExecutable()
      else if (kind === 'powershell') executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
      else if (kind === 'cmd') executable = process.env.ComSpec ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/cmd.exe')
      else executable = fromPath(executable.endsWith('.exe') ? executable : executable + '.exe') ?? executable
    }
  }
  const env = toolEnvironment()
  if (kind === 'pwsh' || kind === 'powershell') {
    // Script text is encoded independently of Windows argv quoting. stdin remains
    // available for the program invoked by the script (Codex write_stdin).
    const script = '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding;\n' + input.command
    return { executable, args: ['-NoLogo', '-NonInteractive', '-OutputFormat', 'Text', ...(input.login === true ? [] : ['-NoProfile']), '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], env }
  }
  // cmd parses its command tail itself instead of following Windows CRT argv rules.
  if (kind === 'cmd') return { executable, args: ['/d', '/s', '/c', `"${input.command}"`], env, windowsVerbatimArguments: true }
  if (!['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(kind)) throw new Error('Unsupported shell; choose Bash, PowerShell, cmd, or a POSIX shell')
  return { executable, args: [input.login === false ? '-c' : '-lc', input.command], env }
}

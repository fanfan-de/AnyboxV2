import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function developmentNodeExecutable(): string | undefined {
  // The source launcher supplies its own Node. A packaged Electron application
  // must use its bundled runtime even if it inherited a development variable.
  if (!process.versions.electron || /[\\/]app\.asar(?:[\\/]|$)/i.test(fileURLToPath(import.meta.url))) return undefined
  const executable = process.env.ANYBOX_DEVELOPMENT_NODE_EXECUTABLE
  if (executable === undefined) return undefined
  if (!isAbsolute(executable) || !existsSync(executable)) throw new Error('background-runtime-unavailable')
  return executable
}

function packagedRuntimeDirectory(): string | undefined {
  if (process.env.ANYBOX_RUNTIME_DIRECTORY) return resolve(process.env.ANYBOX_RUNTIME_DIRECTORY)
  if (developmentNodeExecutable()) return undefined
  if (process.versions.electron) {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    if (!resourcesPath) throw new Error('background-runtime-unavailable')
    return join(resourcesPath, 'runtime')
  }
  return undefined
}

/** A packaged Electron product uses its independent Node runtime, never RunAsNode. */
export function resolveBackgroundRuntime(): { readonly executable: string; readonly prefixArgs: readonly string[] } {
  const runtime = packagedRuntimeDirectory()
  const executable = runtime ? join(runtime, process.platform === 'win32' ? 'node.exe' : 'node') : developmentNodeExecutable() ?? process.execPath
  if (!existsSync(executable)) throw new Error('background-runtime-unavailable')
  return { executable, prefixArgs: [] }
}

export function resolveBackgroundEntrypoint(name: string): string {
  if (!/^[a-z][a-z0-9-]*\.js$/.test(name)) throw new Error('background-entrypoint-invalid')
  const runtime = packagedRuntimeDirectory()
  const entrypoint = runtime ? join(runtime, 'app', 'dist', 'entrypoints', name)
    : join(dirname(fileURLToPath(import.meta.url)), '..', 'entrypoints', name)
  if (!existsSync(entrypoint)) throw new Error('background-entrypoint-unavailable')
  return entrypoint
}

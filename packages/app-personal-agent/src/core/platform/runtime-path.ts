import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function configuredPath(name: string, directory: boolean): string | undefined {
  const value = process.env[name]
  if (value === undefined) return undefined
  if (!isAbsolute(value) || !existsSync(value) || (directory ? !statSync(value).isDirectory() : !statSync(value).isFile())) {
    throw new Error('background-runtime-unavailable')
  }
  return value
}

/** Optional tool runtimes belong to the Harness deployment, never another application's package. */
export function resolveRuntimeDirectory(): string | undefined {
  const configured = configuredPath('ANYBOX_RUNTIME_DIRECTORY', true)
  if (configured) return configured
  if (process.versions.electron) {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    const bundled = resourcesPath && join(resourcesPath, 'runtime')
    if (bundled && existsSync(bundled) && statSync(bundled).isDirectory()) return bundled
  }
  return undefined
}

/** An independent Computer uses Node; Electron's RunAsNode is not an independent runtime. */
export function resolveBackgroundRuntime(): { readonly executable: string; readonly prefixArgs: readonly string[] } {
  const runtime = resolveRuntimeDirectory()
  const executable = runtime ? join(runtime, process.platform === 'win32' ? 'node.exe' : 'node')
    : process.versions.electron ? configuredPath('ANYBOX_DEVELOPMENT_NODE_EXECUTABLE', false) : process.execPath
  if (!executable || !existsSync(executable) || !statSync(executable).isFile()) throw new Error('background-runtime-unavailable')
  return { executable, prefixArgs: [] }
}

/** The worker entry is always resolved inside this exact Harness application package. */
export function resolveBackgroundEntrypoint(name: string): string {
  if (!/^[a-z][a-z0-9-]*\.js$/.test(name)) throw new Error('background-entrypoint-invalid')
  const entrypoint = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'entrypoints', name)
  if (!existsSync(entrypoint) || !statSync(entrypoint).isFile()) throw new Error('background-entrypoint-unavailable')
  return entrypoint
}

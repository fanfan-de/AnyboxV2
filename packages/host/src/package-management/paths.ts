import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const physicalPath = (input: string) => {
  let current = resolve(input)
  const missing: string[] = []
  while (!existsSync(current)) {
    missing.unshift(basename(current))
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return join(realpathSync(current), ...missing)
}
/** Reject aliases before either connection is opened or any domain migration can run. */
export function packageRegistryDatabasePath(directory: string, controlDatabase?: string): string {
  if (typeof directory !== 'string' || !directory.trim() || directory.includes('\0')) throw new TypeError('package management directory required')
  const path = physicalPath(join(directory, 'registry.sqlite'))
  if (controlDatabase !== undefined) {
    const control = physicalPath(controlDatabase)
    const sameFile = existsSync(path) && existsSync(control) && (() => {
      const a = statSync(path), b = statSync(control)
      return a.dev === b.dev && a.ino === b.ino
    })()
    if (path === control || sameFile) throw new TypeError('package registry and application control databases must be different files')
  }
  return path
}

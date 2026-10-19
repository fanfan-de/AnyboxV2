import { lstat, symlink } from 'node:fs/promises'
import { lstatSync, symlinkSync } from 'node:fs'
import { dirname } from 'node:path'

// Junctions exercise the same reparse-point rejection without Windows symlink privilege.
export async function symbolicAlias(target, path) {
  if (process.platform !== 'win32') return symlink(target, path)
  let directory = target
  try { if (!(await lstat(target)).isDirectory()) directory = dirname(target) } catch { directory = dirname(target) }
  return symlink(directory, path, 'junction')
}
export function symbolicAliasSync(target, path) {
  if (process.platform !== 'win32') return symlinkSync(target, path)
  let directory = target
  try { if (!lstatSync(target).isDirectory()) directory = dirname(target) } catch { directory = dirname(target) }
  return symlinkSync(directory, path, 'junction')
}

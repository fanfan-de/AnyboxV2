import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { cliExit, cliFailure, isCliFailure } from '@anybox/application-api/cli'
import type { CliIo } from '@anybox/application-api/cli'

export interface HarnessCliTarget { readonly name: string; readonly endpoint: string; readonly token: string; readonly instanceId: string }
interface TargetConfig { readonly schemaVersion: 1; readonly selected: string | null; readonly targets: readonly HarnessCliTarget[] }
const empty: TargetConfig = { schemaVersion: 1, selected: null, targets: [] }
const fail = () => cliFailure('target-config', 'CLI target configuration is unavailable, insecure or invalid', cliExit.unavailable)
export const targetName = (value: string) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(value)
export function validateToken(value: string): string {
  const token = value.replace(/\r?\n$/, '')
  if (!/^[\x21-\x7e]{1,16384}$/.test(token)) throw cliFailure('token-input', 'Provide a nonempty token on a single line', cliExit.usage)
  return token
}
export function endpointOrigin(value: string): string {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error()
    // Remote tokens require TLS; explicit loopback HTTP supports local standalone servers.
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error()
    return url.origin
  } catch { throw cliFailure('invalid-endpoint', 'Use an HTTPS origin, or an HTTP loopback origin, without credentials, path, query or fragment', cliExit.usage) }
}
export function targetConfigPath(io: Pick<CliIo, 'env' | 'cwd'>): string {
  const custom = io.env.ANYBOX_HARNESS_CLI_CONFIG
  if (custom) return resolve(io.cwd, custom)
  const home = io.env.HOME ?? io.env.USERPROFILE ?? homedir()
  const base = process.platform === 'win32' ? io.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    : process.platform === 'darwin' ? join(home, 'Library', 'Application Support')
    : io.env.XDG_CONFIG_HOME && isAbsolute(io.env.XDG_CONFIG_HOME) ? io.env.XDG_CONFIG_HOME : join(home, '.config')
  return join(base, 'Anybox', 'harness-cli', 'targets.json')
}
function secure(stat: Stats, directory: boolean) {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
    process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) throw fail()
}
async function directory(path: string, create = false) {
  if (process.platform === 'win32') throw cliFailure('target-config-unsupported', 'Private CLI token storage requires a Windows ACL adapter; this platform is not yet supported', cliExit.unavailable)
  if (create) await mkdir(path, { recursive: true, mode: 0o700 })
  secure(await lstat(path), true)
}
function decode(value: unknown): TargetConfig {
  if (!value || typeof value !== 'object') throw fail()
  const config = value as TargetConfig
  if (config.schemaVersion !== 1 || !Array.isArray(config.targets) || config.targets.length > 1000 ||
    config.selected !== null && typeof config.selected !== 'string') throw fail()
  const names = new Set<string>()
  for (const target of config.targets) {
    if (!target || typeof target.name !== 'string' || !targetName(target.name) || names.has(target.name) ||
      typeof target.endpoint !== 'string' || endpointOrigin(target.endpoint) !== target.endpoint || typeof target.token !== 'string' ||
      validateToken(target.token) !== target.token || typeof target.instanceId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(target.instanceId)) throw fail()
    names.add(target.name)
  }
  if (config.selected !== null && !names.has(config.selected)) throw fail()
  return config
}
export async function readTargets(path: string): Promise<TargetConfig> {
  try {
    await directory(dirname(path))
    secure(await lstat(path), false)
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = await handle.stat(); secure(stat, false)
      if (stat.size > 2 * 1024 * 1024) throw fail()
      return decode(JSON.parse(await handle.readFile('utf8')))
    } finally { await handle.close() }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return empty
    if (isCliFailure(error) && error.code === 'target-config-unsupported') throw error
    throw fail()
  }
}
export async function updateTargets(path: string, update: (config: TargetConfig) => TargetConfig): Promise<TargetConfig> {
  let lock: Awaited<ReturnType<typeof open>> | undefined
  let temporary: string | undefined
  try {
    await directory(dirname(path), true)
    try { lock = await open(path + '.lock', 'wx', 0o600) }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') throw cliFailure('target-config-busy', 'CLI target configuration is locked; confirm the previous writer has exited before removing its lock', cliExit.conflict)
      throw error
    }
    const next = decode(update(await readTargets(path)))
    const serialized = JSON.stringify(next) + '\n'
    if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) throw cliFailure('target-config-limit', 'CLI target configuration exceeds its size limit', cliExit.usage)
    temporary = join(dirname(path), `.targets-${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(serialized); await handle.sync() } finally { await handle.close() }
    await rename(temporary, path); temporary = undefined
    if (process.platform !== 'win32') { const parent = await open(dirname(path), 'r'); try { await parent.sync() } finally { await parent.close() } }
    return next
  } catch (error) { throw isCliFailure(error) ? error : fail() }
  finally {
    if (temporary) await unlink(temporary).catch(() => {})
    if (lock) { await lock.close(); await unlink(path + '.lock') }
  }
}
export function selectTarget(config: TargetConfig, name?: string): HarnessCliTarget {
  const target = config.targets.find(target => target.name === (name ?? config.selected))
  if (!target) throw cliFailure('target-not-found', 'Configure or select a CLI target first', cliExit.notFound)
  return target
}
export function publicTarget(target: HarnessCliTarget) { return { name: target.name, endpoint: target.endpoint, instanceId: target.instanceId } }

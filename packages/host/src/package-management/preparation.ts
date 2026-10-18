import { spawn, type ChildProcess } from 'node:child_process'
import { lstat, realpath, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ApplicationCapabilityRequirements, ProductDefinition } from '@anybox/application-api'
import type { ApplicationRegistration, ApplicationAsset } from '@anybox/application-api/node'
import type { PackageIdentity } from './port.js'
import { assertVerifiedApplicationArchive, type VerifiedApplicationArchive } from './archive.js'
import { assertPreparedCatalog, freezePreparation, preparationFailure, verifyPackageWebResources, type PackageAliasPolicies, type PreparedAsset, type PreparedWebDeclaration } from './preparation-static.js'

export interface PreparedRegistration {
  readonly definition: ProductDefinition
  readonly capabilityRequirements?: ApplicationCapabilityRequirements
  readonly hasRuntime: boolean
  readonly hasChannel?: boolean
  readonly http?: ApplicationRegistration['http']
  readonly assets: readonly PreparedAsset[]
}
export interface PreparedRole {
  readonly status: 'prepared' | 'compatible' | 'unsupported' | 'unselected'
  readonly reasons: readonly string[]
  readonly registration?: PreparedRegistration
}
export interface PreparedApplicationArchive {
  readonly identity: PackageIdentity
  readonly web?: PreparedWebDeclaration
  readonly roles: Readonly<Partial<Record<'client' | 'execution' | 'computerWorker' | 'web', PreparedRole>>>
}
export interface ApplicationPreparationOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly roles?: readonly ('client' | 'execution')[]
  /** Explicit host trust policy for existing first-party asset and route aliases. */
  readonly trustedAliases?: PackageAliasPolicies
  readonly existingApplications?: readonly ApplicationRegistration[]
  readonly commonAssets?: readonly ApplicationAsset[]
  /** Trusted installer reservation; the secret travels to the child only over IPC. */
  readonly temporaryRoot?: string
  readonly lifetime?: { readonly directory: string; readonly usageId: string; readonly secret: string }
}
const fail = (code: string): never => { throw preparationFailure(code) }
const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) fail('package-preparation-cancelled') }
const runtimeAvailable = () => {
  const [major, minor] = process.versions.node.split('.').map(Number)
  return !process.versions.electron && (major > 22 || major === 22 && minor >= 15) && process.platform !== 'win32'
}
const comparable = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(comparable).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ':' + comparable(item)).join(',') + '}'
  return JSON.stringify(value)
}
const prefixContains = (prefix: string, value: string) => value === prefix.replace(/\/$/, '') || value.startsWith(prefix.replace(/\/$/, '') + '/')
function registrationForCatalog(registration: PreparedRegistration): ApplicationRegistration {
  return { definition: registration.definition, ...(registration.capabilityRequirements ? { capabilityRequirements: registration.capabilityRequirements } : {}),
    ...(registration.hasRuntime ? { createRuntime: () => { throw preparationFailure('package-preparation-runtime-forbidden') } } : {}),
    ...(registration.hasChannel ? { channel: { handle() { throw preparationFailure('package-preparation-runtime-forbidden') } } } : {}),
    ...(registration.http ? { http: registration.http } : {}), assets: registration.assets }
}
function checkRegistration(archive: VerifiedApplicationArchive, role: 'client' | 'execution', registration: PreparedRegistration, web: PreparedWebDeclaration | undefined, options: ApplicationPreparationOptions) {
  if (!registration || typeof registration !== 'object' || registration.definition?.id !== archive.manifest.appId || registration.definition?.name !== archive.manifest.displayName || typeof registration.hasRuntime !== 'boolean') fail('package-registration-metadata-mismatch')
  if (registration.hasChannel !== undefined && typeof registration.hasChannel !== 'boolean') fail('package-registration-metadata-mismatch')
  if (comparable(registration.capabilityRequirements ?? {}) !== comparable(archive.manifest.capabilityRequirements?.[role] ?? {})) fail('package-registration-capability-mismatch')
  const expected = role === 'client' ? web?.assets ?? [] : []
  if (comparable([...registration.assets].sort((a, b) => a.path < b.path ? -1 : 1)) !== comparable([...expected].sort((a, b) => a.path < b.path ? -1 : 1))) fail('package-registration-assets-mismatch')
  if (registration.definition.web) {
    if (role !== 'client' || !web || registration.definition.web.entry !== web.entry || comparable(registration.definition.web.styles ?? []) !== comparable(web.styles)) fail('package-registration-web-mismatch')
    const permitted = options.trustedAliases?.[archive.manifest.appId]?.webLegacyRoutes ?? []
    if ((registration.definition.web.legacyRoutes ?? []).some(route => !permitted.includes(route))) fail('package-registration-route-not-owned')
  } else if (role === 'client' && web) fail('package-registration-web-mismatch')
  const permittedRoutes = options.trustedAliases?.[archive.manifest.appId]?.routePrefixes ?? []
  if ((registration.http?.legacyRoutes ?? []).some(route => !permittedRoutes.some(prefix => prefixContains(prefix, route.prefix)))) fail('package-registration-route-not-owned')
  assertPreparedCatalog([...(options.existingApplications ?? []), registrationForCatalog(registration)], options.commonAssets)
}

function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    // macOS can deny a probe while an exited descendant awaits reaping. Denied
    // observation proves no exit, so retain the group and retry actual absence.
    if (code === 'EPERM') return true
    throw error
  }
}
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  try { process.kill(-child.pid, signal) } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // A denied signal leaves cleanup pending; only a later ESRCH probe proves exit.
    if (code !== 'ESRCH' && code !== 'EPERM') throw error
  }
}
async function joinGroup(child: ChildProcess): Promise<void> {
  if (!child.pid) return
  try {
    if (!groupExists(child.pid)) return
    signalGroup(child, 'SIGTERM')
    const start = Date.now()
    while (groupExists(child.pid)) {
      if (Date.now() - start >= 150) signalGroup(child, 'SIGKILL')
      if (Date.now() - start > 5_000) throw preparationFailure('package-preparation-cleanup-unconfirmed')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  } catch (cause) {
    // Every failed observation leaves actual exit uncertain, including the first
    // probe. Preserve temporary bytes for explicit recovery on every such path.
    throw Object.assign(preparationFailure('package-preparation-cleanup-unconfirmed'), { cleanupUnconfirmed: true, cause })
  }
}
function preparationGuard(child: ChildProcess, lifetime: NonNullable<ApplicationPreparationOptions['lifetime']>) {
  const guard = spawn(process.execPath, [fileURLToPath(new URL('./preparation-guard.js', import.meta.url))], {
    detached: true, env: { PATH: dirname(process.execPath), LANG: 'C' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  let readySettled = false
  let readyResolve!: () => void, readyReject!: (error: Error) => void
  const ready = new Promise<void>((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady })
  const failure = () => preparationFailure('package-preparation-lifetime-unavailable')
  const exited = new Promise<number | null>(resolveExit => {
    guard.once('error', () => { if (!readySettled) { readySettled = true; readyReject(failure()) } resolveExit(null) })
    guard.once('exit', code => { if (!readySettled) { readySettled = true; readyReject(failure()) } resolveExit(code) })
  })
  guard.on('message', message => {
    if (!readySettled && message && typeof message === 'object' && 'type' in message) {
      readySettled = true
      if (message.type === 'ready') readyResolve()
      else readyReject(failure())
    }
  })
  guard.send({ type: 'start', pid: child.pid, ...lifetime }, error => {
    if (error && !readySettled) { readySettled = true; readyReject(failure()) }
  })
  // Observe immediately even when the preparation child fails before its handshake.
  void ready.catch(() => {})
  return { ready, async close() {
    if (guard.connected) guard.send({ type: 'stop' }, () => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const code = await Promise.race([exited, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(preparationFailure('package-preparation-cleanup-unconfirmed'), { cleanupUnconfirmed: true })), 5_000)
      })])
      if (code !== 0) throw Object.assign(failure(), { cleanupUnconfirmed: true })
    } finally { if (timer) clearTimeout(timer) }
  } }
}
async function runPreparationChild(work: string, requestFile: string, timeoutMs: number, signal?: AbortSignal, lifetime?: ApplicationPreparationOptions['lifetime']): Promise<PreparedRegistration> {
  checkAbort(signal)
  const child = spawn(process.execPath, [fileURLToPath(new URL('./preparation-child.js', import.meta.url)), requestFile], {
    cwd: work, detached: true, env: { PATH: dirname(process.execPath), TMPDIR: work, LANG: 'C' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const guard = lifetime ? preparationGuard(child, lifetime) : undefined
  let result: unknown, failure: Error | undefined, outputBytes = 0
  let force: ReturnType<typeof setTimeout> | undefined
  const stop = (reason: Error) => {
    failure ??= reason
    try { signalGroup(child, 'SIGTERM') } catch (error) { failure = error as Error }
    force ??= setTimeout(() => { try { signalGroup(child, 'SIGKILL') } catch (error) { failure = error as Error } }, 150)
  }
  const abort = () => stop(preparationFailure('package-preparation-cancelled'))
  signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => stop(preparationFailure('package-preparation-timeout')), timeoutMs)
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes > 1_048_576) stop(preparationFailure('package-preparation-output-limit')) })
  let credentialSent = false
  child.on('message', message => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'preparation-lifetime-ready') {
      if (!lifetime || credentialSent || result !== undefined) { stop(preparationFailure('package-preparation-result-invalid')); return }
      credentialSent = true
      void guard!.ready.then(() => {
        if (!child.connected) return
        child.send({ type: 'preparation-lifetime', secret: lifetime.secret }, error => { if (error) stop(preparationFailure('package-preparation-lifetime-unavailable')) })
      }).catch(() => stop(preparationFailure('package-preparation-lifetime-unavailable')))
      return
    }
    if (result !== undefined || Buffer.byteLength(JSON.stringify(message)) > 1_048_576) stop(preparationFailure('package-preparation-result-invalid'))
    else result = message
  })
  let exitCode: number | null
  try {
    exitCode = await new Promise<number | null>(resolveExit => {
      child.once('error', error => { failure ??= error; resolveExit(null) })
      child.once('exit', code => resolveExit(code))
    })
  } finally {
    clearTimeout(timeout); if (force) clearTimeout(force)
    signal?.removeEventListener('abort', abort)
    // Manager success never leaves preparation-spawned descendants using the temporary payload.
    try { await joinGroup(child) } finally { await guard?.close() }
    if (child.connected) child.disconnect()
    child.stdout?.destroy(); child.stderr?.destroy()
  }
  if (failure) throw failure
  if (!result || typeof result !== 'object') fail('package-preparation-result-invalid')
  const response = result as { ok: boolean; code?: string; registration?: PreparedRegistration }
  if (!response.ok || exitCode !== 0 || !response.registration) fail(response.code ?? 'package-registration-invalid')
  return response.registration!
}

/** D1.2 verification only: no installation facts, immutable directories or business initialization are changed. */
export async function prepareApplicationArchive(archive: VerifiedApplicationArchive, options: ApplicationPreparationOptions = {}): Promise<PreparedApplicationArchive> {
  assertVerifiedApplicationArchive(archive)
  options = { ...options, ...(options.roles ? { roles: [...options.roles] } : {}), ...(options.lifetime ? { lifetime: Object.freeze({ ...options.lifetime }) } : {}), ...(options.trustedAliases ? { trustedAliases: freezePreparation(structuredClone(options.trustedAliases)) } : {}) }
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 120_000) fail('package-preparation-timeout-invalid')
  checkAbort(options.signal)
  const web = verifyPackageWebResources(archive, options.trustedAliases)
  const roles: Partial<Record<'client' | 'execution' | 'computerWorker' | 'web', PreparedRole>> = {}
  const chosen = options.roles ? new Set(options.roles) : new Set(['client', 'execution'])
  if ([...chosen].some(role => role !== 'client' && role !== 'execution')) fail('package-preparation-role-invalid')
  if (web) {
    const declaration: ApplicationRegistration = { definition: { id: archive.manifest.appId, name: archive.manifest.displayName, icon: archive.manifest.appId, web: { entry: web.entry, styles: web.styles } }, assets: web.assets, capabilityRequirements: archive.manifest.capabilityRequirements?.web }
    assertPreparedCatalog([...(options.existingApplications ?? []), declaration], options.commonAssets)
    roles.web = { status: 'prepared', reasons: [] }
  }
  const selected: ('client' | 'execution')[] = []
  for (const role of ['client', 'execution', 'computerWorker'] as const) {
    if (!archive.manifest.entries?.[role]) continue
    const compatibility = archive.roleCompatibility[role]
    if (!compatibility?.compatible) { roles[role] = { status: 'unsupported', reasons: compatibility?.reasons ?? ['runtime-profile-unavailable'] }; continue }
    if (role === 'computerWorker') { roles[role] = { status: 'compatible', reasons: [] }; continue }
    if (!chosen.has(role)) { roles[role] = { status: 'unselected', reasons: [] }; continue }
    if (!runtimeAvailable()) { roles[role] = { status: 'unsupported', reasons: ['preparation-node-runtime-unavailable'] }; continue }
    selected.push(role)
  }
  if (!selected.length) return freezePreparation({ identity: archive.identity, ...(web ? { web } : {}), roles })
  let temporaryParent = tmpdir()
  if (options.temporaryRoot !== undefined) {
    if (typeof options.temporaryRoot !== 'string' || !options.temporaryRoot.trim() || options.temporaryRoot.includes('\0')) fail('package-preparation-temporary-root-invalid')
    const requested = resolve(options.temporaryRoot), info = await lstat(requested)
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(requested) !== requested) fail('package-preparation-temporary-root-invalid')
    temporaryParent = requested
  }
  const temporary = await mkdtemp(join(temporaryParent, 'anybox-package-prepare-'))
  const directory = join(temporary, 'application'), work = join(temporary, 'work')
  let cleanupUnconfirmed = false
  try {
    await mkdir(directory, { mode: 0o700 }); await mkdir(work, { mode: 0o700 })
    for (const file of archive.files) {
      checkAbort(options.signal)
      const path = resolve(directory, file.path)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(path, archive.readFile(file.path), { flag: 'wx', mode: file.mode })
    }
    // Only host-owned control metadata is written; no manifest scripts are executed.
    const requestFile = join(temporary, 'request.json')
    for (const role of selected) {
      checkAbort(options.signal)
      await writeFile(requestFile, JSON.stringify({ directory, role, appId: archive.manifest.appId, entry: archive.manifest.entries![role], files: archive.files,
        ...(options.lifetime ? { lifetime: { directory: options.lifetime.directory, usageId: options.lifetime.usageId } } : {}) }))
      const registration = await runPreparationChild(work, requestFile, timeoutMs, options.signal, options.lifetime)
      checkRegistration(archive, role, registration, web, options)
      roles[role] = { status: 'prepared', reasons: [], registration }
    }
    return freezePreparation({ identity: archive.identity, ...(web ? { web } : {}), roles })
  } catch (error) {
    cleanupUnconfirmed = !!(error && typeof error === 'object' && 'cleanupUnconfirmed' in error && error.cleanupUnconfirmed)
    if (cleanupUnconfirmed && error && typeof error === 'object') Object.assign(error, { temporaryDirectory: temporary })
    throw error
  } finally {
    // Unknown process exit retains bytes for diagnosis; never report a successful temporary cleanup.
    if (!cleanupUnconfirmed) await rm(temporary, { recursive: true, force: true })
  }
}

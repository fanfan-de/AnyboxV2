/** Online lifecycle CLI. It never opens a registry, Context, application or business API. */
export interface PackageActivationCommandIo {
  readonly fetch?: typeof globalThis.fetch
  readonly stdout?: (text: string) => void
  readonly stderr?: (text: string) => void
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  readonly timeoutMs?: number
  readonly pollIntervalMs?: number
}
type Phase = 'prepared' | 'handoff' | 'loading' | 'reclaiming' | 'completed' | 'recovery-required' | 'cancelled'
interface ActivationView { readonly id: string; readonly requestId: string; readonly kind: 'activate' | 'remove'; readonly phase: Phase; readonly [key: string]: unknown }
const phases = ['prepared', 'handoff', 'loading', 'reclaiming', 'completed', 'recovery-required', 'cancelled']
const base = '/api/client/v1/app-packages'
const usage = 'Usage: anybox-host apply --endpoint http://127.0.0.1:<port> --request-id <id> [--app <id> ...] | uninstall <appId> --endpoint <origin> --request-id <id> | activation <id> --endpoint <origin> [--action inspect|resume|cancel]'
const error = (code: string) => Object.assign(new Error(code), { code })
function identifier(value: unknown): string { if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) throw error('invalid-input'); return value }
function appIdentifier(value: unknown): string { const id = identifier(value); if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) throw error('invalid-input'); return id }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('invalid-response'); return value as Record<string, unknown> }
function integer(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw error('invalid-response'); return value }
function text(value: unknown): string { if (typeof value !== 'string' || value.length > 2048) throw error('invalid-response'); return value }
function identity(value: unknown) { const item = object(value), target = object(item.target); return { appId: text(item.appId), version: text(item.version), digest: text(item.digest), target: { os: text(target.os), arch: text(target.arch) } } }
function activation(value: unknown): ActivationView {
  const item = object(value)
  const kind = item.kind ?? 'activate'
  if (kind !== 'activate' && kind !== 'remove') throw error('invalid-response')
  if (!phases.includes(item.phase as string) || !Array.isArray(item.targets) || item.targets.length > 10_000 || !Array.isArray(item.roles) || item.roles.length > 4) throw error('invalid-response')
  const failure = item.error === null || item.error === undefined ? null : object(item.error), recovery = item.recovery === null || item.recovery === undefined ? null : object(item.recovery)
  if (failure && (typeof failure.code !== 'string' || !/^[a-z][a-z0-9-]{0,79}$/.test(failure.code))) throw error('invalid-response')
  if (recovery && (!phases.includes(recovery.from as string) || !['owner-restarted', 'outcome-unconfirmed'].includes(recovery.reason as string))) throw error('invalid-response')
  return { id: identifier(item.id), requestId: identifier(item.requestId), kind, phase: item.phase as Phase, revision: integer(item.revision), registryRevision: integer(item.registryRevision),
    targets: item.targets.map(value => { const target = object(value); return { identity: identity(target.identity), previousSelected: target.previousSelected === null ? null : identity(target.previousSelected) } }),
    roles: item.roles.map(value => { const role = object(value); if (!['client', 'execution', 'computer-worker', 'web'].includes(role.role as string) || typeof role.ready !== 'boolean') throw error('invalid-response'); return { role: role.role, ready: role.ready } }),
    error: failure ? { code: failure.code } : null, recovery: recovery ? { from: recovery.from, reason: recovery.reason } : null, createdAt: text(item.createdAt), updatedAt: text(item.updatedAt) }
}
function parse(args: readonly string[]) {
  const command = args[0]
  if (command !== 'apply' && command !== 'activation' && command !== 'uninstall') throw error('invalid-input')
  const id = command === 'activation' ? identifier(args[1]) : undefined, appId = command === 'uninstall' ? appIdentifier(args[1]) : undefined, options: Record<string, string> = {}, appIds: string[] = []
  for (let index = command === 'apply' ? 1 : 2; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1]
    if (!name || !value || value.startsWith('--') || !['--endpoint', '--request-id', '--app', '--action'].includes(name)) throw error('invalid-input')
    if (name === '--app') appIds.push(appIdentifier(value))
    else { if (options[name] !== undefined) throw error('invalid-input'); options[name] = value }
  }
  if (!options['--endpoint'] || new Set(appIds).size !== appIds.length || appIds.length > 256) throw error('invalid-input')
  let endpoint: URL
  try { endpoint = new URL(options['--endpoint']) } catch { throw error('invalid-endpoint') }
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || !endpoint.port || Number(endpoint.port) < 1) throw error('invalid-endpoint')
  if (command !== 'activation' && (!options['--request-id'] || options['--action']) || command === 'activation' && (options['--request-id'] || appIds.length) || command === 'uninstall' && appIds.length) throw error('invalid-input')
  const action = options['--action'] ?? 'inspect'
  if (!['inspect', 'resume', 'cancel'].includes(action)) throw error('invalid-input')
  return { command, id, endpoint: endpoint.origin, requestId: command !== 'activation' ? identifier(options['--request-id']) : undefined, appIds: appId ? [appId] : appIds, action }
}
function safeCode(value: unknown): string { return value && typeof value === 'object' && 'code' in value && typeof value.code === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(value.code) ? value.code : 'activation-command-failed' }

export async function runPackageActivationCommand(args: readonly string[], io: PackageActivationCommandIo = {}): Promise<number> {
  const output = io.stdout ?? (value => { process.stdout.write(value) }), report = io.stderr ?? (value => { process.stderr.write(value) }), fetcher = io.fetch ?? globalThis.fetch, now = io.now ?? Date.now, sleep = io.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const timeoutMs = io.timeoutMs ?? 120_000, interval = io.pollIntervalMs ?? 300
  const controller = new AbortController(), abort = () => controller.abort()
  process.once('SIGINT', abort); process.once('SIGTERM', abort)
  let last: ActivationView | undefined
  try {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 || !Number.isFinite(interval) || interval < 1 || interval > 5_000) throw error('invalid-input')
    const input = parse([...args]), deadline = now() + timeoutMs
    const remaining = () => { if (controller.signal.aborted) throw error('activation-observation-cancelled'); const value = deadline - now(); if (value <= 0) throw error('activation-observation-timeout'); return value }
    const request = async (path: string, body?: unknown): Promise<unknown> => {
      const requestTimeout = Math.min(remaining(), 5_000), requestController = new AbortController(), forward = () => requestController.abort()
      controller.signal.addEventListener('abort', forward, { once: true })
      const timer = setTimeout(() => requestController.abort(), requestTimeout)
      try {
        let response: Response
        try { response = await fetcher(input.endpoint + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', headers: { Origin: input.endpoint, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: requestController.signal }) }
        catch { remaining(); throw error('activation-observation-failed') }
        let value: unknown
        try { value = await response.json() } catch { throw error(response.ok ? 'invalid-response' : `http-${response.status}`) }
        if (!response.ok) { const failure = value && typeof value === 'object' && 'error' in value ? (value as { error?: unknown }).error : undefined; throw error(failure && typeof failure === 'object' && 'code' in failure && typeof failure.code === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(failure.code) ? failure.code : `http-${response.status}`) }
        return value
      } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', forward) }
    }
    const inspect = async (id: string) => { const value = activation(await request(`${base}/activations/${encodeURIComponent(id)}`)); if (value.id !== id) throw error('invalid-response'); last = value; return value }
    const transient = (failure: unknown) => ['activation-observation-failed', 'role-unavailable', 'service-unavailable', 'service-closing', 'package-lifecycle-manager-unavailable', 'http-502', 'http-503', 'http-504'].includes(safeCode(failure))
    const matching = (status: Record<string, unknown>, requestId: string) => {
      if (!Array.isArray(status.activations)) throw error('invalid-response')
      const matches = status.activations.map(activation).filter(value => value.requestId === requestId)
      if (matches.length > 1) throw error('invalid-response')
      return matches[0]
    }
    const readUntil = async (id: string): Promise<ActivationView> => {
      for (;;) { try { return await inspect(id) } catch (failure) { if (!transient(failure)) throw failure; await sleep(Math.min(interval, remaining())) } }
    }
    const findAccepted = async (requestId: string): Promise<ActivationView> => {
      const acceptedRemaining = () => { try { return remaining() } catch (failure) { if (safeCode(failure) === 'activation-observation-timeout') throw error('activation-acceptance-unconfirmed'); throw failure } }
      for (;;) {
        acceptedRemaining()
        try {
          const status = object(await request(`${base}?requestId=${encodeURIComponent(requestId)}`))
          const found = matching(status, requestId)
          if (found) return found
        } catch (failure) {
          if (safeCode(failure) === 'activation-observation-timeout') throw error('activation-acceptance-unconfirmed')
          if (!transient(failure)) throw failure
        }
        await sleep(Math.min(interval, acceptedRemaining()))
      }
    }
    const poll = async (id: string): Promise<ActivationView> => {
      for (;;) {
        remaining()
        try { const value = await inspect(id); if (['completed', 'recovery-required', 'cancelled'].includes(value.phase)) return value }
        catch (failure) { if (!transient(failure)) throw failure }
        await sleep(Math.min(interval, remaining()))
      }
    }
    const ambiguous = (failure: unknown) => ['activation-observation-failed', 'invalid-response'].includes(safeCode(failure))
    const once = async (id: string, action: 'commit' | 'resume' | 'cancel') => {
      try { const value = activation(await request(`${base}/activations/${encodeURIComponent(id)}/${action}`, {})); if (value.id !== id) throw error('invalid-response'); last = value; return value }
      catch (failure) { if (!ambiguous(failure)) throw failure; return readUntil(id) }
    }
    let result: ActivationView
    if (input.command === 'apply' || input.command === 'uninstall') {
      const status = object(await request(`${base}?requestId=${encodeURIComponent(input.requestId!)}`)), registryRevision = integer(status.registryRevision)
      const prior = matching(status, input.requestId!)
      if (prior) last = prior
      else {
        try { last = activation(await request(`${base}/activations`, { requestId: input.requestId, expectedRegistryRevision: registryRevision, ...(input.command === 'uninstall' ? { kind: 'remove' } : {}), ...(input.appIds.length ? { appIds: input.appIds } : {}) })) }
        catch (failure) {
          if (!ambiguous(failure)) throw failure
          // Preparation may still be validating files before its durable request ID appears.
          last = await findAccepted(input.requestId!)
        }
      }
      if (last.requestId !== input.requestId || last.kind !== (input.command === 'uninstall' ? 'remove' : 'activate')) throw error(prior ? 'request-conflict' : 'invalid-response')
      const targetIds = [...new Set((last.targets as readonly { identity: { appId: string } }[]).map(target => target.identity.appId))].sort()
      if (prior && input.appIds.length && JSON.stringify([...input.appIds].sort()) !== JSON.stringify(targetIds)) throw error('request-conflict')
      // A separate CLI invocation observes an existing batch. A durable prepared
      // record alone cannot prove that this invocation owns its live protection.
      result = !prior && last.phase === 'prepared' ? await once(last.id, 'commit') : last
      if (!['completed', 'recovery-required', 'cancelled'].includes(result.phase) && !(prior && result.phase === 'prepared')) result = await poll(result.id)
    } else if (input.action === 'inspect') result = await inspect(input.id!)
    else if (input.action === 'cancel') { result = await once(input.id!, 'cancel'); if (!['completed', 'recovery-required', 'cancelled'].includes(result.phase)) result = await poll(input.id!) }
    else {
      result = await once(input.id!, 'resume')
      if (result.phase !== 'completed' && result.phase !== 'cancelled') result = await once(input.id!, 'commit')
      if (!['completed', 'recovery-required', 'cancelled'].includes(result.phase)) result = await poll(input.id!)
    }
    output(JSON.stringify(result) + '\n')
    return input.command === 'activation' && input.action === 'inspect' || result.phase === 'completed' || input.action === 'cancel' && result.phase === 'cancelled' ? 0 : 1
  } catch (failure) {
    if (last) output(JSON.stringify(last) + '\n')
    const code = controller.signal.aborted ? 'activation-observation-cancelled' : safeCode(failure)
    report(JSON.stringify({ error: { code, ...(code === 'invalid-input' ? { message: usage } : {}) } }) + '\n')
    return controller.signal.aborted ? 130 : 1
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort) }
}

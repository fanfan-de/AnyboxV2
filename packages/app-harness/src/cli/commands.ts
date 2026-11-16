import { setTimeout as delay } from 'node:timers/promises'
import { cliExit, cliFailure, isCliObject } from '@anybox/application-api/cli'
import type { CliContext, CliInvocation, CliJson, CliExitCode } from '@anybox/application-api/cli'
import { endpointOrigin, publicTarget, readTargets, selectTarget, targetConfigPath, targetName, updateTargets, validateToken } from './config.js'
import type { HarnessCliTarget } from './config.js'
import { applicationBase, createHarnessCliHttp, redactCliData, segment } from './http.js'

const option = (invocation: CliInvocation, name: string) => typeof invocation.options[name] === 'string' ? invocation.options[name] as string : undefined
const redactTargets = (data: CliJson, targets: readonly HarnessCliTarget[]) => targets.reduce((safe, target) => redactCliData(safe, target.token), data)
async function readInput(context: CliContext, maximum: number): Promise<string> {
  // Drive the iterator with an abortable race; the Node stream is paused again on exit.
  const iterator = context.stdin[Symbol.asyncIterator]()
  const chunks: Buffer[] = []; let length = 0
  let onAbort!: () => void
  const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(cliFailure('cancelled', 'Input cancelled', cliExit.cancelled)) })
  context.signal.addEventListener('abort', onAbort, { once: true })
  try {
    context.signal.throwIfAborted()
    for (;;) {
      const next = await Promise.race([iterator.next(), aborted])
      if (next.done) break
      const chunk = Buffer.from(next.value); length += chunk.byteLength
      if (length > maximum) throw cliFailure('input-too-large', 'Standard input exceeds the CLI limit', cliExit.usage)
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    context.signal.removeEventListener('abort', onAbort)
    // Closing an interrupted input must unblock its outstanding read before returning.
    const stream = context.stdin as AsyncIterable<Uint8Array | string> & { destroy?: () => void }
    if (context.signal.aborted || length > maximum) stream.destroy?.()
    if (context.signal.aborted || length > maximum) await iterator.return?.().catch(() => {})
    else await iterator.return?.()
  }
}
async function targets(invocation: CliInvocation, context: CliContext): Promise<void> {
  const action = invocation.path[2], path = targetConfigPath(context), name = invocation.arguments[0]
  const explicit = option(invocation, 'target')
  if (explicit && action !== 'check') throw cliFailure('invalid-arguments', '--target is only applicable to target check and business commands', cliExit.usage)
  if (action === 'list') {
    const config = await readTargets(path)
    await context.emit(redactTargets({ selected: config.selected, targets: config.targets.map(publicTarget) }, config.targets)); return
  }
  if (action === 'check') {
    if (name && explicit) throw cliFailure('invalid-arguments', 'Choose a positional target name or --target', cliExit.usage)
    const target = selectTarget(await readTargets(path), name ?? explicit)
    await createHarnessCliHttp(target, context.signal).check()
    await context.emit(redactCliData({ ...publicTarget(target), ok: true }, target.token)); return
  }
  if (!name || !targetName(name)) throw cliFailure('invalid-target-name', 'Use a target name containing letters, digits, dots, underscores or hyphens (maximum 64 characters)', cliExit.usage)
  if (action === 'add') {
    const endpoint = endpointOrigin(option(invocation, 'endpoint')!)
    if ((await readTargets(path)).targets.some(target => target.name === name)) throw cliFailure('target-exists', 'Target already exists; remove it explicitly before replacing it', cliExit.conflict)
    const token = validateToken(invocation.options['token-stdin'] ? await readInput(context, 16386)
      : context.readSecret ? await context.readSecret('Access token (hidden): ')
      : (() => { throw cliFailure('token-input-required', 'Use --token-stdin, or run in a terminal with hidden token input', cliExit.usage) })())
    const provisional: HarnessCliTarget = { name, endpoint, token, instanceId: '' }
    const instanceId = await createHarnessCliHttp(provisional, context.signal).check()
    context.signal.throwIfAborted()
    const target = { ...provisional, instanceId }
    await updateTargets(path, config => {
      if (config.targets.some(target => target.name === name)) throw cliFailure('target-exists', 'Target already exists', cliExit.conflict)
      return { ...config, targets: [...config.targets, target], selected: config.selected ?? name }
    })
    await context.emit(redactCliData(publicTarget(target), target.token)); return
  }
  const previous = await readTargets(path)
  const config = await updateTargets(path, config => {
    selectTarget(config, name)
    return action === 'use' ? { ...config, selected: name }
      : { ...config, selected: config.selected === name ? null : config.selected, targets: config.targets.filter(target => target.name !== name) }
  })
  await context.emit(redactTargets({ selected: config.selected, targets: config.targets.map(publicTarget) }, [...previous.targets, ...config.targets]))
}
type Http = ReturnType<typeof createHarnessCliHttp>
type Run = { readonly id: string; readonly sessionId: string; readonly status: string; readonly revision: number; readonly [key: string]: CliJson }
function runValue(value: CliJson): Run {
  if (!isCliObject(value) || typeof value.id !== 'string' || typeof value.sessionId !== 'string' ||
    !['running', 'cancelling', 'completed', 'cancelled', 'failed', 'interrupted'].includes(value.status as string) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) throw cliFailure('invalid-response', 'Server returned an invalid run snapshot', cliExit.unavailable)
  return value as Run
}
const terminal = (run: Run) => !['running', 'cancelling'].includes(run.status)

/** SSE frames are hints only. Query immediately, after each hint/EOF, and periodically. */
async function watch(http: Http, initial: Run, context: CliContext): Promise<CliExitCode> {
  let current = initial, last = '', wake: (() => void) | undefined, pendingHint = false
  const lifetime = new AbortController(), signal = AbortSignal.any([context.signal, lifetime.signal])
  const hint = () => { pendingHint = true; wake?.() }
  const hints = (async () => {
    while (!signal.aborted && !terminal(current)) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      try {
        // A bounded subscription is renewed even if a peer silently stops sending hints.
        const response = await http.open(`${applicationBase}/changes?sessionId=${segment(initial.sessionId)}`, undefined, AbortSignal.any([signal, AbortSignal.timeout(10000)]))
        if (!response.headers.get('content-type')?.startsWith('text/event-stream')) { await response.body?.cancel(); break }
        reader = response.body?.getReader()
        if (!reader) break
        hint() // Reconcile on every initial connection/reconnection.
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          // No event contents or replay cursors are consumed. Bounded query cadence coalesces hints.
          hint()
        }
      } catch { /* Snapshot queries below surface authentication, availability and identity failures. */ }
      finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); hint() }
      if (!signal.aborted) await delay(500, undefined, { signal }).catch(() => {})
    }
  })()
  try {
    for (;;) {
      context.signal.throwIfAborted()
      const encoded = JSON.stringify(current)
      if (encoded !== last) { await context.emit(current, undefined, 'snapshot'); last = encoded }
      if (terminal(current)) return current.status === 'completed' ? cliExit.ok : cliExit.runFailed
      let timer: ReturnType<typeof setTimeout> | undefined
      const wait = new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, 1000) })
      if (pendingHint) { pendingHint = false; wake?.() }
      const onAbort = () => wake?.()
      context.signal.addEventListener('abort', onAbort, { once: true })
      try { if (!context.signal.aborted) await wait }
      finally { clearTimeout(timer); context.signal.removeEventListener('abort', onAbort); wake = undefined }
      context.signal.throwIfAborted()
      current = runValue(await http.request(`${applicationBase}/runs/${segment(initial.id)}`))
      if (current.id !== initial.id || current.sessionId !== initial.sessionId) throw cliFailure('invalid-response', 'Server returned a different run identity', cliExit.unavailable)
      // Prevent a noisy SSE peer from driving an unbounded request loop.
      if (!terminal(current)) await delay(100, undefined, { signal: context.signal })
    }
  } finally { lifetime.abort(); await hints }
}

export async function execute(invocation: CliInvocation, context: CliContext): Promise<CliExitCode | void> {
  if (invocation.path[1] === 'target') return targets(invocation, context)
  const [_, group, action] = invocation.path, id = invocation.arguments[0]
  // Validate command-specific combinations before reading configuration or making requests.
  let input: string | undefined
  if (group === 'run' && action === 'start') {
    if (Boolean(invocation.options.stdin) === (option(invocation, 'input') !== undefined)) throw cliFailure('invalid-input', 'Choose exactly one of --input or --stdin', cliExit.usage)
    segment(option(invocation, 'parent')!); segment(option(invocation, 'request-id')!); segment(id!)
    input = invocation.options.stdin ? await readInput(context, 1024 * 1024) : option(invocation, 'input')
    if (!input?.trim()) throw cliFailure('invalid-input', 'Prompt input must not be empty', cliExit.usage)
  }
  const target = selectTarget(await readTargets(targetConfigPath(context)), option(invocation, 'target'))
  const http = createHarnessCliHttp(target, context.signal)
  await http.check()
  const safeContext: CliContext = { ...context, emit: (data, text, type) => context.emit(redactCliData(data, target.token), text?.split(target.token).join('[REDACTED]'), type) }
  const emit = safeContext.emit
  if (['agents', 'models', 'projects'].includes(group!) && action === 'list') { await emit(await http.request(`${applicationBase}/${group}`)); return }
  if (group === 'session') {
    if (action === 'list') await emit(await http.request(`${applicationBase}/projects/${segment(option(invocation, 'project')!)}/sessions`))
    if (action === 'show') await emit(await http.request(`${applicationBase}/sessions/${segment(id!)}`))
    if (action === 'create') await emit(await http.request(`${applicationBase}/sessions`, { projectId: option(invocation, 'project')!, agentId: option(invocation, 'agent')!, ...(option(invocation, 'model') ? { modelId: option(invocation, 'model')! } : {}) }))
    return
  }
  if (group === 'run') {
    if (action === 'find') { await emit(await http.request(`${applicationBase}/sessions/${segment(id!)}/runs/by-key/${segment(option(invocation, 'request-id')!)}`)); return }
    if (action === 'start') {
      // Emit the original lookup key before the one allowed submission, including unknown outcomes.
      await emit({ sessionId: id!, requestId: option(invocation, 'request-id')! }, undefined, 'request')
      const run = runValue(await http.request(`${applicationBase}/sessions/${segment(id!)}/runs`, {
        parentNodeId: option(invocation, 'parent') === 'root' ? null : option(invocation, 'parent')!, input: input!,
        idempotencyKey: option(invocation, 'request-id')!, ...(option(invocation, 'model') ? { modelId: option(invocation, 'model')! } : {}),
      }))
      if (run.sessionId !== id) throw cliFailure('unknown-outcome', 'Write response did not identify the requested session; query run find with the original request-id', cliExit.unknownOutcome)
      if (invocation.options.detach) { await emit(run, undefined, 'accepted'); return }
      return watch(http, run, safeContext)
    }
    const run = runValue(await http.request(`${applicationBase}/runs/${segment(id!)}${action === 'cancel' ? '/cancel' : ''}`, action === 'cancel' ? {} : undefined))
    if (run.id !== id) throw cliFailure('invalid-response', 'Server returned a different run identity', cliExit.unavailable)
    if (action === 'watch') return watch(http, run, safeContext)
    await emit(run); return
  }
  throw cliFailure('unknown-command', 'Unsupported Harness command', cliExit.usage)
}

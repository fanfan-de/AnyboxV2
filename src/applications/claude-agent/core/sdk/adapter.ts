import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Component } from '@nya/core'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Options, Query, SDKUserMessage, SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import { claudeAgentError } from '../domain.js'
import type { EnvironmentView, HistoryMessageView } from '../view.js'
import { resolveClaudeExecutable } from './executable.js'
import { claudeAgentSdkServiceKey } from './port.js'
import type { ClaudeAgentSdkPort, SdkRunHandle, SdkRunHooks, SdkRunOutcome, SdkRunRequest } from './port.js'
import { createMessageTranslator, historyMessages, permissionRequest, permissionResult, resultView } from './translate.js'

export interface ClaudeAgentSdkOptions {
  readonly executableOverride?: string
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly homeDirectory?: string
  readonly isFile?: (path: string) => boolean
  /** Compiled history worker entry; defaults to the sibling module. */
  readonly historyWorker?: string
  readonly historyTimeoutMs?: number
  readonly historyLimitBytes?: number
  /** One sentence appended to the Claude Code system prompt preset. */
  readonly hostInstructions?: string
}
const defaultInstructions = 'You are running inside Anybox, a desktop host application; the user works with you through its Claude Agent interface.'
const stderrTailLimit = 8 * 1024
const forcedExitDelayMs = 10_000

interface Deferred { readonly promise: Promise<void>; resolve(): void }
const deferred = (): Deferred => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const createTail = (limit: number) => {
  let value = ''
  return { push(chunk: string) { value = (value + chunk).slice(-limit) }, read: () => value.trim() }
}
const describe = (summary: string, tail: string) => tail ? `${summary}\n${tail}` : summary
const killGroup = (child: ChildProcess) => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ } }
const exitedAlready = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null

/**
 * The only module that touches SDK objects. Owns every agent process and history worker it starts; cleanup joins their exits.
 * The user's own executable and Claude environment are used as they are: HOME is never overridden, settings sources stay default.
 */
export function createClaudeAgentSdkComponent(options: ClaudeAgentSdkOptions = {}): Component.Object<void> {
  const platform = options.platform ?? process.platform
  const isFile = options.isFile ?? ((path: string) => { try { return statSync(path).isFile() } catch { return false } })
  const workerPath = options.historyWorker ?? fileURLToPath(new URL('./history-worker.js', import.meta.url))
  const historyTimeout = options.historyTimeoutMs ?? 30_000, historyLimit = options.historyLimitBytes ?? 8 * 1024 * 1024
  const instructions = options.hostInstructions ?? defaultInstructions
  return { name: 'claude-agent-sdk', apply(ctx) {
    const executable = resolveClaudeExecutable({ override: options.executableOverride, env: options.env ?? process.env, platform, homeDirectory: options.homeDirectory ?? homedir(), isFile })
    const environment: EnvironmentView = Object.freeze({ schemaVersion: 1, platform, executable: Object.freeze({ ...executable }) })
    let accepting = true
    const handles = new Set<SdkRunHandle>(), workers = new Set<{ child: ChildProcess; exited: Promise<void> }>()
    const openRun = (request: SdkRunRequest, hooks: SdkRunHooks): SdkRunHandle => {
      if (!accepting) throw claudeAgentError('service-unavailable', 503)
      if (!executable.path) throw claudeAgentError(executable.error?.code ?? 'claude-binary-missing', 503, executable.error?.message)
      const abort = new AbortController(), translate = createMessageTranslator(), stderr = createTail(stderrTailLimit)
      const exited = deferred()
      let endInput!: () => void
      const inputEnded = new Promise<void>(resolve => { endInput = resolve })
      let child: ChildProcess | undefined, outcome: SdkRunOutcome | undefined
      // Unix: own the process group so helpers the agent leaves behind die with it. Windows has no groups; the SDK spawns there.
      const spawnGroup = platform === 'win32' ? undefined : (spawnOptions: SpawnOptions): SpawnedProcess => {
        const process = spawn(spawnOptions.command, spawnOptions.args, { cwd: spawnOptions.cwd, env: spawnOptions.env, signal: spawnOptions.signal, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
        child = process
        process.stderr?.setEncoding('utf8')
        process.stderr?.on('data', (chunk: string) => stderr.push(chunk))
        process.once('error', () => exited.resolve())
        process.once('exit', (code, signal) => { killGroup(process); hooks.onEvent({ type: 'exit', code, signal }); exited.resolve() })
        return process
      }
      // Streaming input mode keeps interrupt() available; the single prompt is followed by waiting for the Run to end.
      const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
        yield { type: 'user', message: { role: 'user', content: request.prompt }, parent_tool_use_id: null, origin: { kind: 'human' } }
        await inputEnded
      })()
      const sdkOptions: Options = {
        pathToClaudeCodeExecutable: executable.path, cwd: request.cwd,
        ...(request.resume ? { resume: request.resume } : {}), ...(request.model ? { model: request.model } : {}), ...(request.effort ? { effort: request.effort } : {}),
        systemPrompt: { type: 'preset', preset: 'claude_code', append: instructions },
        permissionMode: 'default', allowedTools: [], includePartialMessages: true, thinking: { type: 'adaptive', display: 'summarized' },
        env: { ...(options.env ?? process.env), CLAUDE_AGENT_SDK_CLIENT_APP: 'anybox' },
        abortController: abort, stderr: chunk => stderr.push(chunk),
        ...(spawnGroup ? { spawnClaudeCodeProcess: spawnGroup } : {}),
        canUseTool: async (toolName, input, callbackOptions) => permissionResult(await hooks.canUseTool(permissionRequest(toolName, input, callbackOptions)), toolName, input, callbackOptions),
      }
      let running: Query | undefined
      const result = (async (): Promise<SdkRunOutcome> => {
        try {
          running = query({ prompt, options: sdkOptions })
          for await (const message of running) {
            for (const event of translate(message)) hooks.onEvent(event)
            if (message.type === 'result') { outcome = { kind: 'result', result: resultView(message) }; endInput() }
          }
          return outcome ?? { kind: 'failed', error: { code: abort.signal.aborted ? 'cancelled' : 'agent-exited', message: describe('The agent exited before reporting a result.', stderr.read()) } }
        } catch (error) {
          return outcome ?? { kind: 'failed', error: { code: abort.signal.aborted ? 'cancelled' : 'agent-failure', message: describe(error instanceof Error ? error.message : 'The agent process failed.', stderr.read()) } }
        } finally {
          endInput()
          if (!child) exited.resolve()
          else if (!exitedAlready(child)) {
            const current = child, timer = setTimeout(() => killGroup(current), forcedExitDelayMs)
            timer.unref(); void exited.promise.then(() => clearTimeout(timer))
          }
        }
      })()
      const done = Promise.all([result, exited.promise]).then(() => {})
      const handle: SdkRunHandle = {
        result, done,
        async interrupt() { try { await Promise.race([running?.interrupt(), done]) } catch { /* the control channel is gone; close() still applies */ } },
        close() { abort.abort(); try { running?.close() } catch { /* already closed */ } if (child && !exitedAlready(child)) killGroup(child) },
      }
      handles.add(handle); void done.finally(() => handles.delete(handle))
      return handle
    }
    const readSessionMessages = async (sessionId: string, dir: string, signal?: AbortSignal): Promise<readonly HistoryMessageView[]> => {
      if (!accepting) throw claudeAgentError('service-unavailable', 503)
      if (!/^[0-9a-fA-F-]{36}$/.test(sessionId)) throw claudeAgentError('invalid-input', 400)
      const child = spawn(process.execPath, [workerPath, sessionId, dir], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true })
      const chunks: Buffer[] = []; let size = 0, overflow = false, failure: unknown
      const errors = createTail(stderrTailLimit)
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
        child.once('error', error => { failure = error; resolve({ code: null, signal: null }) })
        child.once('exit', (code, signal) => resolve({ code, signal }))
      })
      const entry = { child, exited: exited.then(() => {}) }
      workers.add(entry)
      const stop = () => { if (!exitedAlready(child)) child.kill('SIGKILL') }
      const timer = setTimeout(stop, historyTimeout)
      signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop()
      child.stderr?.setEncoding('utf8'); child.stderr?.on('data', (chunk: string) => errors.push(chunk))
      child.stdout?.on('data', (chunk: Buffer) => { size += chunk.length; if (size > historyLimit) { overflow = true; stop(); return } chunks.push(chunk) })
      try {
        const { code } = await exited
        if (signal?.aborted) throw claudeAgentError('cancelled', 499)
        if (overflow) throw claudeAgentError('history-too-large', 413)
        if (failure || code !== 0) throw claudeAgentError('history-unavailable', 503, describe('The session transcript could not be read.', errors.read()))
        return historyMessages(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        if (error instanceof Error && error.name === 'ClaudeAgentError') throw error
        throw claudeAgentError('history-unavailable', 503, 'The session transcript could not be parsed.')
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); workers.delete(entry) }
    }
    ctx.effect(() => async () => {
      accepting = false
      for (const handle of handles) handle.close()
      for (const worker of workers) if (!exitedAlready(worker.child)) worker.child.kill('SIGKILL')
      await Promise.allSettled([...[...handles].map(handle => handle.done), ...[...workers].map(worker => worker.exited)])
    }, 'terminate and join Claude Agent processes')
    const service: ClaudeAgentSdkPort = { environment: () => environment, openRun, readSessionMessages }
    ctx.provide(claudeAgentSdkServiceKey, service)
  } }
}

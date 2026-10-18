import { content, createInputQueue } from './input.js'
import { readAccountUsage } from './account.js'
import type { AccountUsageView } from '../account.js'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { statSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Component } from '@nya/core'
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Options, Query, SDKUserMessage, SessionMessage, SlashCommand, SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import { claudeAgentError } from '../domain.js'
import type { AvailableModelsView, CapabilitiesView, EnvironmentView, HistoryMessageView } from '../view.js'
import { readCapabilities } from './capabilities.js'
import { nativeSessionPermissions } from './permissions.js'
import { elicitationView, inspectQuery, nativeOptions, subagentMessages } from './workspace.js'
import type { SessionInspection, SessionInspectionResult } from '../workspace.js'
import { resolveClaudeExecutable } from './executable.js'
import { availableModelsView } from './models.js'
import { claudeAgentSdkServiceKey } from './port.js'
import type { ClaudeAgentSdkPort, SdkRunHandle, SdkRunHooks, SdkRunOutcome, SdkRunRequest, SdkSessionInfo, SdkSessionProject } from './port.js'
import { createMessageTranslator, historyMessages, permissionRequest, permissionResult, resultView, sessionInfo, sessionProjects } from './translate.js'

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
  /** Newest interactive sessions scanned for recent project directories. */
  readonly sessionScanLimit?: number
  /** Model discovery is an initialization-only process; both its duration and stdout are bounded. */
  readonly modelsTimeoutMs?: number
  readonly modelsLimitBytes?: number
  /** One sentence appended to the Claude Code system prompt preset. */
  readonly hostInstructions?: string
}
const defaultInstructions = 'You are running inside Anybox, a desktop host application; the user works with you through its Claude Agent interface.'
const stderrTailLimit = 8 * 1024
const forcedExitDelayMs = 10_000
// Session lists and single-session metadata are small; their workers get tighter bounds than a transcript read.
const sessionListTimeoutMs = 15_000, sessionListLimitBytes = 1024 * 1024, sessionInfoTimeoutMs = 10_000, sessionInfoLimitBytes = 64 * 1024
const modelDiscoveryTimeoutMs = 10_000, modelDiscoveryLimitBytes = 1024 * 1024, maxModelDiscoveries = 4

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
  const historyTimeout = options.historyTimeoutMs ?? 30_000, historyLimit = options.historyLimitBytes ?? 8 * 1024 * 1024, sessionScanLimit = options.sessionScanLimit ?? 200
  const instructions = options.hostInstructions ?? defaultInstructions
  return { name: 'claude-agent-sdk', apply(ctx) {
    const executable = resolveClaudeExecutable({ override: options.executableOverride, env: options.env ?? process.env, platform, homeDirectory: options.homeDirectory ?? homedir(), isFile })
    const environment: EnvironmentView = Object.freeze({ schemaVersion: 1, platform, executable: Object.freeze({ ...executable }) })
    let accepting = true
    const handles = new Set<SdkRunHandle>(), workers = new Set<{ child: ChildProcess; exited: Promise<void> }>()
    const discoveries = new Set<{ close(): void; done: Promise<void> }>()
    const discover = async (kind: 'models' | 'capabilities' | 'inspect' | 'account', cwd?: string, signal?: AbortSignal, inspection?: { request: SdkRunRequest; input: SessionInspection; hooks: Pick<SdkRunHooks, 'onElicitation'> }): Promise<AvailableModelsView | CapabilitiesView | SessionInspectionResult> => {
      if (!accepting) throw claudeAgentError('service-unavailable', 503)
      if (signal?.aborted) throw claudeAgentError('cancelled', 499)
      if (!executable.path) throw claudeAgentError(executable.error?.code ?? 'claude-binary-missing', 503, executable.error?.message)
      if (discoveries.size >= maxModelDiscoveries) throw claudeAgentError('models-unavailable', 503, 'Too many model discovery requests.')
      const requested = cwd ?? options.homeDirectory ?? homedir()
      if (!requested.trim() || requested.includes('\0') || requested.length > 4096 || !isAbsolute(requested)) throw claudeAgentError('project-path-invalid', 400)
      // Reserve admission before the asynchronous directory check, so shutdown also joins requests that have not spawned yet.
      const completed = deferred(), exited = deferred(), abort = new AbortController()
      let child: ChildProcess | undefined, running: Query | undefined, timedOut = false, overflow = false, stopped = false
      let finishInput!: () => void
      const inputEnded = new Promise<void>(resolve => { finishInput = resolve })
      const close = () => {
        stopped = true; finishInput(); abort.abort()
        try { running?.close() } catch { /* already closed */ }
        if (child && !exitedAlready(child)) {
          if (platform === 'win32') child.kill('SIGKILL')
          else killGroup(child)
        }
      }
      const discovery = { close, done: completed.promise }
      discoveries.add(discovery)
      const timer = setTimeout(() => { timedOut = true; close() }, inspection?.input.action === 'mcp-connect' || inspection?.input.action === 'context' && inspection.input.detail === 'full' ? 120_000 : options.modelsTimeoutMs ?? modelDiscoveryTimeoutMs)
      const cancelled = () => close()
      signal?.addEventListener('abort', cancelled, { once: true })
      if (signal?.aborted) close()
      try {
        let directory: string
        try { directory = await realpath(requested); if (!(await stat(directory)).isDirectory()) throw new Error('not-directory') }
        catch { throw claudeAgentError('project-path-missing', 404, 'The project directory does not exist on this device.') }
        if (stopped || !accepting || signal?.aborted) throw claudeAgentError(signal?.aborted ? 'cancelled' : timedOut ? 'models-timeout' : 'service-unavailable', signal?.aborted ? 499 : timedOut ? 504 : 503)
        // No user message is yielded: this code requests only initialization metadata, never a model turn. Suppress
        // discretionary hooks and MCP for this process while retaining the selected project's model/auth settings.
        // An administrator may require managed startup hooks and reject the parent mask; those policies still apply.
        const prompt = (async function* (): AsyncGenerator<SDKUserMessage> { await inputEnded })()
        running = query({ prompt, options: {
          pathToClaudeCodeExecutable: executable.path, cwd: directory, persistSession: false,
          ...(inspection ? { ...nativeOptions(inspection.request.options), ...nativeSessionPermissions(inspection.request.sessionPermissions), ...(inspection.request.resume ? { resume: inspection.request.resume } : {}),
            onElicitation: async (request, callback) => { try { const answer = await inspection.hooks.onElicitation?.(elicitationView(request), callback.signal); return answer ? { action: answer.action, ...(answer.content ? { content: { ...answer.content } } : {}) } : { action: 'decline' as const } } catch { return { action: 'cancel' as const } } } } : {}),
          ...(kind === 'models' || kind === 'account' ? { tools: [], allowedTools: [], strictMcpConfig: true, mcpServers: {} } : inspection ? {} : { allowedTools: [] }),
          settings: { disableAllHooks: true }, managedSettings: { disableAllHooks: true },
          canUseTool: async () => ({ behavior: 'deny', message: 'Model discovery does not execute tools.' }),
          env: { ...(options.env ?? process.env), CLAUDE_AGENT_SDK_CLIENT_APP: 'anybox' }, abortController: abort,
          stderr: () => {},
          spawnClaudeCodeProcess(spawnOptions) {
            const process = spawn(spawnOptions.command, spawnOptions.args, { cwd: spawnOptions.cwd, env: spawnOptions.env,
              stdio: ['pipe', 'pipe', 'pipe'], detached: platform !== 'win32', windowsHide: true })
            child = process
            process.once('error', () => exited.resolve())
            process.once('exit', () => { if (platform !== 'win32') killGroup(process); exited.resolve() })
            let size = 0
            const observeOutput = (chunk: Buffer) => { size += chunk.length; if (size > (options.modelsLimitBytes ?? modelDiscoveryLimitBytes)) { overflow = true; close() } }
            process.stdout?.on('data', observeOutput); process.stderr?.on('data', observeOutput)
            return process
          },
        } })
        const found = inspection ? await inspectQuery(running, inspection.input) : kind === 'account' ? await readAccountUsage(running) : kind === 'models' ? availableModelsView(await running.supportedModels()) : await readCapabilities(running, 'project', 'default')
        if (signal?.aborted) throw claudeAgentError('cancelled', 499)
        if (timedOut) throw claudeAgentError('models-timeout', 504)
        if (overflow) throw claudeAgentError('models-too-large', 413)
        if (!accepting) throw claudeAgentError('service-unavailable', 503)
        return found
      } catch (error) {
        if (signal?.aborted) throw claudeAgentError('cancelled', 499)
        if (timedOut) throw claudeAgentError('models-timeout', 504)
        if (overflow) throw claudeAgentError('models-too-large', 413)
        if (error instanceof Error && error.name === 'ClaudeAgentError') throw error
        throw claudeAgentError(kind === 'account' ? 'account-unavailable' : kind === 'models' ? 'models-unavailable' : 'capabilities-unavailable', 503, kind === 'account' ? '账号与额度读取失败，请检查当前执行设备的 Claude 登录状态与网络后刷新。' : kind === 'models' ? 'The Claude environment could not provide its available models.' : '当前 Claude 环境无法返回技能、MCP 或子 Agent 目录。')
      } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', cancelled)
        close()
        if (child) await exited.promise
        discoveries.delete(discovery); completed.resolve()
      }
    }
    const listAvailableModels = (cwd?: string, signal?: AbortSignal) => discover('models', cwd, signal) as Promise<AvailableModelsView>
    const listCapabilities = (cwd?: string, signal?: AbortSignal) => discover('capabilities', cwd, signal) as Promise<CapabilitiesView>
    const openRun = (request: SdkRunRequest, hooks: SdkRunHooks): SdkRunHandle => {
      if (!accepting) throw claudeAgentError('service-unavailable', 503)
      if (!executable.path) throw claudeAgentError(executable.error?.code ?? 'claude-binary-missing', 503, executable.error?.message)
      const abort = new AbortController(), translate = createMessageTranslator(), stderr = createTail(stderrTailLimit)
      const promptId = randomUUID(), submittedIds = new Set<string>([promptId])
      const exited = deferred()
      let endInput!: () => void
      const inputEnded = new Promise<void>(resolve => { endInput = resolve })
      let child: ChildProcess | undefined, outcome: SdkRunOutcome | undefined
      let mode: string = request.permissionMode ?? 'default', ended = false
      let refreshedSkills: readonly SlashCommand[] | undefined
      const controls = new Set<Promise<unknown>>()
      const control = <T>(work: () => Promise<T>): Promise<T> => {
        if (ended || abort.signal.aborted || !running) return Promise.reject(claudeAgentError('run-ended', 409))
        const task = work().catch(error => { if(error instanceof Error && error.name==='ClaudeAgentError')throw error;throw claudeAgentError('control-unavailable', 503, 'Claude 未确认此操作；请刷新状态后再决定是否重试。') })
        controls.add(task); void task.finally(() => controls.delete(task)).catch(() => {})
        return task
      }
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
      const input = createInputQueue({ type:'user',uuid:promptId,message:{role:'user',content:content(request.prompt,request.attachments)},parent_tool_use_id:null,origin:{kind:'human'} }, message => {if(message.status==='sent')outcome=undefined;hooks.onEvent({type:'input',message})})
      const prompt = input.prompt
      const sdkOptions: Options = {
        pathToClaudeCodeExecutable: executable.path, cwd: request.cwd,
        ...nativeOptions(request.options),
        ...(request.resume ? { resume: request.resume } : {}), ...(request.model ? { model: request.model } : {}), ...(request.effort ? { effort: request.effort } : {}),
        systemPrompt: { type: 'preset', preset: 'claude_code', append: instructions },
        permissionMode: request.permissionMode ?? 'default', ...nativeSessionPermissions(request.sessionPermissions), includePartialMessages: true, forwardSubagentText: true, thinking: { type: 'adaptive', display: 'summarized' },
        env: { ...(options.env ?? process.env), CLAUDE_AGENT_SDK_CLIENT_APP: 'anybox' },
        abortController: abort, stderr: chunk => stderr.push(chunk),
        ...(spawnGroup ? { spawnClaudeCodeProcess: spawnGroup } : {}),
        canUseTool: async (toolName, input, callbackOptions) => permissionResult(await hooks.canUseTool(permissionRequest(toolName, input, callbackOptions)), toolName, input, callbackOptions),
        onElicitation: async (request, callback) => { try { const answer = await hooks.onElicitation?.(elicitationView(request), callback.signal); return answer ? { action: answer.action, ...(answer.content ? { content: { ...answer.content } } : {}) } : { action: 'decline' as const } } catch { return { action: 'cancel' as const } } },
      }
      let running: Query | undefined
      let backgroundCount=0
      const result = (async (): Promise<SdkRunOutcome> => {
        try {
          running = query({ prompt, options: sdkOptions })
          for await (const message of running) {
            if(message.type==='system'&&message.subtype==='background_tasks_changed'){backgroundCount=message.tasks.filter(t=>!t.ambient).length;if(!backgroundCount&&outcome&&input.idle){ended=true;input.close();endInput()}}
            if (request.options?.checkpointing && message.type === 'user' && message.parent_tool_use_id === null && submittedIds.has(message.uuid ?? '')) hooks.onEvent({ type: 'checkpoint', messageId: message.uuid! })
            if (message.type === 'system' && message.subtype === 'init') mode = message.permissionMode
            if (message.type === 'system' && message.subtype === 'status' && message.permissionMode) mode = message.permissionMode
            if (message.type === 'system' && message.subtype === 'commands_changed') refreshedSkills = undefined
            for (const event of translate(message)) hooks.onEvent(event)
            if (message.type === 'result') {
              outcome = { kind: 'result', result: resultView(message) }
              if (!input.result(backgroundCount>0,message.is_error)) continue
              let timer: ReturnType<typeof setTimeout> | undefined
              try {
                await Promise.race([control(async () => { const context = await inspectQuery(running!, { action: 'context' }); hooks.onEvent({ type: 'context', context: context as import('../workspace.js').ContextUsage }) }), new Promise<void>(resolve => { timer = setTimeout(resolve, 1500) })])
              } catch { /* context summaries are optional; the model outcome is already authoritative */ }
              finally { if (timer) clearTimeout(timer); ended = true; input.close(); endInput() }
            }
          }
          return outcome ?? { kind: 'failed', error: { code: abort.signal.aborted ? 'cancelled' : 'agent-exited', message: describe('The agent exited before reporting a result.', stderr.read()) } }
        } catch (error) {
          return outcome ?? { kind: 'failed', error: { code: abort.signal.aborted ? 'cancelled' : 'agent-failure', message: describe(error instanceof Error ? error.message : 'The agent process failed.', stderr.read()) } }
        } finally {
          ended = true
          input.close(); endInput()
          if (!child) exited.resolve()
          else if (!exitedAlready(child)) {
            const current = child, timer = setTimeout(() => killGroup(current), forcedExitDelayMs)
            timer.unref(); void exited.promise.then(() => clearTimeout(timer))
          }
        }
      })()
      const done = Promise.all([result, exited.promise]).then(async () => { await Promise.allSettled([...controls]) })
      const handle: SdkRunHandle = {
        result, done,
        enqueue: (message, attachments) => { if(ended||abort.signal.aborted)throw claudeAgentError('run-ended',409);submittedIds.add(message.id);input.enqueue(message,attachments) },
        cancelInput: id => input.cancel(id),
        inspect: input => control(() => inspectQuery(running!, input)),
        capabilities: () => control(() => readCapabilities(running!, 'run', mode, refreshedSkills)),
        control: input => control(async () => {
          switch (input.action) {
            case 'mcp-set': { const mapped=nativeOptions({maxBudgetUsd:null,maxTurns:null,fallbackModel:null,checkpointing:false,mcpServers:input.servers}).mcpServers ?? {};const result=await running!.setMcpServers(mapped);if(Object.keys(result.errors??{}).length)throw claudeAgentError('mcp-partial',409,'部分 MCP 服务未连接，请刷新服务状态核对。');return }
            case 'mcp-permission': await running!.setMcpPermissionModeOverride(input.name,input.mode);return
            case 'background-tasks': await running!.backgroundTasks(input.toolUseId);return
            case 'permission-mode': await running!.setPermissionMode(input.mode); mode = input.mode; hooks.onEvent({ type: 'permission-mode', mode }); return
            case 'reload-skills': refreshedSkills = (await running!.reloadSkills()).skills; return
            case 'mcp-reconnect': await running!.reconnectMcpServer(input.name); return
            case 'mcp-toggle': await running!.toggleMcpServer(input.name, input.enabled); return
            case 'stop-task': await running!.stopTask(input.taskId); return
          }
        }),
        async interrupt() { input.close(); try { await Promise.race([running?.interrupt(), done]) } catch { /* the control channel is gone; close() still applies */ } },
        close() { input.close(); abort.abort(); try { running?.close() } catch { /* already closed */ } if (child && !exitedAlready(child)) killGroup(child) },
      }
      handles.add(handle); void done.finally(() => handles.delete(handle))
      return handle
    }
    /** One worker per read: spawned, bounded by time and output size, killed on cancellation, joined before cleanup completes. */
    const runWorker = async (args: readonly string[], bounds: { readonly timeoutMs: number; readonly limitBytes: number }, signal?: AbortSignal): Promise<unknown> => {
      if (!accepting) throw claudeAgentError('service-unavailable', 503)
      const child = spawn(process.execPath, [workerPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true })
      const chunks: Buffer[] = []; let size = 0, overflow = false, failure: unknown
      const errors = createTail(stderrTailLimit)
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
        child.once('error', error => { failure = error; resolve({ code: null, signal: null }) })
        child.once('exit', (code, signal) => resolve({ code, signal }))
      })
      const entry = { child, exited: exited.then(() => {}) }
      workers.add(entry)
      const stop = () => { if (!exitedAlready(child)) child.kill('SIGKILL') }
      const timer = setTimeout(stop, bounds.timeoutMs)
      signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop()
      child.stderr?.setEncoding('utf8'); child.stderr?.on('data', (chunk: string) => errors.push(chunk))
      child.stdout?.on('data', (chunk: Buffer) => { size += chunk.length; if (size > bounds.limitBytes) { overflow = true; stop(); return } chunks.push(chunk) })
      try {
        const { code } = await exited
        if (signal?.aborted) throw claudeAgentError('cancelled', 499)
        if (overflow) throw claudeAgentError('history-too-large', 413)
        if (failure || code !== 0) throw claudeAgentError('history-unavailable', 503, describe('The Claude environment\'s session files could not be read.', errors.read()))
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
      } catch (error) {
        if (error instanceof Error && error.name === 'ClaudeAgentError') throw error
        throw claudeAgentError('history-unavailable', 503, 'The Claude environment\'s session data could not be parsed.')
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); workers.delete(entry) }
    }
    const requireSessionId = (sessionId: string) => { if (!/^[0-9a-fA-F-]{36}$/.test(sessionId)) throw claudeAgentError('invalid-input', 400) }
    const readSessionMessages = async (sessionId: string, dir: string, signal?: AbortSignal): Promise<readonly HistoryMessageView[]> => {
      requireSessionId(sessionId)
      return await runWorker(['messages', sessionId, dir], { timeoutMs: historyTimeout, limitBytes: historyLimit }, signal) as HistoryMessageView[]
    }
    const listSessionProjects = async (signal?: AbortSignal): Promise<readonly SdkSessionProject[]> =>
      sessionProjects(await runWorker(['sessions', String(sessionScanLimit)], { timeoutMs: sessionListTimeoutMs, limitBytes: sessionListLimitBytes }, signal))
    const readSessionInfo = async (sessionId: string, dir: string, signal?: AbortSignal): Promise<SdkSessionInfo | undefined> => {
      requireSessionId(sessionId)
      return sessionInfo(await runWorker(['info', sessionId, dir], { timeoutMs: sessionInfoTimeoutMs, limitBytes: sessionInfoLimitBytes }, signal))
    }
    ctx.effect(() => async () => {
      accepting = false
      for (const discovery of discoveries) discovery.close()
      for (const handle of handles) handle.close()
      for (const worker of workers) if (!exitedAlready(worker.child)) worker.child.kill('SIGKILL')
      await Promise.allSettled([...[...handles].map(handle => handle.done), ...[...workers].map(worker => worker.exited), ...[...discoveries].map(discovery => discovery.done)])
    }, 'terminate and join Claude Agent processes')
    const service: ClaudeAgentSdkPort = { environment: () => environment, listAvailableModels, listCapabilities, openRun, readSessionMessages, listSessionProjects, readSessionInfo,
      readAccountUsage: (cwd, signal) => discover('account', cwd, signal) as Promise<AccountUsageView>,
      inspectSession: (request, input, hooks, signal) => discover('inspect', request.cwd, signal, { request, input, hooks }) as Promise<SessionInspectionResult>,
      async listNativeSessions(dir,offset,signal){return await runWorker(['native-sessions',dir,String(offset)],{timeoutMs:historyTimeout,limitBytes:historyLimit},signal) as {sessionId:string;title:string;updatedAt:string}[]},
      async readSessionPage(sessionId,dir,offset,signal){requireSessionId(sessionId);const page=await runWorker(['page',sessionId,dir,String(offset)],{timeoutMs:historyTimeout,limitBytes:historyLimit},signal) as {messages:HistoryMessageView[];hasMore:boolean;nextOffset:number;previousOffset:number|null};return page},
      async listSubagents(sessionId, dir, signal) {
        requireSessionId(sessionId)
        const value = await runWorker(['subagents', sessionId, dir], { timeoutMs: historyTimeout, limitBytes: historyLimit }, signal)
        if (!Array.isArray(value) || value.length > 2000 || value.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(id))) throw claudeAgentError('history-too-large', 413)
        return value as string[]
      },
      async readSubagentMessages(sessionId, dir, agentId, offset, signal) {
        requireSessionId(sessionId)
        if (!/^[a-zA-Z0-9_-]{1,200}$/.test(agentId) || !Number.isInteger(offset) || offset < 0 || offset > 1000000) throw claudeAgentError('invalid-input', 400)
        return await runWorker(['subagent-messages', sessionId, dir, agentId, String(offset)], { timeoutMs: historyTimeout, limitBytes: historyLimit }, signal) as {messages:HistoryMessageView[];hasMore:boolean}
      },
      async mutateSession(sessionId, dir, input, signal) {
        requireSessionId(sessionId)
        return await runWorker([input.action, sessionId, dir, ...('value' in input ? [input.value] : input.action === 'fork' ? [input.title, input.messageId ?? ''] : [])], { timeoutMs: historyTimeout, limitBytes: historyLimit }, signal) as { sessionId?: string }
      },
    }
    ctx.provide(claudeAgentSdkServiceKey, service)
  } }
}

import { randomUUID } from 'node:crypto'
import { EffectScope } from '@nya/core'
import type { KernelApi } from '@anybox/agent-contracts/api'
import type {
  AgentInstance, Message, RunAccepted, RunLimits, RunResult,
  RunSnapshot, StartRunRequest,
} from '@anybox/agent-contracts'
import type {
  ExecutionStrategy, SessionPolicy, ModelOutput, ModelService, Owned, StateData, StateSnapshot, StateService,
  RunExecutionStrategy, ContextBuilder, ToolPolicy, ToolService,
} from '@anybox/agent-contracts/spi'
import { fault, KernelFault, throwCollected, wrap } from '../../shared/errors.js'
import { createAgentLoop } from '../../strategies/execution.js'
import { createSessionPolicy } from '../../strategies/session.js'
import { createContextBuilder } from '../../strategies/context.js'
import { createRunRuntime } from './runtime.js'
import { planRunSettlement } from '../../domain/settlement.js'
import type { RunStop } from '../../domain/settlement.js'
import { appendEvent } from './events.js'
import { toolDefinitions } from '../../domain/content.js'
import { planRecovery } from '../../domain/recovery.js'
import type { ToolDefinition } from '@anybox/agent-contracts'
import { deferred, definition, limits, observe, revision, string, terminal, textBytes, textParts } from '../../shared/utils.js'

interface Task {
  readonly id: string
  readonly run: RunSnapshot
  readonly scope: EffectScope
  readonly release: () => void | Promise<void>
  readonly result: ReturnType<typeof deferred<RunResult>>
  readonly stopped: ReturnType<typeof deferred<void>>
  readonly controller: AbortController
  phase: 'queued' | 'active' | 'finishing'
  stop?: RunStop
}
export interface CoordinatorFactories {
  readonly sessionPolicy?: () => SessionPolicy
  /** Legacy single-call strategy. Cannot be combined with executionStrategy. */
  readonly strategy?: () => ExecutionStrategy
  readonly executionStrategy?: () => RunExecutionStrategy
  readonly contextBuilder?: () => ContextBuilder
  readonly toolPolicy?: () => ToolPolicy
}

export interface CoordinatorSetup extends CoordinatorFactories {
  /** Interrupt records left by a dead owner; requires a persistent, exclusively owned store. */
  readonly recovery?: 'reject' | 'interrupt'
  /** Application-level request keys can survive process generations. */
  readonly requestScope?: 'generation' | 'agent'
}

export interface CoordinatorOptions extends CoordinatorSetup {
  readonly state: StateService
  readonly model: ModelService
  readonly tools?: ToolService
  readonly config?: Partial<RunLimits>
  /** 集成层阻止已开始卸载但尚未进入 Effect 清理的旧 facade 接收请求。 */
  readonly available?: () => boolean
}

export function createRunCoordinator(options: CoordinatorOptions): Owned<KernelApi> {
  const config = limits(options.config)
  if (options.recovery !== undefined && !['reject', 'interrupt'].includes(options.recovery)) throw fault('INVALID_ARGUMENT', 'invalid recovery policy')
  if (options.requestScope !== undefined && !['generation', 'agent'].includes(options.requestScope)) throw fault('INVALID_ARGUMENT', 'invalid request scope')
  if (options.recovery === 'interrupt' && options.state.durability !== 'persistent') throw fault('INVALID_ARGUMENT', 'recovery requires persistent exclusive ownership')
  let interruptedRunIds: readonly string[] = []
  const policy = (options.sessionPolicy ?? createSessionPolicy)()
  if (options.strategy && options.executionStrategy) throw fault('INVALID_ARGUMENT', 'choose either legacy or runtime strategy')
  const contextBuilder = (options.contextBuilder ?? createContextBuilder)()
  const toolPolicy = options.toolPolicy?.() ?? { decide: () => 'allow' as const }
  let selectedTools: readonly ToolDefinition[] = []
  const owner = new EffectScope('run coordinator')
  const tasks = new Map<string, Task>()
  const settlementFailures = new Map<string, KernelFault>()
  const closingErrors: unknown[] = []
  let agent: AgentInstance | undefined
  let fatal: KernelFault | undefined
  let closed = false
  let closing: Promise<void> | undefined
  let active = 0
  let commands: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(command: () => T | Promise<T>): Promise<T> => {
    const result = commands.then(command)
    commands = result.catch(() => {})
    return result
  }
  const available = () => options.available?.() ?? true
  const assertOpen = (write = false) => {
    if (closed || !available()) throw fault('CLOSED', 'run coordinator is closed')
    if (write && fatal) throw fatal
  }
  const requireAgent = () => {
    if (!agent) throw fault('NOT_READY', 'initialize the agent first')
    return agent
  }
  const trip = (error: KernelFault) => {
    if (fatal) return
    fatal = error
    closingErrors.push(error)
    // 只提交停止命令，不从当前命令中等待工作，避免队列自等待。
    for (const task of tasks.values()) {
      void enqueue(() => stopTask(task, { kind: 'failure', error: error.error })).catch(() => {})
    }
  }
  const read = async () => {
    try { return await options.state.readSnapshot() }
    catch (error) {
      const failure = wrap('STATE_FAILED', 'state snapshot could not be read', error)
      trip(failure); throw failure
    }
  }
  const transact = async <T>(label: string, change: (draft: StateData) => T): Promise<T> => {
    // 区分业务校验拒绝和存储实现拒绝，不能信任提供方随意抛出的错误类型。
    let validationError: unknown
    try {
      return await options.state.transaction(label, draft => {
        try { return change(draft) } catch (error) { validationError = error; throw error }
      })
    } catch (error) {
      if (error === validationError && error instanceof KernelFault) throw error
      const failure = wrap('STATE_FAILED', 'state transaction failed', error)
      trip(failure); throw failure
    }
  }
  const getRun = (data: StateSnapshot, id: string): RunSnapshot => {
    const run = data.runs.get(id)
    if (!run) throw fault('NOT_FOUND', 'run not found')
    return run
  }

  async function stopTask(task: Task, stop: RunStop): Promise<void> {
    if (!tasks.has(task.id) || task.stop) return
    task.stop = stop
    task.controller.abort(stop.kind === 'failure' ? stop.error : { code: 'CANCELLED', message: 'run cancelled' })
    try {
      await transact('run.cancel', data => {
        const run = getRun(data, task.id)
        if (!terminal(run)) {
          data.runs.set(run.id, { ...run, status: 'cancelling', reason: stop.kind === 'cancel' ? stop.reason : undefined })
          appendEvent(data, run.id, 'run.cancelling', 'cancelling')
        }
      })
    } finally {
      if (task.phase === 'queued') {
        task.phase = 'finishing'
        void finish(task).catch(error => emergencyFinish(task, error))
      }
    }
  }

  async function emergencyFinish(task: Task, error: unknown) {
    const failure = wrap('SETTLEMENT_FAILED', 'run could not be settled', error)
    settlementFailures.set(task.id, failure)
    trip(failure)
    task.controller.abort(failure.error)
    try { await task.release() } catch (error) { closingErrors.push(error) }
    await enqueue(() => {
      task.result.reject(failure)
      if (tasks.delete(task.id)) {
        if (task.phase === 'active') active--
        task.stopped.resolve()
      }
    })
  }

  async function finish(task: Task, output?: ModelOutput, executionError?: KernelFault, attemptId?: string) {
    let cleanupError: KernelFault | undefined
    try { await task.release() } catch (error) {
      cleanupError = wrap('CLEANUP_FAILED', 'run resources could not be released', error)
      closingErrors.push(cleanupError)
    }
    await enqueue(async () => {
      try {
        const result = await transact('run.finish', data => {
          // Sample after cleanup and when the transaction actually runs, against its latest state.
          const planned = planRunSettlement(data, {
            runId: task.id, endedAt: new Date().toISOString(), stop: task.stop,
            cleanupError: cleanupError?.error, executionError: executionError?.error,
            final: output && attemptId ? { output, attemptId, messageId: randomUUID() } : undefined,
            toolResultMessageIds: new Map([...data.toolCalls.values()]
              .filter(call => call.runId === task.id && (call.status === 'pending' || call.status === 'running'))
              .map(call => [call.id, randomUUID()])),
          })
          Object.assign(data, planned.state)
          return planned.result
        })
        task.result.resolve(result)
      } catch (error) {
        const failure = wrap('SETTLEMENT_FAILED', 'run terminal state could not be saved', error)
        settlementFailures.set(task.id, failure)
        task.result.reject(failure)
        trip(failure)
      } finally {
        if (task.phase === 'active') active--
        tasks.delete(task.id)
        task.stopped.resolve()
        pump()
      }
    })
  }

  async function execute(task: Task) {
    let output: ModelOutput | undefined
    let error: KernelFault | undefined
    let attemptId: string | undefined
    try {
      const running = await enqueue(async () => {
        if (task.stop || closed || fatal || !available()) return false
        await transact('run.running', data => {
          data.runs.set(task.id, { ...getRun(data, task.id), status: 'running' })
          appendEvent(data, task.id, 'run.running', 'running')
        })
        return true
      })
      if (!running || task.stop || closed || fatal || !available()) {
        task.stop ??= { kind: 'cancel', reason: 'coordinator stopped' }
      } else {
        const runtime = createRunRuntime({
          run: task.run, signal: task.controller.signal, model: options.model, tools: options.tools,
          sessionPolicy: policy, context: contextBuilder, toolPolicy,
          strategy: (options.executionStrategy ?? createAgentLoop)(), legacyStrategy: options.strategy?.(),
          assertRunnable() {
            if (fatal) throw fatal
            if (task.stop || closed || !available()) throw fault('CANCELLED', 'run stopped')
          },
          snapshot: () => enqueue(read),
          commit: (label, change) => enqueue(() => transact(label, change)),
        })
        task.scope.add(() => runtime.close())
        const result = await runtime.execute()
        output = result.output; attemptId = result.attemptId
      }
    } catch (cause) {
      error = cause instanceof KernelFault ? cause : wrap('INTERNAL', 'run execution failed', cause)
    }
    await finish(task, output, error, attemptId)
  }

  function pump() {
    if (closed || fatal || !available()) return
    for (const task of tasks.values()) {
      if (active >= config.maxConcurrent) break
      if (task.phase !== 'queued' || task.stop) continue
      task.phase = 'active'; active++
      void execute(task).catch(error => emergencyFinish(task, error))
    }
  }

  function register(run: RunSnapshot) {
    const scope = new EffectScope(`run ${run.id}`)
    const release = owner.add(() => scope.dispose())
    const task: Task = { id: run.id, run, scope, release, result: deferred<RunResult>(), stopped: deferred<void>(),
      controller: new AbortController(), phase: 'queued' }
    tasks.set(run.id, task)
    // 原生 timer 直接归本次 Run 的 EffectScope；关闭时逐项清理，不独立成为服务。
    const timer = setTimeout(() => {
      void enqueue(() => stopTask(task, { kind: 'failure', error: {
        code: 'LIMIT_EXCEEDED', message: 'run deadline exceeded',
      } })).catch(() => {})
    }, Math.max(0, Date.parse(run.deadlineAt) - Date.now()))
    scope.add(() => clearTimeout(timer))
  }

  const service: KernelApi = {
    initialize(request) {
      let normalized: ReturnType<typeof definition>
      try { normalized = definition(request?.definition) }
      catch (error) { return Promise.reject(error) }
      return enqueue(async () => {
        assertOpen(true)
        if (agent) throw fault('CONFLICT', 'agent is already initialized')
        if (Buffer.byteLength(normalized.instructions) > config.maxContextBytes) throw fault('LIMIT_EXCEEDED', 'instructions exceed context limit')
        const catalog = options.tools ? toolDefinitions(options.tools.definitions()) : []
        const tools = (normalized.tools ?? []).map(ref => {
          const tool = catalog.find(tool => tool.id === ref.id && tool.revision === ref.revision)
          if (!tool || options.strategy) throw fault('CAPABILITY_UNAVAILABLE', 'selected tool version is unavailable')
          return tool
        })
        const created = await transact('initialize', data => {
          if (data.definition && JSON.stringify(data.definition) !== JSON.stringify(normalized)) throw fault('CONFLICT', 'stored agent definition does not match')
          const recovered = options.recovery === 'interrupt' ? planRecovery(data, new Date().toISOString()) : undefined
          if (recovered) Object.assign(data, recovered.state)
          else if ([...data.runs.values()].some(run => !terminal(run))) throw fault('CONFLICT', 'state contains unsettled runs')
          const instance: AgentInstance = { id: data.agent?.id ?? randomUUID(), definitionId: normalized.id,
            definitionRevision: normalized.revision, generation: randomUUID(), createdAt: data.agent?.createdAt ?? new Date().toISOString() }
          data.agent = instance; data.definition = normalized
          return { instance, interruptedRunIds: recovered?.interruptedRunIds ?? [] }
        })
        agent = created.instance
        interruptedRunIds = created.interruptedRunIds
        selectedTools = structuredClone(tools)
        return structuredClone(agent)
      })
    },
    describe() {
      return structuredClone({ ready: !!agent && !closed && !fatal && available(), stateDurability: options.state.durability,
        ...(agent ? { agent } : {}), recovery: { interruptedRunIds },
        capabilities: { text: true as const, streaming: false as const, tools: !!options.tools && !options.strategy, events: true as const }, limits: config,
        ...(fatal ? { fault: fatal.error } : {}) })
    },
    sessions: {
      list(request = {}) {
        const { offset = 0, limit = 100 } = request
        return enqueue(async () => {
          assertOpen(); requireAgent(); page(offset, limit)
          return [...(await read()).sessions.values()].slice(offset, offset + limit)
        })
      },
      create: () => enqueue(async () => {
        assertOpen(true); const current = requireAgent()
        return transact('session.create', data => {
          if (data.sessions.size >= config.maxSessions) throw fault('LIMIT_EXCEEDED', 'session capacity exceeded')
          const session = { id: randomUUID(), agentId: current.id, version: 1, createdAt: new Date().toISOString() }
          data.sessions.set(session.id, session); return session
        })
      }),
      get(request) {
        const sessionId = request?.sessionId
        return enqueue(async () => {
          assertOpen(); requireAgent(); string(sessionId, 'sessionId')
          const session = (await read()).sessions.get(sessionId)
          if (!session) throw fault('NOT_FOUND', 'session not found')
          return session
        })
      },
      messages(request) {
        const sessionId = request?.sessionId
        return enqueue(async () => {
          assertOpen(); requireAgent(); string(sessionId, 'sessionId')
          const data = await read()
          const session = data.sessions.get(sessionId)
          if (!session) throw fault('NOT_FOUND', 'session not found')
          return { session, messages: [...data.messages.values()].filter(message => message.sessionId === session.id) }
        })
      },
    },
    runs: {
      list(request = {}) {
        const { offset = 0, limit = 100, sessionId } = request
        return enqueue(async () => {
          assertOpen(); requireAgent(); page(offset, limit)
          if (sessionId !== undefined) string(sessionId, 'sessionId')
          const data = await read()
          if (sessionId !== undefined && !data.sessions.has(sessionId)) throw fault('NOT_FOUND', 'session not found')
          return [...data.runs.values()].filter(run => sessionId === undefined || run.sessionId === sessionId).slice(offset, offset + limit)
        })
      },
      start(request) {
        // 进入异步队列前复制规范字段，调用方之后的修改不得改变请求。
        let input: StartRunRequest
        try {
          assertOpen(true); requireAgent()
          string(request?.agentId, 'agentId'); string(request.agentGeneration, 'agentGeneration')
          string(request.sessionId, 'sessionId'); string(request.requestKey, 'requestKey')
          revision(request.expectedSessionVersion); textParts(request.input)
          if (textBytes(request.input) > config.maxInputBytes) throw fault('LIMIT_EXCEEDED', 'input exceeds byte limit')
          input = { agentId: request.agentId, agentGeneration: request.agentGeneration, sessionId: request.sessionId,
            requestKey: request.requestKey, expectedSessionVersion: request.expectedSessionVersion,
            input: request.input.map(part => ({ type: 'text', text: part.text })) }
        } catch (error) { return Promise.reject(error) }
        return enqueue(async () => {
          assertOpen(true)
          const stable = options.requestScope === 'agent'
          const key = JSON.stringify(stable ? ['agent', input.agentId, input.sessionId, input.requestKey]
            : [input.agentId, input.agentGeneration, input.sessionId, input.requestKey])
          const fingerprint = JSON.stringify(stable ? { ...input, agentGeneration: undefined } : input)
          const accepted = await transact('run.accept', data => {
            if (input.agentId !== agent!.id || input.agentGeneration !== agent!.generation) throw fault('CONFLICT', 'agent generation does not match')
            const existing = data.requests.get(key)
            if (existing) {
              if (existing.fingerprint !== fingerprint) throw fault('CONFLICT', 'request key was used for a different request')
              return { receipt: existing.receipt }
            }
            const session = policy.validateStart(structuredClone(data), structuredClone(input))
            if (data.runs.size >= config.maxRuns) throw fault('LIMIT_EXCEEDED', 'run record capacity exceeded')
            if (tasks.size >= config.maxConcurrent + config.maxQueued) throw fault('LIMIT_EXCEEDED', 'run queue capacity exceeded')
            const now = Date.now()
            const id = randomUUID()
            const message: Message = { id: randomUUID(), sessionId: session.id, runId: id, role: 'user',
              content: input.input, createdAt: new Date(now).toISOString() }
            const run: RunSnapshot = { id, agentId: agent!.id, sessionId: session.id,
              basis: { agentGeneration: agent!.generation, definition: data.definition!, limits: config, tools: selectedTools },
              inputMessageId: message.id, resultMessageIds: [], createdAt: message.createdAt,
              deadlineAt: new Date(now + config.runTimeoutMs).toISOString(), status: 'queued', lastEventSeq: 0 }
            const receipt: RunAccepted = { runId: id, inputMessageId: message.id, sessionVersion: session.version + 1 }
            data.messages.set(message.id, message); data.runs.set(id, run)
            appendEvent(data, id, 'run.accepted', 'queued')
            data.sessions.set(session.id, { ...session, version: receipt.sessionVersion })
            data.requests.set(key, { fingerprint, receipt })
            return { receipt, run: data.runs.get(id)! }
          })
          if (accepted.run) {
            try { register(accepted.run) }
            catch (error) {
              const failure = wrap('INTERNAL', 'accepted run could not be registered', error)
              const task = tasks.get(accepted.run.id)
              if (task) await stopTask(task, { kind: 'failure', error: failure.error })
              else {
                await transact('run.finish', data => {
                  const planned = planRunSettlement(data, {
                    runId: accepted.run!.id, endedAt: new Date().toISOString(),
                    stop: { kind: 'failure', error: failure.error }, toolResultMessageIds: new Map(),
                  })
                  Object.assign(data, planned.state)
                })
              }
              throw failure
            }
            pump()
          }
          return accepted.receipt
        })
      },
      get(request) {
        const runId = request?.runId
        return enqueue(async () => {
          assertOpen(); string(runId, 'runId')
          return getRun(await read(), runId)
        })
      },
      inspect(request) {
        const runId = request?.runId
        return enqueue(async () => {
          assertOpen(); string(runId, 'runId')
          const data = await read()
          return { run: getRun(data, runId),
            steps: [...data.steps.values()].filter(step => step.runId === runId),
            attempts: [...data.attempts.values()].filter(attempt => attempt.runId === runId),
            toolCalls: [...data.toolCalls.values()].filter(call => call.runId === runId) }
        })
      },
      events(request) {
        const runId = request?.runId, afterSeq = request?.afterSeq ?? 0, limit = request?.limit ?? 100
        return enqueue(async () => {
          assertOpen(); string(runId, 'runId')
          if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
            throw fault('INVALID_ARGUMENT', 'invalid event cursor or page limit')
          }
          const data = await read(), run = getRun(data, runId)
          if (afterSeq > run.lastEventSeq) throw fault('INVALID_ARGUMENT', 'event cursor is ahead of the run')
          const events = (data.events.get(runId) ?? []).filter(event => event.seq > afterSeq).slice(0, limit)
          return { events, lastEventSeq: run.lastEventSeq,
            hasMore: (events.at(-1)?.seq ?? afterSeq) < run.lastEventSeq }
        })
      },
      cancel(request) {
        const runId = request?.runId, reason = request?.reason
        return enqueue(async () => {
          assertOpen(); string(runId, 'runId')
          if (reason !== undefined) string(reason, 'reason')
          const run = getRun(await read(), runId)
          if (terminal(run)) return { runId: run.id, outcome: 'already-terminal', status: run.status }
          const task = tasks.get(run.id)
          if (!task) throw settlementFailures.get(run.id) ?? fault('SETTLEMENT_FAILED', 'run has no live owner')
          await stopTask(task, { kind: 'cancel', reason })
          return { runId: run.id, outcome: 'requested' }
        })
      },
      async wait(request) {
        const runId = request?.runId, signal = request?.signal
        const selected = await enqueue(async () => {
          assertOpen(); string(runId, 'runId')
          const run = getRun(await read(), runId)
          if (terminal(run)) return { result: Promise.resolve(run) }
          const failure = settlementFailures.get(run.id)
          if (failure) throw failure
          const task = tasks.get(run.id)
          if (!task) throw fault('SETTLEMENT_FAILED', 'run has no live owner')
          // 对象包裹 Promise，不能让命令队列等待 Run 结束。
          return { result: task.result.promise }
        })
        return structuredClone(await observe(selected.result, signal))
      },
    },
  }

  return { service, close() {
    if (closing) return closing
    closed = true
    closing = Promise.resolve().then(async () => {
      const pending = await enqueue(async () => {
        const pending = [...tasks.values()]
        for (const task of pending) {
          try { await stopTask(task, { kind: 'cancel', reason: 'coordinator closed' }) }
          catch (error) { closingErrors.push(error) }
        }
        return pending
      })
      await Promise.all(pending.map(task => task.stopped.promise))
      try { await owner.dispose() } catch (error) { closingErrors.push(error) }
      throwCollected(closingErrors, 'run coordinator close failed')
    })
    return closing
  } }
}

function page(offset: number, limit: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw fault('INVALID_ARGUMENT', 'invalid page offset or limit')
  }
}

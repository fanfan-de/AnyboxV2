import { randomUUID } from 'node:crypto'
import { EffectScope } from '@nya/core'
import type { KernelError, RunSnapshot, ToolCall, ToolOutcome, TextPart } from '@anybox/agent-contracts'
import type {
  ContextBuilder, ExecutionContext, ExecutionStrategy, ModelOutput, ModelService, ModelStepResult,
  RunExecutionStrategy, SessionPolicy, StateData, StateSnapshot, ToolPolicy, ToolService,
} from '@anybox/agent-contracts/spi'
import { nextModelStep, normalizeModelOutput, planModelStarted, planModelFinished, planModelFailed,
  toolRequests, validateModelContext } from '../../domain/model.js'
import { toolBatch, validateToolCall, validateToolDecision, normalizeToolOutcome, unconfirmedToolOutcome,
  planToolStarted, planToolFinished, planToolStepFinished } from '../../domain/tools.js'
import type { StateTransition } from '../../domain/state.js'
import { fault, KernelFault, throwCollected, wrap } from '../../shared/errors.js'

export interface RuntimeResult {
  readonly output: { readonly content: readonly TextPart[] }
  readonly attemptId: string
  readonly stepId: string
}
export interface RuntimeOptions {
  readonly run: RunSnapshot
  readonly signal: AbortSignal
  readonly model: ModelService
  readonly tools?: ToolService
  readonly sessionPolicy: SessionPolicy
  readonly context: ContextBuilder
  readonly toolPolicy: ToolPolicy
  readonly strategy: RunExecutionStrategy
  readonly legacyStrategy?: ExecutionStrategy
  assertRunnable(): void
  snapshot(): Promise<StateSnapshot>
  commit<T>(label: string, change: (state: StateData) => T): Promise<T>
}

/** One per Run. All effects enter through tracked, serial actions. No Run terminal writes. */
export function createRunRuntime(options: RuntimeOptions) {
  const { run, signal } = options
  const scope = new EffectScope(`runtime ${run.id}`)
  const actions = new Set<Promise<unknown>>()
  const cleanupErrors: unknown[] = []
  let busy = false, sealed = false
  let failure: KernelFault | undefined
  let final: RuntimeResult | undefined
  let closing: Promise<void> | undefined
  const remember = (error: unknown) => failure ??= error instanceof KernelFault
    ? error : wrap('INTERNAL', 'execution action failed', error)
  const guard = () => {
    if (failure) throw failure
    if (sealed) throw fault('CLOSED', 'run execution interface is closed')
    options.assertRunnable()
    if (signal.aborted) throw fault('CANCELLED', 'run execution cancelled')
    if (Date.now() >= Date.parse(run.deadlineAt)) throw fault('LIMIT_EXCEEDED', 'run deadline exceeded')
  }
  const action = <T>(work: () => Promise<T>): Promise<T> => {
    const rejected = (error: unknown): Promise<T> => {
      const result = Promise.reject<T>(remember(error)); void result.catch(() => {}); return result
    }
    try {
      guard()
      if (busy) throw fault('CONFLICT', 'execution actions must be awaited serially')
    } catch (error) { return rejected(error) }
    busy = true
    const result = Promise.resolve().then(work).catch(error => { throw remember(error) })
      .finally(() => { busy = false; actions.delete(result) })
    actions.add(result); void result.catch(() => {})
    return result
  }

  async function perform<T>(start: () => {
    readonly result: Promise<T>; readonly done: Promise<void>; cancel(reason?: KernelError): void
  }): Promise<T> {
    guard()
    const handle = start()
    // Observe both promises immediately, including a done rejection before result settles.
    void handle.result.catch(() => {}); void handle.done.catch(() => {})
    const cancel = () => {
      try { handle.cancel({ code: 'CANCELLED', message: 'run stopped' }) }
      catch (error) { cleanupErrors.push(wrap('CLEANUP_FAILED', 'operation cancellation failed', error)) }
    }
    signal.addEventListener('abort', cancel, { once: true })
    const release = scope.add(async () => {
      const errors: unknown[] = []
      try { handle.cancel() } catch (error) { errors.push(error) }
      try { await handle.done } catch (error) { errors.push(error) }
      signal.removeEventListener('abort', cancel)
      throwCollected(errors, 'operation cleanup failed')
    })
    if (signal.aborted) cancel()
    try { return await handle.result }
    finally {
      try { await release() }
      catch (error) {
        const failure = wrap('CLEANUP_FAILED', 'operation cleanup failed', error)
        cleanupErrors.push(failure); throw failure
      }
    }
  }

  // Plans run against the latest transaction draft; only successfully committed values escape.
  const commit = <T>(label: string, plan: (snapshot: StateSnapshot) => StateTransition<T>): Promise<T> =>
    options.commit(label, draft => {
      const transition = plan(draft)
      Object.assign(draft, transition.state)
      return transition.value
    })

  async function modelStep(): Promise<ModelStepResult> {
    guard()
    const data = await options.snapshot()
    guard()
    nextModelStep(data, run.id)
    const context = options.context.build({ state: structuredClone(data), run: structuredClone(run),
      history: structuredClone(options.sessionPolicy.history(structuredClone(data), structuredClone(run))) })
    validateModelContext(context, run.basis.limits.maxContextBytes)
    const stepId = randomUUID(), attemptId = randomUUID()
    const budget = await commit('model.start', state => {
      guard()
      return planModelStarted(state, { runId: run.id, stepId, attemptId, at: new Date().toISOString() })
    })
    const request = { ...structuredClone(context), runId: run.id, attemptId,
      model: run.basis.definition.model, maxOutputBytes: budget.maxOutputBytes }
    try {
      let output: ModelOutput
      if (options.legacyStrategy) {
        let invoked = false
        let pending: Promise<ModelOutput> | undefined
        output = await options.legacyStrategy.execute(structuredClone(request), () => {
          if (invoked) throw fault('CAPABILITY_UNAVAILABLE', 'legacy strategy permits one model call')
          invoked = true
          // Keep the legacy synchronous handle, but Runtime owns the real operation and drain.
          let handle!: ReturnType<ModelService['call']>
          pending = perform(() => (handle = options.model.call(structuredClone(request))))
          void pending.catch(() => {})
          if (!handle) throw fault('CANCELLED', 'model call was not started')
          return handle
        }, signal).finally(async () => { if (pending) await pending })
        if (!invoked) throw fault('CAPABILITY_UNAVAILABLE', 'legacy strategy must invoke the model once')
      } else output = await perform(() => options.model.call(structuredClone(request)))
      guard()
      output = normalizeModelOutput(output)
      const toolCallIds = toolRequests(output.content).map(() => randomUUID())
      const assistantMessageId = randomUUID()
      const step = await commit('model.finish', state => {
        guard()
        return planModelFinished(state, { runId: run.id, stepId, output, toolCallIds, assistantMessageId,
          toolsAvailable: !!options.tools && !options.legacyStrategy, at: new Date().toISOString() })
      })
      if (step.outcome === 'final') final = { stepId, attemptId, output: { content: step.output.content as readonly TextPart[] } }
      return structuredClone(step)
    } catch (cause) {
      const error = cause instanceof KernelFault ? cause : wrap('MODEL_FAILED', 'model execution failed', cause)
      await commit('model.failure', state => planModelFailed(state, {
        runId: run.id, stepId, error: error.error, cancelled: signal.aborted, at: new Date().toISOString(),
      }))
      throw error
    }
  }

  async function executeTools(stepId: string): Promise<readonly ToolCall[]> {
    guard()
    const data = await options.snapshot()
    const calls = toolBatch(data, run.id, stepId)
    // The entire batch and each individual dispatch still cross the live policy boundary.
    const authorize = (call: ToolCall) => {
      validateToolCall(run.basis, call)
      let decision: ReturnType<ToolPolicy['decide']>
      try { decision = options.toolPolicy.decide({ basis: structuredClone(run.basis), call: structuredClone(call) }) }
      catch (error) { throw wrap('INTERNAL', 'tool policy failed', error) }
      validateToolDecision(decision)
    }
    for (const call of calls) authorize(call)
    const results: ToolCall[] = []
    for (const call of calls) {
      guard()
      const started = await commit('tool.start', state => {
        guard()
        authorize(call)
        return planToolStarted(state, { runId: run.id, stepId, callId: call.id, at: new Date().toISOString() })
      })
      let outcome: ToolOutcome
      let stop: KernelFault | undefined
      let dispatched = false
      try {
        const raw = await perform(() => {
          dispatched = true
          return options.tools!.call(structuredClone(started))
        })
        outcome = normalizeToolOutcome(raw, run.basis.limits.maxToolResultBytes)
      } catch (cause) {
        stop = cause instanceof KernelFault ? cause : wrap('TOOL_FAILED', 'tool execution outcome is unknown', cause)
        outcome = unconfirmedToolOutcome(dispatched, stop.error)
      }
      // Save actual effects even after cancellation; never start another action afterward.
      const saved = await commit('tool.finish', state => planToolFinished(state, {
        runId: run.id, stepId, callId: call.id, outcome, messageId: randomUUID(), at: new Date().toISOString(),
      }))
      results.push(saved)
      if (stop) throw stop
      if (outcome.status === 'uncertain' || outcome.status === 'cancelled') throw fault('TOOL_FAILED', 'tool did not produce a confirmed outcome')
    }
    await commit('step.finish', state => planToolStepFinished(state, { runId: run.id, stepId, at: new Date().toISOString() }))
    return structuredClone(results)
  }

  const context: ExecutionContext = { signal, basis: structuredClone(run.basis),
    modelStep: () => action(modelStep),
    executeTools: request => {
      const stepId = request?.stepId
      return action(() => executeTools(stepId))
    } }
  return {
    async execute(): Promise<RuntimeResult> {
      try {
        const result = options.legacyStrategy
          ? { finalStepId: (await context.modelStep()).stepId }
          : await options.strategy.execute(context)
        if (busy || !final || result?.finalStepId !== final.stepId) {
          throw fault('CONFLICT', 'strategy must await a final model step')
        }
        guard()
        return structuredClone(final)
      } finally { sealed = true }
    },
    close() {
      if (closing) return closing
      sealed = true
      closing = Promise.resolve().then(async () => {
        // Runtime actions are tracked even if a strategy forgets to await one.
        try { await scope.dispose() } catch (error) { cleanupErrors.push(error) }
        await Promise.allSettled([...actions])
        throwCollected(cleanupErrors, 'runtime cleanup failed')
      })
      return closing
    },
  }
}

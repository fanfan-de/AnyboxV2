import { FiberState } from '@nya/core'
import { createApplication } from '@anybox/application'
import { createStateComponent, createMockModelComponent, createToolComponent, createHarnessComponent, createLocalTools } from '@anybox/agent-kernel'
import { KernelFault } from '@anybox/agent-contracts/api'
import type { AgentApi } from '@anybox/agent-contracts/api'
import type { AgentApplicationState } from '@anybox/agent-contracts'
import type { AgentApplication, AgentApplicationOptions } from './types.js'
import { createAgentComponent } from './components/agent/component.js'

/** Composition and effects live here; domain recovery remains a pure kernel transition. */
export function createAgentApplication(options: AgentApplicationOptions): AgentApplication {
  const definition = structuredClone(options.definition)
  const limits = structuredClone(options.limits)
  const strategies = { ...options.strategies }
  const stateFactory = options.state, modelFactory = options.model, toolsFactory = options.tools ?? (() => createLocalTools([]))
  if (typeof stateFactory !== 'function' || typeof modelFactory !== 'function' || typeof toolsFactory !== 'function') {
    throw new KernelFault({ code: 'INVALID_ARGUMENT', message: 'Agent provider factories are required' })
  }
  const base = createApplication(options)
  let state: AgentApplicationState = 'new'
  let startup: Promise<void> | undefined
  let shutdown: Promise<void> | undefined
  const closed = () => state === 'closing' || state === 'closed' || state === 'failed'
  const requireOpen = () => {
    if (closed()) throw new KernelFault({ code: 'CLOSED', message: 'Agent application is closed' })
  }
  const current = (): AgentApi => {
    requireOpen()
    if (state !== 'running') throw new KernelFault({ code: 'NOT_READY', message: 'Agent application is not ready' })
    const api = base.context.get<AgentApi>('agent.application')
    if (!api) throw new KernelFault({ code: 'NOT_READY', message: 'Agent application service is unavailable' })
    return api
  }
  const invoke = async <T>(operation: (api: AgentApi) => Promise<T>): Promise<T> => operation(current())
  const close = (): Promise<void> => {
    if (shutdown) return shutdown
    state = 'closing'
    shutdown = Promise.resolve().then(() => base.close()).then(() => { state = 'closed' }, error => {
      state = 'failed'; throw error
    })
    void shutdown.catch(() => {})
    return shutdown
  }
  return {
    context: base.context, failure: base.failure,
    configuration: { previewConfig: base.previewConfig, saveConfig: base.saveConfig, refreshConfig: base.refreshConfig, recover: base.recover },
    start() {
      try { requireOpen() } catch (error) { return Promise.reject(error) }
      if (startup) return startup
      state = 'starting'
      startup = Promise.resolve().then(async () => {
        await base.start(); requireOpen()
        for (const key of ['agent.state', 'agent.model', 'agent.tools', 'agent.kernel', 'agent.application']) {
          if (base.context.get(key)) throw new KernelFault({ code: 'CONFLICT', message: `service ${key} is already installed` })
        }
        const components = [
          base.context.installComponent(createStateComponent(stateFactory)),
          base.context.installComponent(createMockModelComponent(modelFactory)),
          base.context.installComponent(createToolComponent(toolsFactory)),
          base.context.installComponent(createHarnessComponent({ ...strategies, recovery: 'interrupt', requestScope: 'agent' }), limits),
          base.context.installComponent(createAgentComponent(definition)),
        ]
        await Promise.all(components)
        // Dependencies can begin as PENDING. Await again after asynchronous providers activate.
        for (const fiber of components) {
          await fiber; requireOpen()
          if (fiber.state !== FiberState.ACTIVE) throw fiber.error ?? new KernelFault({ code: 'NOT_READY', message: `component ${fiber.name} is ${fiber.state}` })
        }
        state = 'running'
      }).catch(async error => {
        const wasClosing = closed()
        try { await close() } catch (cleanupError) {
          state = 'failed'; throw new AggregateError([error, cleanupError], 'Agent startup and cleanup failed')
        }
        if (!wasClosing) state = 'failed'
        throw error
      })
      void startup.catch(() => {})
      return startup
    },
    close,
    status() {
      const api = state === 'running' ? base.context.get<AgentApi>('agent.application') : undefined
      try {
        const kernel = api?.describe()
        return { state, ready: state === 'running' && !!kernel?.ready, agent: kernel?.agent, kernel }
      } catch { return { state, ready: false } }
    },
    describe: () => current().describe(),
    sessions: {
      create: () => invoke(api => api.sessions.create()),
      list: request => invoke(api => api.sessions.list(request)),
      get: request => invoke(api => api.sessions.get(request)),
      messages: request => invoke(api => api.sessions.messages(request)),
    },
    tasks: {
      submit: request => invoke(api => api.tasks.submit(request)),
      list: request => invoke(api => api.tasks.list(request)),
      get: request => invoke(api => api.tasks.get(request)),
      inspect: request => invoke(api => api.tasks.inspect(request)),
      events: request => invoke(api => api.tasks.events(request)),
      cancel: request => invoke(api => api.tasks.cancel(request)),
      wait: request => invoke(api => api.tasks.wait(request)),
    },
  }
}

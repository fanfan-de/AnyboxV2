import { randomUUID } from 'node:crypto'
import { Context, FiberState } from '@nya/core'
import type { Fiber } from '@nya/core'
import type { RuntimeInputs } from './contracts.js'
import { createAgentComponent } from './agent/component.js'
import type { AgentDefinition } from './agent/domain.js'
import { agentPromptServiceKey, createAgentPromptComponent } from './agent/prompt-binding-component.js'
import type { AgentPromptPort } from './agent/prompt-binding-component.js'
import { createRunComponent, runServiceKey } from './run/component.js'
import type { RunPort } from './run/component.js'
import { createAgentLoopComponent } from './run/agent-loop-component.js'
import { createMemoryStateComponent } from './run/memory-state.js'
import { createSessionComponent, sessionServiceKey } from './run/session-component.js'
import type { SessionPort } from './run/session-component.js'
import { createPromptComponent, promptServiceKey } from './prompt/component.js'
import type { PromptPort } from './prompt/component.js'

/** The application root must provide the LLM API and local storage services before the Harness starts. */
export interface HarnessOptions extends Partial<RuntimeInputs> {
  readonly agents: readonly AgentDefinition[]
  /** Optional one-time import of the previous Prompt JSON store. The source is left untouched. */
  readonly legacyPromptStorePath?: string
  /** Host-provided authorization for changing an Agent's prompt bindings. */
  readonly canManageAgent?: (actorId: string, agentId: string) => boolean
}

export interface Harness extends RunPort, SessionPort, Omit<PromptPort, 'getPublishedVersion'>,
  Omit<AgentPromptPort, 'resolveRunPrompts'> {
  close(): Promise<void>
}

function requireActive(fiber: Fiber): void {
  if (fiber.state === FiberState.ACTIVE) return
  if (fiber.state === FiberState.FAILED) throw fiber.error
  const missing = fiber.inspect().dependencies.filter(item => item.status === 'blocked').map(item => item.serviceName)
  throw new Error(missing.length
    ? `component ${fiber.name} is waiting for ${missing.join(', ')}`
    : `component ${fiber.name} is ${fiber.state}`)
}

/** Installs the application services on one root. Each request obtains the current Nya service. */
export async function createHarness(context: Context, options: HarnessOptions): Promise<Harness> {
  if (!Context.is(context) || context.root !== context) throw new TypeError('application root Context required')
  const inputs: RuntimeInputs = {
    now: options.now ?? (() => new Date().toISOString()),
    newId: options.newId ?? randomUUID,
  }
  let closing = false
  let shutdown: Promise<void> | undefined
  const close = () => {
    if (shutdown) return shutdown
    closing = true
    shutdown = context.fiber.dispose()
    return shutdown
  }
  const current = (): RunPort => {
    if (closing) throw new Error('harness is closing')
    const service = context.get<RunPort>(runServiceKey)
    if (!service) throw new Error('run service is unavailable')
    return service
  }
  const currentSessions = (): SessionPort => {
    if (closing) throw new Error('harness is closing')
    const service = context.get<SessionPort>(sessionServiceKey)
    if (!service) throw new Error('session service is unavailable')
    return service
  }
  const currentPrompts = (): PromptPort => {
    if (closing) throw new Error('harness is closing')
    const service = context.get<PromptPort>(promptServiceKey)
    if (!service) throw new Error('prompt service is unavailable')
    return service
  }
  const currentAgentPrompts = (): AgentPromptPort => {
    if (closing) throw new Error('harness is closing')
    const service = context.get<AgentPromptPort>(agentPromptServiceKey)
    if (!service) throw new Error('agent prompt service is unavailable')
    return service
  }
  try {
    for (const component of [
      createAgentComponent(options.agents),
      createMemoryStateComponent(),
      createSessionComponent(inputs),
      createPromptComponent(inputs, options.legacyPromptStorePath),
      createAgentPromptComponent(inputs, options.canManageAgent ?? (() => true), options.legacyPromptStorePath),
      createAgentLoopComponent(inputs),
      createRunComponent(inputs, () => closing),
    ]) {
      const child = context.installComponent(component)
      await child
      requireActive(child)
    }
  } catch (error) {
    try { await close() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'harness startup and cleanup failed')
    }
    throw error
  }
  return {
    createSession: agentId => currentSessions().createSession(agentId),
    getSession: id => currentSessions().getSession(id),
    startRun: input => current().startRun(input),
    getRun: id => current().getRun(id),
    cancelRun: id => current().cancelRun(id),
    waitRun: id => current().waitRun(id),
    createPrompt: (actorId, input) => currentPrompts().createPrompt(actorId, input),
    editPrompt: (actorId, id, revision, patch) => currentPrompts().editPrompt(actorId, id, revision, patch),
    publishPrompt: (actorId, id) => currentPrompts().publishPrompt(actorId, id),
    getPrompt: (actorId, id) => currentPrompts().getPrompt(actorId, id),
    listPrompts: actorId => currentPrompts().listPrompts(actorId),
    getPromptVersions: (actorId, id) => currentPrompts().getPromptVersions(actorId, id),
    bindPrompt: (actorId, agentId, versionId) => currentAgentPrompts().bindPrompt(actorId, agentId, versionId),
    getAgentPrompts: (actorId, agentId) => currentAgentPrompts().getAgentPrompts(actorId, agentId),
    close,
  }
}

import { createHash } from 'node:crypto'
import type { Component } from '@nya/core'
import type { RuntimeInputs } from '../contracts.js'
import { promptServiceKey } from '../prompt/component.js'
import type { PromptPort } from '../prompt/component.js'
import { promptSnapshot } from '../prompt/domain.js'
import type { PromptBinding, PromptKind, PromptSnapshot, PromptVersion } from '../prompt/domain.js'
import { localStorageServiceKey } from '../storage/port.js'
import type { LocalStoragePort } from '../storage/port.js'
import { nonEmpty } from '../validation.js'
import { agentServiceKey } from './component.js'
import type { AgentPort } from './component.js'
import type { AgentDefinition } from './domain.js'
import { openAgentPromptBindings } from './prompt-binding-storage.js'

export const agentPromptServiceKey = 'harness.agent-prompts'

export interface AgentPromptPort {
  bindPrompt(actorId: string, agentId: string, versionId: string): Promise<PromptBinding>
  getAgentPrompts(actorId: string, agentId: string): readonly PromptSnapshot[]
  resolveRunPrompts(agentId: string): readonly PromptSnapshot[]
}

function defaultInstruction(agent: AgentDefinition): PromptVersion {
  return Object.freeze({
    id: `builtin:${agent.id}:${createHash('sha256').update(agent.instructions).digest('hex')}`,
    documentId: `builtin:${agent.id}`, ownerId: '__builtin__',
    kind: 'agent-instruction', role: 'system', content: agent.instructions,
    createdAt: '', createdBy: '__builtin__',
  })
}

/** Agent-owned selection of reusable published Prompt versions. */
export function createAgentPromptComponent(
  inputs: RuntimeInputs, canManageAgent: (actorId: string, agentId: string) => boolean,
  legacyJsonPath?: string,
): Component.Object<void, {
  [agentServiceKey]: AgentPort
  [promptServiceKey]: PromptPort
  [localStorageServiceKey]: LocalStoragePort
}> {
  return {
    name: 'harness-agent-prompts',
    inject: [agentServiceKey, promptServiceKey, localStorageServiceKey],
    async apply(ctx, _config, deps) {
      const agents = deps[agentServiceKey]
      const prompts = deps[promptServiceKey]
      const storage = await openAgentPromptBindings(deps[localStorageServiceKey], prompts, legacyJsonPath)
      ctx.effect(() => storage.close, 'join agent prompt binding operations')
      const defaults = new Map(agents.list().map(agent => [agent.id, defaultInstruction(agent)]))

      const requireAgent = (agentId: string): AgentDefinition => {
        const agent = agents.get(agentId)
        if (!agent) throw new Error(`unknown agent ${agentId}`)
        return agent
      }
      const manageAgent = (actorId: string, agentId: string) => {
        requireAgent(agentId)
        if (!canManageAgent(actorId, agentId)) throw new Error('agent configuration access denied')
      }
      const resolve = (agentId: string): readonly PromptSnapshot[] => {
        requireAgent(agentId)
        const selected = new Map<PromptKind, PromptVersion>()
        for (const binding of storage.get(agentId)) {
          const version = prompts.getPublishedVersion(binding.versionId)
          if (!version || version.kind !== binding.kind) {
            throw new Error(`bound prompt ${binding.versionId} is unavailable`)
          }
          selected.set(binding.kind, version)
        }
        if (!selected.has('agent-instruction')) {
          const fallback = defaults.get(agentId)
          if (!fallback) throw new Error(`default prompt for ${agentId} is unavailable`)
          selected.set('agent-instruction', fallback)
        }
        return Object.freeze((['agent-instruction', 'context', 'task-template'] as const)
          .flatMap(kind => { const version = selected.get(kind); return version ? [promptSnapshot(version)] : [] }))
      }

      const service: AgentPromptPort = {
        async bindPrompt(actorId, agentId, versionId) {
          const actor = nonEmpty(actorId, 'actorId')
          const target = nonEmpty(agentId, 'agentId')
          manageAgent(actor, target)
          const version = prompts.getPublishedVersion(versionId)
          if (!version || version.ownerId !== actor) throw new Error('prompt access denied')
          const binding = Object.freeze({
            kind: version.kind, versionId: version.id,
            updatedAt: nonEmpty(inputs.now(), 'timestamp'), updatedBy: actor,
          })
          await storage.bind(target, binding)
          return binding
        },
        getAgentPrompts(actorId, agentId) {
          const actor = nonEmpty(actorId, 'actorId')
          const target = nonEmpty(agentId, 'agentId')
          manageAgent(actor, target)
          return resolve(target)
        },
        resolveRunPrompts: resolve,
      }
      ctx.provide(agentPromptServiceKey, service)
    },
  }
}

import { createHash } from 'node:crypto'
import type { Component } from '@nya/core'
import type { RuntimeInputs } from '../contracts.js'
import { promptServiceKey } from '../prompt/component.js'
import type { PromptPort } from '../prompt/component.js'
import { promptSnapshot } from '../prompt/domain.js'
import type { PromptBinding, PromptKind, PromptSnapshot, PromptVersion } from '../prompt/domain.js'
import { nonEmpty } from '../validation.js'
import type { AgentRecord } from './domain.js'
import { agentDirectoryServiceKey } from './directory-component.js'
import type { AgentDirectoryPort } from './directory-component.js'

export const agentPromptServiceKey = 'personal-agent.agent-prompts'

export interface AgentPromptPort {
  bindPrompt(actorId: string, agentId: string, versionId: string): Promise<PromptBinding>
  getAgentPrompts(actorId: string, agentId: string): readonly PromptSnapshot[]
  resolveRunPrompts(agentId: string): readonly PromptSnapshot[]
  resolveInitialPrompts(agentId: string): readonly PromptSnapshot[]
  resolveTaskTemplate(agentId: string): PromptSnapshot | undefined
}

function defaultInstruction(agent: AgentRecord): PromptVersion {
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
): Component.Object<void, {
  [promptServiceKey]: PromptPort
  [agentDirectoryServiceKey]: AgentDirectoryPort
}> {
  return {
    name: 'personal-agent-agent-prompts',
    inject: [promptServiceKey, agentDirectoryServiceKey],
    apply(ctx, _config, deps) {
      const prompts = deps[promptServiceKey], directory = deps[agentDirectoryServiceKey]

      const requireAgent = (agentId: string): AgentRecord => {
        const agent = directory.get(agentId)
        if (!agent) throw new Error(`unknown agent ${agentId}`)
        return agent
      }
      const manageAgent = (actorId: string, agentId: string) => {
        requireAgent(agentId)
        if (!canManageAgent(actorId, agentId)) throw new Error('agent configuration access denied')
      }
      const resolve = (agentId: string, kinds: readonly PromptKind[] = ['agent-instruction', 'context', 'task-template']): readonly PromptSnapshot[] => {
        const agent = requireAgent(agentId)
        const selected = new Map<PromptKind, PromptVersion>()
        for (const binding of directory.getContextBindings(agentId)) {
          if (!kinds.includes(binding.kind)) continue
          const version = prompts.getPublishedVersion(binding.versionId)
          if (!version || version.kind !== binding.kind) {
            throw new Error(`bound prompt ${binding.versionId} is unavailable`)
          }
          selected.set(binding.kind, version)
        }
        if (kinds.includes('agent-instruction')) {
          const version = agent.instructionVersionId === null ? defaultInstruction(agent) : prompts.getPublishedVersion(agent.instructionVersionId)
          if (!version || version.kind !== 'agent-instruction') throw new Error(`agent instruction for ${agentId} is unavailable`)
          selected.set('agent-instruction', version)
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
          await directory.bindPrompt(target, binding)
          return binding
        },
        getAgentPrompts(actorId, agentId) {
          const actor = nonEmpty(actorId, 'actorId')
          const target = nonEmpty(agentId, 'agentId')
          manageAgent(actor, target)
          return resolve(target)
        },
        resolveRunPrompts: resolve,
        resolveInitialPrompts: agentId => resolve(agentId, ['agent-instruction', 'context']),
        resolveTaskTemplate: agentId => resolve(agentId, ['task-template'])[0],
      }
      ctx.provide(agentPromptServiceKey, service)
    },
  }
}

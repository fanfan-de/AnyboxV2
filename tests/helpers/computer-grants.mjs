import { environmentToolKey } from '@anybox/execution-environments/contracts'
import { computerToolTarget } from '@anybox/execution-environments/bindings'
import { computerToolEnvironmentVersion } from '../../packages/app-harness/dist/core/tool-environments/computer.js'

/** Fixtures use the same explicit, target-bound grants as an operator adding a Computer after startup. */
export async function grantComputerTools(root, api, attachmentIds, toolIds, agentId = 'assistant') {
  const grants = root.get('harness.execution-environments')
  const current = await grants.get(agentId)
  const tools = new Map(current.grants.map(({ tool }) => [environmentToolKey(tool), tool]))
  const attachments = await api.listUnitAttachments()
  const targets = new Set(attachments.filter(attachment => attachmentIds.includes(attachment.attachmentId))
    .map(attachment => computerToolTarget(attachment, computerToolEnvironmentVersion)))
  for (const tool of await api.environmentTools(agentId)) {
    if (tool.environmentId === 'computer' && targets.has(tool.targetId) && toolIds.includes(tool.toolId)) {
      tools.set(environmentToolKey(tool), tool)
    }
  }
  return grants.set({ agentId, expectedRevision: current.revision, requestId: 'test-computer-grants-' + current.revision, tools: [...tools.values()] })
}

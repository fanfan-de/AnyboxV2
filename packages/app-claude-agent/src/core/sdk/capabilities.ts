import type { AgentInfo, McpServerStatus, Query, SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import type { CapabilitiesView } from '../view.js'

const short = (value: string | undefined, limit = 2000) => (value ?? '').slice(0, limit)
/** Explicit projection: MCP configs, headers, environment variables and raw error messages never leave the adapter. */
export function capabilitiesView(commands: readonly SlashCommand[], agents: readonly AgentInfo[], servers: readonly McpServerStatus[], source: CapabilitiesView['source'], permissionMode: string): CapabilitiesView {
  return { schemaVersion: 1, source, permissionMode,
    skills: commands.slice(0, 500).map(item => ({ name: short(item.name, 256), description: short(item.description), argumentHint: short(item.argumentHint, 500), builtin: item.builtin === true })),
    agents: agents.slice(0, 200).map(item => ({ name: short(item.name, 256), description: short(item.description), model: item.model ? short(item.model, 256) : null })),
    mcp: servers.slice(0, 200).map(item => ({ name: short(item.name, 256), status: item.status, source: item.source ? short(item.source, 100) : item.scope ? short(item.scope, 100) : null,
      tools: (item.tools ?? []).slice(0, 500).map(tool => short(tool.name, 256)) })) }
}
export async function readCapabilities(running: Query, source: CapabilitiesView['source'], mode: string, refreshedSkills?: readonly SlashCommand[]): Promise<CapabilitiesView> {
  const [commands, agents, servers] = await Promise.all([running.supportedCommands(), running.supportedAgents(), running.mcpServerStatus()])
  return capabilitiesView(refreshedSkills ?? commands, agents, servers, source, mode)
}

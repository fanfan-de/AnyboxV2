import { isDeepStrictEqual } from 'node:util'
import type { ToolDefinition } from '@anybox/tool-api'
import { computerToolContracts as catalog, getToolById } from '@anybox/computer-tools/contracts'
import type { ToolCatalogEntry } from '@anybox/computer-tools/contracts'
export { listTools, getToolById, getToolByName, validateLibraryArguments } from '@anybox/computer-tools/contracts'
export type { LibraryToolName, ToolCatalogEntry } from '@anybox/computer-tools/contracts'
export interface ToolSelectionSnapshot {
  readonly schemaVersion: 1
  readonly tools: readonly Readonly<{ toolId: string; version: string; definition: ToolDefinition }>[]
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}
export const defaultToolIds: readonly string[] = freeze(['codex.exec_command', 'codex.write_stdin', 'codex.apply_patch', 'codex.view_image', 'claude-code.Read', 'claude-code.Write', 'claude-code.Edit', 'claude-code.Glob', 'claude-code.Grep'])
function snapshot(entries: readonly ToolCatalogEntry[]): ToolSelectionSnapshot {
  return freeze({ schemaVersion: 1, tools: entries.map(({ toolId, version, definition }) => ({ toolId, version, definition })) })
}
export const legacyToolSelection: ToolSelectionSnapshot = snapshot(catalog.filter(tool => ['anybox.bash', 'anybox.apply_patch'].includes(tool.toolId)))

/** Resolve the chosen catalog subset without silently changing the selected IDs. */
export function createToolSelection(toolIds: readonly string[] = defaultToolIds): ToolSelectionSnapshot {
  if (!Array.isArray(toolIds) || toolIds.some(id => typeof id !== 'string')) throw new TypeError('invalid tool selection')
  const chosen = new Set<string>()
  for (const id of toolIds) {
    const tool = getToolById(id)
    if (!tool?.selectable) throw new TypeError('unknown or retired tool')
    chosen.add(id)
  }
  if (catalog.some(tool => chosen.has(tool.toolId) && tool.dependencies.some(id => !chosen.has(id)))) throw new TypeError('missing tool dependency')
  return snapshot(catalog.filter(tool => chosen.has(tool.toolId)))
}
export function validateToolSelection(value: unknown): ToolSelectionSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid tool selection')
  const candidate = value as ToolSelectionSnapshot
  if (Object.keys(candidate).some(key => !['schemaVersion', 'tools'].includes(key)) || candidate.schemaVersion !== 1 || !Array.isArray(candidate.tools)) throw new TypeError('invalid tool selection')
  const ids = new Set<string>(), names = new Set<string>()
  const entries = candidate.tools.map(item => {
    if (!item || typeof item !== 'object' || Object.keys(item).some(key => !['toolId', 'version', 'definition'].includes(key))) throw new TypeError('invalid tool selection')
    const tool = getToolById(item.toolId)
    if (!tool || item.version !== tool.version || !isDeepStrictEqual(item.definition, tool.definition) || ids.has(item.toolId) || names.has(item.definition.name)) throw new TypeError('invalid tool selection')
    ids.add(item.toolId); names.add(item.definition.name)
    return tool
  })
  if (entries.some(tool => tool.dependencies.some(id => !ids.has(id)))) throw new TypeError('invalid tool selection dependencies')
  return snapshot(entries)
}

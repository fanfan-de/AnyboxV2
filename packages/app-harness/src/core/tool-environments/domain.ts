import type { ToolDefinition, ToolDescriptor } from '@anybox/tool-api'

export interface ToolEnvironmentSelection {
  readonly environmentId: string
  readonly version: string
  readonly tools: readonly ToolDescriptor[]
}

export interface ToolEnvironmentSnapshot {
  readonly schemaVersion: 1
  readonly environments: readonly ToolEnvironmentSelection[]
}

export const computerToolEnvironmentVersion = '1.0.0'

const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\0')
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key))

function json(value: unknown, depth = 0): boolean {
  if (depth > 64) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(item => json(item, depth + 1))
  return record(value) && Object.values(value).every(item => json(item, depth + 1))
}

function definition(value: unknown): value is ToolDefinition {
  return record(value) && keys(value, ['name', 'description', 'parameters']) && identity(value.name) &&
    (value.description === undefined || typeof value.description === 'string') && record(value.parameters) && json(value.parameters)
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** Structural history reader; availability and exact registered definitions are checked separately. */
export function parseToolEnvironmentSnapshot(value: unknown): ToolEnvironmentSnapshot {
  if (!record(value) || !keys(value, ['schemaVersion', 'environments']) || value.schemaVersion !== 1 || !Array.isArray(value.environments) || value.environments.length > 32) throw new TypeError('invalid tool environment snapshot')
  const ids = new Set<string>(), toolIds = new Set<string>(), names = new Set<string>()
  let count = 0
  for (const environment of value.environments) {
    if (!record(environment) || !keys(environment, ['environmentId', 'version', 'tools']) || !identity(environment.environmentId) || !identity(environment.version) || ids.has(environment.environmentId) || !Array.isArray(environment.tools)) throw new TypeError('invalid tool environment snapshot')
    ids.add(environment.environmentId)
    for (const tool of environment.tools) {
      if (++count > 256 || !record(tool) || !keys(tool, ['toolId', 'version', 'definition']) || !identity(tool.toolId) || !identity(tool.version) || !definition(tool.definition) || toolIds.has(tool.toolId) || names.has(tool.definition.name)) throw new TypeError('invalid tool environment tools')
      toolIds.add(tool.toolId); names.add(tool.definition.name)
    }
  }
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized, 'utf8') > 1_048_576) throw new TypeError('tool environment snapshot too large')
  return freeze(JSON.parse(serialized) as ToolEnvironmentSnapshot)
}

export function environmentForTool(snapshot: ToolEnvironmentSnapshot, name: string): ToolEnvironmentSelection | undefined {
  return snapshot.environments.find(environment => environment.tools.some(tool => tool.definition.name === name))
}

import type { ToolDefinition, ToolDescriptor } from '@anybox/tool-api'

export interface ToolEnvironmentSnapshotTool extends ToolDescriptor {
  /** Present for a tool selected from an exact target of a multi-target environment. */
  readonly targetId?: string
  /** A contextual target may expose a model alias while retaining its original provider contract. */
  readonly workspaceBindingId?: string
  readonly originalName?: string
}

export interface ToolEnvironmentSelection {
  readonly environmentId: string
  readonly version: string
  readonly tools: readonly ToolEnvironmentSnapshotTool[]
}

export interface ToolEnvironmentSnapshot {
  readonly schemaVersion: 1 | 2 | 3
  readonly environments: readonly ToolEnvironmentSelection[]
}

const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\0')
const targetIdentity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0')
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
  if (!record(value) || !keys(value, ['schemaVersion', 'environments']) || (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3) || !Array.isArray(value.environments) || value.environments.length > 32) throw new TypeError('invalid tool environment snapshot')
  const toolKeys = ['toolId', 'version', 'definition']
  if (value.schemaVersion !== 1) toolKeys.push('targetId')
  if (value.schemaVersion === 3) toolKeys.push('workspaceBindingId', 'originalName')
  const ids = new Set<string>(), toolIds = new Set<string>(), names = new Set<string>()
  let count = 0
  for (const environment of value.environments) {
    if (!record(environment) || !keys(environment, ['environmentId', 'version', 'tools']) || !identity(environment.environmentId) || !identity(environment.version) || ids.has(environment.environmentId) || !Array.isArray(environment.tools)) throw new TypeError('invalid tool environment snapshot')
    ids.add(environment.environmentId)
    for (const tool of environment.tools) {
      const scoped = record(tool) && tool.workspaceBindingId !== undefined
      if (++count > 256 || !record(tool) || !keys(tool, toolKeys) || !identity(tool.toolId) || !identity(tool.version) || !definition(tool.definition) || names.has(tool.definition.name) ||
        (Object.hasOwn(tool, 'targetId') && !(scoped ? targetIdentity(tool.targetId) : identity(tool.targetId)))) throw new TypeError('invalid tool environment tools')
      const aliased = tool.workspaceBindingId !== undefined || tool.originalName !== undefined
      if (aliased && (!identity(tool.workspaceBindingId) || !targetIdentity(tool.targetId) || !identity(tool.originalName) ||
        !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(tool.definition.name))) throw new TypeError('invalid scoped tool alias')
      const key = aliased ? JSON.stringify([environment.environmentId, tool.workspaceBindingId, tool.targetId, tool.toolId, tool.version]) : JSON.stringify(tool.toolId)
      if (toolIds.has(key)) throw new TypeError('duplicate tool environment identity')
      toolIds.add(key); names.add(tool.definition.name)
    }
  }
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized, 'utf8') > 1_048_576) throw new TypeError('tool environment snapshot too large')
  return freeze(JSON.parse(serialized) as ToolEnvironmentSnapshot)
}

export function environmentForTool(snapshot: ToolEnvironmentSnapshot, name: string): ToolEnvironmentSelection | undefined {
  return snapshot.environments.find(environment => environment.tools.some(tool => tool.definition.name === name))
}


/** The provider's contract determines grants and execution. Only the model projection carries an alias. */
export function originalToolDescriptor(tool: ToolEnvironmentSnapshotTool): ToolDescriptor {
  return { toolId: tool.toolId, version: tool.version,
    definition: tool.originalName === undefined ? tool.definition : { ...tool.definition, name: tool.originalName } }
}

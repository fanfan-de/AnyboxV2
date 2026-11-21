/** Non-secret, exact contract in a specific immutable provider binding. */
export interface EnvironmentTool {
  readonly environmentId: string
  readonly targetId: string
  readonly toolId: string
  readonly version: string
}

export interface EnvironmentGrant {
  readonly tool: EnvironmentTool
  /** The Agent revision when this exact permission was issued. Retained until revoked. */
  readonly generation: number
  readonly source?: 'trusted-configuration' | 'operator'
}

export interface AgentGrants {
  readonly agentId: string
  readonly revision: number
  readonly grants: readonly EnvironmentGrant[]
}

export interface SetGrantsInput {
  readonly agentId: string
  readonly expectedRevision: number
  readonly requestId: string
  readonly tools: readonly EnvironmentTool[]
}

export interface GrantChange {
  readonly requestId: string
  readonly agentId: string
  readonly revision: number
  readonly state: 'draining' | 'completed' | 'exit-unknown'
  readonly affectedCount: number
  readonly pendingCount: number
  readonly unknownCount: number
}

export function environmentError(code: string, status: number) {
  return Object.assign(new Error(code), { code, status })
}

export function checkedId(value: unknown, limit = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > limit) {
    throw environmentError('invalid-environment-input', 400)
  }
  return value
}

export function validateEnvironmentTool(value: unknown): EnvironmentTool {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw environmentError('invalid-environment-input', 400)
  const tool = value as Record<string, unknown>
  if (Object.keys(tool).length !== 4) throw environmentError('invalid-environment-input', 400)
  return Object.freeze({ environmentId: checkedId(tool.environmentId), targetId: checkedId(tool.targetId, 4096),
    toolId: checkedId(tool.toolId), version: checkedId(tool.version, 1024) })
}

export function environmentToolKey(tool: EnvironmentTool): string {
  return JSON.stringify([tool.environmentId, tool.targetId, tool.toolId, tool.version])
}

export function checkedTools(values: readonly EnvironmentTool[]): readonly EnvironmentTool[] {
  if (!Array.isArray(values) || values.length > 1024) throw environmentError('invalid-environment-input', 400)
  const byKey = new Map<string, EnvironmentTool>()
  for (const value of values) {
    const tool = validateEnvironmentTool(value)
    const key = environmentToolKey(tool)
    if (byKey.has(key)) throw environmentError('invalid-environment-input', 400)
    byKey.set(key, tool)
  }
  // Sort by code unit, independent of machine locale, for stable request idempotency.
  return [...byKey.keys()].sort().map(key => byKey.get(key)!)
}

export function exactGrantKey(grant: EnvironmentGrant): string {
  return JSON.stringify([environmentToolKey(grant.tool), grant.generation])
}

export function validateEnvironmentGrants(values: readonly EnvironmentGrant[]): readonly EnvironmentGrant[] {
  if (!Array.isArray(values) || values.length > 1024) throw environmentError('invalid-environment-input', 400)
  const keys = new Set<string>()
  return Object.freeze(values.map(grant => {
    if (!grant || !Number.isSafeInteger(grant.generation) || grant.generation < 1) throw environmentError('invalid-environment-input', 400)
    const tool = validateEnvironmentTool(grant.tool)
    const key = environmentToolKey(tool)
    if (keys.has(key)) throw environmentError('invalid-environment-input', 400)
    keys.add(key)
    if (grant.source !== undefined && grant.source !== 'trusted-configuration' && grant.source !== 'operator') throw environmentError('invalid-environment-input', 400)
    return Object.freeze({ tool, generation: grant.generation, ...(grant.source ? { source: grant.source } : {}) })
  }))
}

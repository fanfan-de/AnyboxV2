import { claudeAgentError } from './domain.js'

/** Application-owned permission data. Native matching remains entirely in the Claude adapter/CLI. */
export interface SessionPermissionSpec {
  readonly allow: readonly { readonly tool: string; readonly pattern: string | null }[]
  readonly directories: readonly string[]
}
export const emptySessionPermissions = (): SessionPermissionSpec => ({ allow: [], directories: [] })
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export function validateSessionPermissions(raw: unknown): SessionPermissionSpec {
  if (!record(raw) || Object.keys(raw).some(key => !['allow', 'directories'].includes(key)) || !Array.isArray(raw.allow) || !Array.isArray(raw.directories) || raw.allow.length > 500 || raw.directories.length > 200) throw claudeAgentError('permissions-invalid', 400)
  const allow = raw.allow.map(item => {
    if (!record(item) || Object.keys(item).some(key => !['tool', 'pattern'].includes(key)) || typeof item.tool !== 'string' || !/^[A-Za-z0-9_.:@+*-]{1,200}$/.test(item.tool) || !(item.pattern === null || typeof item.pattern === 'string' && item.pattern.length <= 4000 && !/[\x00-\x1f]/.test(item.pattern))) throw claudeAgentError('permissions-invalid', 400)
    return { tool: item.tool, pattern: item.pattern as string | null }
  })
  const directories = raw.directories.map(path => {
    if (typeof path !== 'string' || !path.length || path.length > 4096 || /[\x00-\x1f]/.test(path) || !(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path))) throw claudeAgentError('permissions-invalid', 400)
    return path
  })
  const result = { allow, directories }
  if (JSON.stringify(result).length > 128 * 1024) throw claudeAgentError('permissions-limit', 409)
  return result
}
export function mergeSessionPermissions(specs: readonly SessionPermissionSpec[]): SessionPermissionSpec {
  const rules = new Map<string, SessionPermissionSpec['allow'][number]>(), directories = new Set<string>()
  for (const spec of specs) {
    for (const rule of validateSessionPermissions(spec).allow) rules.set(JSON.stringify(rule), rule)
    for (const path of spec.directories) directories.add(path)
  }
  return validateSessionPermissions({ allow: [...rules.values()], directories: [...directories] })
}
export const permissionRuleLabels = (spec: SessionPermissionSpec): readonly string[] => [
  ...spec.allow.map(rule => `${rule.tool}${rule.pattern === null ? '（全部调用）' : `(${rule.pattern})`}`), ...spec.directories.map(path => `额外目录：${path}`),
]

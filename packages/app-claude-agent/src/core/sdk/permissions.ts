import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import { validateSessionPermissions } from '../permissions.js'
import type { SessionPermissionSpec } from '../permissions.js'

/** Only additive allow rules/directories can be replayed without changing another policy or a permission mode. */
export function reusablePermissions(suggestions: readonly PermissionUpdate[] | undefined): SessionPermissionSpec | undefined {
  if (!suggestions?.length) return undefined
  const allow: { tool: string; pattern: string | null }[] = [], directories: string[] = []
  for (const suggestion of suggestions) {
    if (suggestion.type === 'addRules' && suggestion.behavior === 'allow') allow.push(...suggestion.rules.map(rule => ({ tool: rule.toolName, pattern: rule.ruleContent ?? null })))
    else if (suggestion.type === 'addDirectories') directories.push(...suggestion.directories)
    else return undefined
  }
  if (!allow.length && !directories.length) return undefined
  try { return validateSessionPermissions({ allow, directories }) } catch { return undefined }
}
export function nativeSessionPermissions(spec: SessionPermissionSpec | undefined): { allowedTools: string[]; additionalDirectories?: string[] } {
  const valid = validateSessionPermissions(spec ?? { allow: [], directories: [] })
  return { allowedTools: valid.allow.map(rule => rule.pattern === null ? rule.tool : `${rule.tool}(${rule.pattern})`), ...(valid.directories.length ? { additionalDirectories: [...valid.directories] } : {}) }
}

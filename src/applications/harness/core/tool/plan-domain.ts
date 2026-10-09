import type { JsonValue } from '@anybox/models'

/** Full-list planning contracts produce durable observations, not background tasks. */
export function updateToolPlan(name: string, args: Readonly<Record<string, JsonValue>>): JsonValue {
  const items = name === 'codex_update_plan' ? args.plan : args.todos
  if (!Array.isArray(items) || items.length > 256) throw new TypeError('invalid plan')
  if (items.filter(item => item && typeof item === 'object' && !Array.isArray(item) && item.status === 'in_progress').length > 1) {
    throw new TypeError('at most one plan item may be in_progress')
  }
  return name === 'codex_update_plan'
    ? { status: 'updated', plan: items, ...(args.explanation === undefined ? {} : { explanation: args.explanation }) }
    : { status: 'updated', todos: items }
}

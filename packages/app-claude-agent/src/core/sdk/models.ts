import { claudeAgentError, validModelIdentifier } from '../domain.js'
import { claudeAgentEfforts } from '../view.js'
import type { AvailableModelView, AvailableModelsView, ClaudeAgentEffort } from '../view.js'

const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit && !value.includes('\0')
/** Keep only fields the UI consumes. Never pass initialization/account objects across the SDK boundary. */
export function availableModelsView(raw: unknown): AvailableModelsView {
  if (!Array.isArray(raw) || raw.length > 200) throw claudeAgentError('models-too-large', 413)
  const seen = new Set<string>(), models: AvailableModelView[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || !text(entry.value, 100) || !validModelIdentifier(entry.value)
      || !text(entry.displayName, 200) || !entry.displayName.trim() || !text(entry.description, 4000)
      || (entry.resolvedModel !== undefined && (!text(entry.resolvedModel, 100) || !validModelIdentifier(entry.resolvedModel)))
      || (entry.supportsEffort !== undefined && typeof entry.supportsEffort !== 'boolean')
      || (entry.supportedEffortLevels !== undefined && (!Array.isArray(entry.supportedEffortLevels) || entry.supportedEffortLevels.length > claudeAgentEfforts.length
        || entry.supportedEffortLevels.some((level: unknown) => !claudeAgentEfforts.includes(level as ClaudeAgentEffort))))) throw claudeAgentError('models-unavailable', 503, 'Claude returned an invalid model list.')
    if (seen.has(entry.value)) continue
    seen.add(entry.value)
    models.push(Object.freeze({ value: entry.value, displayName: entry.displayName, description: entry.description,
      ...(entry.resolvedModel === undefined ? {} : { resolvedModel: entry.resolvedModel }),
      ...(entry.supportsEffort === undefined ? {} : { supportsEffort: entry.supportsEffort }),
      ...(entry.supportedEffortLevels === undefined ? {} : { supportedEffortLevels: Object.freeze([...new Set<ClaudeAgentEffort>(entry.supportedEffortLevels)]) }) }))
  }
  return Object.freeze({ schemaVersion: 1, models: Object.freeze(models) })
}

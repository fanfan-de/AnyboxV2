import { identifier, identity, identityKey, receipt, revision } from './domain.js'
import { packageRegistryFailure as fail } from './port.js'
import type { PackageActivation, PackageActivationPhase, PackageActivationRolePlan, PackageCatalogSnapshot } from './port.js'

export const activationPhases: readonly PackageActivationPhase[] = ['prepared', 'handoff', 'loading', 'reclaiming', 'completed', 'recovery-required', 'cancelled']
export const terminalActivation = (phase: PackageActivationPhase): boolean => phase === 'completed' || phase === 'cancelled'
export function activationErrorCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) throw fail('invalid-input')
  return value
}
const frozen = <T>(value: T): T => {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value) }
  return value
}
const at = (value: unknown): string => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw fail('invalid-input')
  return value
}
const strings = (value: unknown, maximum = 10_000): readonly string[] => {
  if (!Array.isArray(value) || value.length > maximum) throw fail('invalid-input')
  const result = value.map(identifier)
  if (new Set(result).size !== result.length) throw fail('invalid-input')
  return result
}
export type ActivationSnapshotParser = (input: Pick<PackageCatalogSnapshot, 'role' | 'entries' | 'capabilities'>) => Pick<PackageCatalogSnapshot, 'role' | 'entries' | 'capabilities'>
export function activationPlans(input: readonly PackageActivationRolePlan[], parse: ActivationSnapshotParser) {
  if (!Array.isArray(input) || !input.length || input.length > 4) throw fail('invalid-input')
  const result = input.map(item => {
    const role = parse({ role: item.role, entries: item.entries, capabilities: item.capabilities ?? [] })
    return frozen({ ...role, entries: [...role.entries].sort((a, b) => a.package.appId.localeCompare(b.package.appId)), capabilities: [...role.capabilities].sort((a, b) => a.id.localeCompare(b.id)) })
  }).sort((a, b) => a.role.localeCompare(b.role))
  if (new Set(result.map(item => item.role)).size !== result.length) throw fail('invalid-input')
  return frozen(result)
}
/** Persisted shape validation is independent of process/FS effects. Cross references are checked by the registry. */
export function parseActivation(raw: unknown, parse: ActivationSnapshotParser): PackageActivation {
  const item = raw as PackageActivation
  const kind = item?.kind === undefined ? 'activate' : item.kind
  if (!['activate', 'remove'].includes(kind)) throw fail('invalid-input')
  if (!item || !activationPhases.includes(item.phase) || !Array.isArray(item.targets) || !item.targets.length || item.targets.length > 10_000 || !Array.isArray(item.roles) || !item.roles.length || item.roles.length > 4) throw fail('invalid-input')
  const targets = item.targets.map(target => frozen({ identity: identity(target.identity), previousSelected: target.previousSelected === null ? null : identity(target.previousSelected), operationId: identifier(target.operationId) }))
  if (new Set(targets.map(target => kind === 'remove' ? identityKey(target.identity) : target.identity.appId)).size !== targets.length || targets.some(target => target.previousSelected && target.previousSelected.appId !== target.identity.appId)) throw fail('invalid-input')
  const previous = new Map<string, string>()
  for (const target of targets) {
    const key = target.previousSelected === null ? 'null' : identityKey(target.previousSelected), prior = previous.get(target.identity.appId)
    if (prior !== undefined && prior !== key) throw fail('invalid-input')
    previous.set(target.identity.appId, key)
  }
  const roles = item.roles.map(role => {
    const selected = parse(role), usageIds = strings(role.usageIds)
    const handoffUsageId = role.handoffUsageId === null ? null : identifier(role.handoffUsageId), readyUsageId = role.readyUsageId === null ? null : identifier(role.readyUsageId)
    if (readyUsageId !== null && !usageIds.includes(readyUsageId) || handoffUsageId !== null && !usageIds.includes(handoffUsageId)) throw fail('invalid-input')
    return frozen({ ...selected, handoffUsageId, usageIds, readyUsageId })
  })
  if (new Set(roles.map(role => role.role)).size !== roles.length) throw fail('invalid-input')
  if (new Set(roles.flatMap(role => role.usageIds)).size !== roles.reduce((sum, role) => sum + role.usageIds.length, 0) ||
      (item.phase === 'prepared' || item.phase === 'cancelled') && roles.some(role => role.handoffUsageId !== null || role.usageIds.length !== 0 || role.readyUsageId !== null) ||
      ['handoff', 'loading', 'reclaiming', 'completed'].includes(item.phase) && roles.some(role => role.handoffUsageId === null) ||
      item.phase === 'reclaiming' && kind !== 'remove' ||
      (item.phase === 'completed' || item.phase === 'reclaiming') && roles.some(role => role.readyUsageId === null)) throw fail('invalid-input')
  const recovery = item.recovery === null ? null : { from: item.recovery.from, reason: item.recovery.reason }
  if (kind === 'activate' && recovery?.from === 'reclaiming' || item.phase === 'recovery-required' && !recovery || item.phase !== 'recovery-required' && recovery || recovery && (!activationPhases.includes(recovery.from) || !['owner-restarted', 'outcome-unconfirmed'].includes(recovery.reason))) throw fail('invalid-input')
  return frozen({ kind, id: identifier(item.id), requestId: identifier(item.requestId), revision: revision(item.revision), registryRevision: revision(item.registryRevision), ownerEpoch: revision(item.ownerEpoch), phase: item.phase, targets, roles, supersededUsageIds: strings(item.supersededUsageIds), ownedUsageIds: strings(item.ownedUsageIds === undefined ? [] : item.ownedUsageIds), receipt: receipt(item.receipt), errorCode: item.errorCode === null ? null : activationErrorCode(item.errorCode), recovery, createdAt: at(item.createdAt), updatedAt: at(item.updatedAt) })
}

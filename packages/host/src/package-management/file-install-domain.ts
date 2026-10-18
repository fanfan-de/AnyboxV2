import { identifier, identity, receipt, revision } from './domain.js'
import { packageRegistryFailure as fail } from './port.js'
import type { PackageFileInstall, PackageFileInstallIntent, PackageFileInstallPhase } from './port.js'

export const fileInstallPhases: readonly PackageFileInstallPhase[] = ['accepted', 'receiving', 'verifying', 'prepared', 'committing', 'installed', 'failed', 'cancelled', 'recovery-required']
const member = <T extends string>(values: readonly T[], value: unknown): T => { if (!values.includes(value as T)) throw fail('invalid-input'); return value as T }
const timestamp = (input: unknown): string => { if (typeof input !== 'string' || input.length > 128 || !Number.isFinite(Date.parse(input))) throw fail('invalid-input'); return input }
export const terminalFileInstall = (phase: PackageFileInstallPhase): boolean => phase === 'installed' || phase === 'failed' || phase === 'cancelled'
export function fileInstallIntent(input: PackageFileInstallIntent): Required<PackageFileInstallIntent> {
  const sourceFormat = input.sourceFormat === undefined ? 'archive' : member(['archive', 'directory'], input.sourceFormat)
  const localTrust = input.localTrust === undefined ? false : input.localTrust
  if (typeof localTrust !== 'boolean' || localTrust && sourceFormat !== 'directory') throw fail('invalid-input')
  if (typeof input.filename !== 'string' || !input.filename.trim() || input.filename.length > 255 || /[\\/\0]/.test(input.filename) || input.filename === '.' || input.filename === '..' ||
      typeof input.archiveDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.archiveDigest) || !Number.isSafeInteger(input.archiveSize) || input.archiveSize <= 0) throw fail('invalid-input')
  return Object.freeze({ requestId: identifier(input.requestId), filename: input.filename, sourceFormat, localTrust, archiveDigest: input.archiveDigest, archiveSize: input.archiveSize, expectedAppRevision: input.expectedAppRevision === undefined ? -1 : revision(input.expectedAppRevision) })
}
export function fileInstallErrorCode(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) throw fail('invalid-input')
  return value
}
export function parseFileInstall(raw: unknown): PackageFileInstall {
  const item = raw as PackageFileInstall
  const intent = fileInstallIntent({ ...item, expectedAppRevision: item.expectedAppRevision === null ? undefined : item.expectedAppRevision })
  if (typeof item.existingInstallation !== 'boolean' || !Array.isArray(item.workGuardIds) || item.workGuardIds.length > 10_000 || new Set(item.workGuardIds).size !== item.workGuardIds.length) throw fail('invalid-input')
  const result: PackageFileInstall = { ...intent, id: identifier(item.id), expectedAppRevision: intent.expectedAppRevision < 0 ? null : intent.expectedAppRevision,
    revision: revision(item.revision), phase: member(fileInstallPhases, item.phase), identity: item.identity === null ? null : identity(item.identity), operationId: item.operationId === null ? null : identifier(item.operationId),
    existingInstallation: item.existingInstallation, workGuardIds: Object.freeze(item.workGuardIds.map(fileInstallGuardId)), receipt: receipt(item.receipt), errorCode: fileInstallErrorCode(item.errorCode),
    recovery: item.recovery === null ? null : Object.freeze({ from: member(fileInstallPhases, item.recovery?.from), reason: member(['owner-restarted', 'outcome-unconfirmed'], item.recovery?.reason) }),
    createdAt: timestamp(item.createdAt), updatedAt: timestamp(item.updatedAt) }
  if ((result.identity === null) !== (result.operationId === null) || result.existingInstallation && result.identity === null ||
      ['accepted', 'receiving'].includes(result.phase) && result.identity !== null || ['prepared', 'committing', 'installed'].includes(result.phase) && result.identity === null ||
      (result.phase === 'recovery-required') !== (result.recovery !== null)) throw fail('invalid-input')
  return Object.freeze(result)
}
export function fileInstallGuardId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw fail('invalid-input')
  return value
}
const transitions: Readonly<Record<PackageFileInstallPhase, readonly PackageFileInstallPhase[]>> = {
  accepted: ['receiving', 'failed', 'cancelled', 'recovery-required'],
  receiving: ['verifying', 'failed', 'cancelled', 'recovery-required'],
  verifying: ['prepared', 'failed', 'cancelled', 'recovery-required'],
  prepared: ['committing', 'installed', 'failed', 'cancelled', 'recovery-required'],
  committing: ['recovery-required'], installed: [], failed: [], cancelled: [], 'recovery-required': [],
}
export function assertFileInstallTransition(from: PackageFileInstallPhase, to: PackageFileInstallPhase): void {
  if (!Object.hasOwn(transitions, from) || !transitions[from].includes(to)) throw fail('transition-invalid')
}

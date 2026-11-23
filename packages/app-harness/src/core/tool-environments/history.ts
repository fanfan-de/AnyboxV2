import type { JsonValue } from '@anybox/tool-api'
import type { RunEnvironmentAccess } from '@anybox/execution-environments/bindings'
import type { RunOperationStart, SavedRunOperation, SessionRunPort } from '../session/port.js'
import { legacyToolSelection } from '../tool/catalog.js'
import type { ToolSelectionSnapshot } from '../tool/catalog.js'
import { computerToolEnvironmentId, computerToolEnvironmentVersion } from './computer.js'
import { parseToolEnvironmentSnapshot } from './domain.js'
import type { ToolEnvironmentSnapshot } from './domain.js'

/** Old initialization formats keep their exact declarations, including retired plan tools. */
export function legacyToolEnvironmentSnapshot(initialization: { readonly schemaVersion: number; readonly toolSelection?: ToolSelectionSnapshot }): ToolEnvironmentSnapshot {
  const selection = initialization.schemaVersion >= 2 && initialization.toolSelection ? initialization.toolSelection : legacyToolSelection
  return parseToolEnvironmentSnapshot({ schemaVersion: 1, environments: [{ environmentId: computerToolEnvironmentId, version: computerToolEnvironmentVersion, tools: selection.tools }] })
}

/** Older Runs can only recover the original Computer and the grants imported at cutover. */
export function canBindLegacyComputerAccess(access: RunEnvironmentAccess, originalTargetProven: boolean): boolean {
  return !access.search && (access.functions.length === 0 || originalTargetProven && access.functions.every(({ grant }) =>
    grant.tool.environmentId === computerToolEnvironmentId && grant.generation === 1 && grant.source === 'trusted-configuration'))
}

function object(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, JsonValue>> : undefined
}

export function computerCleanupTargets(value: JsonValue | undefined): readonly {
  readonly targetId?: string; readonly receipt: Readonly<Record<string, JsonValue>>
}[] {
  const report = object(value)
  if (!report) return []
  if (!Array.isArray(report.environments)) return Array.isArray(report.processes) ? [{ receipt: report }] : []
  return report.environments.flatMap(item => {
    const entry = object(item)
    const receipt = entry?.environmentId === 'computer' && object(entry.result)
    return receipt && Array.isArray(receipt.processes) ? [{ receipt, ...(typeof entry.targetId === 'string' ? { targetId: entry.targetId } : {}) }] : []
  })
}

export function computerCleanupReceipts(value: JsonValue | undefined): readonly Readonly<Record<string, JsonValue>>[] {
  return computerCleanupTargets(value).map(target => target.receipt)
}

/** The historical single-Computer receipt is only meaningful for an unambiguous target. */
export function computerCleanupReceipt(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined {
  const report = object(value)
  if (Array.isArray(report?.environments) && report.environments.filter(item => object(item)?.environmentId === 'computer').length !== 1) return undefined
  return computerCleanupReceipts(value)[0]
}

export interface EnvironmentCleanupOperation {
  readonly start: RunOperationStart
  readonly prior?: SavedRunOperation
  /** A historical Computer-only operation persisted its provider receipt without an envelope. */
  readonly legacyComputerReceipt: boolean
}

export function newEnvironmentCleanup(runId: string): EnvironmentCleanupOperation {
  return { start: { id: `${runId}:tool-environment-scope-close`, kind: 'operation', cleanup: true, intent: { kind: 'tool-environment-cleanup' } }, legacyComputerReceipt: false }
}

/** Keep the original operation identity and intent when an older Runtime lost its acknowledgement. */
export async function resolveEnvironmentCleanup(records: Pick<SessionRunPort, 'getRunOperation'>, runId: string, resuming: boolean): Promise<EnvironmentCleanupOperation> {
  const id = `${runId}:tool-environment-scope-close`
  const current = await records.getRunOperation(runId, id)
  if (current) return { start: current.start, prior: current, legacyComputerReceipt: false }
  if (resuming) {
    const historical = await records.getRunOperation(runId, `${runId}:computer-scope-close`)
    if (historical) return { start: historical.start, prior: historical, legacyComputerReceipt: true }
  }
  return newEnvironmentCleanup(runId)
}

/** New writes retain the uniform report; unfinished legacy operations retain their old representation. */
export function environmentCleanupObservationResult(report: JsonValue, operation: EnvironmentCleanupOperation): JsonValue {
  if (!operation.legacyComputerReceipt) return report
  const receipt = computerCleanupReceipt(report)
  if (!receipt) throw new TypeError('historical Computer cleanup receipt is unavailable')
  return receipt
}

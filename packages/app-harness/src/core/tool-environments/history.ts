import type { JsonValue } from '@anybox/tool-api'
import type { RunOperationStart, SavedRunOperation, SessionRunPort } from '../session/port.js'
import { legacyToolSelection } from '../tool/catalog.js'
import type { ToolSelectionSnapshot } from '../tool/catalog.js'
import { computerToolEnvironmentVersion } from './computer.js'
import { parseToolEnvironmentSnapshot } from './domain.js'
import type { ToolEnvironmentSnapshot } from './domain.js'

/** Old initialization formats keep their exact declarations, including retired plan tools. */
export function legacyToolEnvironmentSnapshot(initialization: { readonly schemaVersion: number; readonly toolSelection?: ToolSelectionSnapshot }): ToolEnvironmentSnapshot {
  const selection = initialization.schemaVersion >= 2 && initialization.toolSelection ? initialization.toolSelection : legacyToolSelection
  return parseToolEnvironmentSnapshot({ schemaVersion: 1, environments: [{ environmentId: 'computer', version: computerToolEnvironmentVersion, tools: selection.tools }] })
}

function object(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, JsonValue>> : undefined
}

/** Read old Computer receipts and the Computer member of a uniform environment report. */
export function computerCleanupReceipt(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined {
  const report = object(value)
  if (!report) return undefined
  if (Array.isArray(report.environments)) {
    const computers = report.environments.map(object).filter(entry => entry?.environmentId === 'computer')
    if (computers.length !== 1) return undefined
    const receipt = object(computers[0]!.result)
    return receipt && Array.isArray(receipt.processes) ? receipt : undefined
  }
  return Array.isArray(report.processes) ? report : undefined
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

import { validateSnapshotIds } from '../project-files/domain.js'
import type { FileRef } from '../project-files/domain.js'
/** Harness domain values and transitions are independent of Nya and providers. */
import type { NativeModelSnapshot } from '@anybox/models'
import type { LegacyExecutionSnapshot } from './legacy-snapshot.js'
import type { ProtocolBindingSnapshot, NativeRunInput, NativeInitialization, ProtocolRecord } from './program.js'
import type { ModelFailureCategory } from './model.js'
import type { BashResult } from '../tool/bash-component.js'
import type { ApplyPatchResult } from '../tool/apply-patch-types.js'
import { nonEmpty } from '../validation.js'
import type { ImageRef } from '../image/port.js'
import { imageLimits } from '../image/limits.js'

export type RunHistory =
  | { readonly kind: 'tree'; readonly parentNodeId: string | null }
  | { readonly kind: 'legacy-unknown' }

export interface RunQuery { readonly active?: boolean; readonly parentNodeId?: string | null }

export type RunStatus = 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed' | 'interrupted'

export type RunFailureCategory = ModelFailureCategory |
  'invalid-tool-request' | 'limit-exceeded' | 'tool-unavailable' | 'tool-timeout' | 'tool-cancelled' | 'tool-cleanup-failure' | 'state-write-failure'

export class RunFailure extends Error {
  constructor(readonly category: Exclude<RunFailureCategory, ModelFailureCategory>) {
    super({
      'invalid-tool-request': 'model tool request is invalid',
      'limit-exceeded': 'run limit was exceeded',
      'tool-unavailable': 'tool is unavailable',
      'tool-timeout': 'tool call timed out',
      'tool-cancelled': 'tool call was cancelled',
      'tool-cleanup-failure': 'tool cleanup failed',
      'state-write-failure': 'run state could not be persisted',
    }[category])
    this.name = 'RunFailure'
  }
}

export const runLimits = Object.freeze({
  finalBytes: 65_536,
  totalToolOutputBytes: 131_072,
})

export type ValidatedToolRequest =
  | (Readonly<{ id: string }> & { readonly name: 'bash'; readonly arguments: Readonly<{ command: string }> })
  | (Readonly<{ id: string }> & { readonly name: 'apply_patch'; readonly arguments: Readonly<{ patch: string }> })

export type ToolObservation =
  | { readonly name: 'bash'; readonly result: BashResult }
  | { readonly name: 'apply_patch'; readonly result: ApplyPatchResult }

/** Validate the complete batch envelope before acquiring any tool resource.
 * Patch syntax is an execution observation so the model can correct it. */
export function validateToolBatch(calls: unknown): readonly ValidatedToolRequest[] {
  if (!Array.isArray(calls) || calls.length === 0) throw new RunFailure('invalid-tool-request')
  const ids = new Set<string>()
  return Object.freeze(calls.map((call: unknown): ValidatedToolRequest => {
    if (!call || typeof call !== 'object' || Array.isArray(call) ||
      !('id' in call) || typeof call.id !== 'string' || !call.id.trim() || call.id.length > 256 ||
      ids.has(call.id) || !('name' in call) || !('arguments' in call) ||
      !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments) ||
      Object.keys(call.arguments).length !== 1) throw new RunFailure('invalid-tool-request')
    ids.add(call.id)
    if (call.name === 'bash' && 'command' in call.arguments && typeof call.arguments.command === 'string' &&
      call.arguments.command.trim() && !call.arguments.command.includes('\0')) {
      return Object.freeze({ id: call.id, name: 'bash', arguments: Object.freeze({ command: call.arguments.command }) })
    }
    if (call.name === 'apply_patch' && 'patch' in call.arguments && typeof call.arguments.patch === 'string') {
      return Object.freeze({ id: call.id, name: 'apply_patch', arguments: Object.freeze({ patch: call.arguments.patch }) })
    }
    throw new RunFailure('invalid-tool-request')
  }))
}

export function toolOutputBytes(observation: ToolObservation): number {
  return observation.name === 'bash'
    ? Buffer.byteLength(observation.result.stdout, 'utf8') + Buffer.byteLength(observation.result.stderr, 'utf8')
    : Buffer.byteLength(JSON.stringify(observation.result), 'utf8')
}

export interface Run {
  readonly id: string
  readonly sessionId: string
  readonly input: string
  readonly images: readonly ImageRef[]
  readonly files: readonly FileRef[]
  readonly idempotencyKey: string
  readonly status: RunStatus
  readonly history: RunHistory
  readonly contextVersion: 'dialogue-v1' | 'native-local-v1' | null
  readonly resultNodeId?: string
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly promptVersionIds: readonly string[]
  readonly modelId: string | null
  /** The caller's explicit selection; null means Session/Agent defaults were resolved. */
  readonly requestedModelId: string | null
  readonly modelSnapshot: LegacyExecutionSnapshot | NativeModelSnapshot | null
  readonly protocolBinding?: ProtocolBindingSnapshot
  readonly nativeInput?: NativeRunInput
  readonly initialization?: NativeInitialization
  /** Historical metadata only; no retired profile can be executed. */
  readonly legacyModelSnapshot?: Readonly<{ profileId: string; configVersion: string }>
  readonly errorCategory?: RunFailureCategory
  readonly output?: string
  readonly error?: string
}

export interface RunInput {
  readonly modelId?: string
  readonly sessionId: string
  readonly parentNodeId: string | null
  readonly input: string
  readonly images?: readonly { readonly assetId: string }[]
  readonly files?: readonly { readonly snapshotId: string }[]
  readonly idempotencyKey: string
}

export type RunOutcome = (
  | { readonly kind: 'completed'; readonly output: string; readonly resultRecordIds?: readonly string[]; readonly records?: readonly ProtocolRecord[]; readonly checkpoint?: import('@anybox/models').JsonValue }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'cleanup-failed'; readonly error: string; readonly category: RunFailureCategory }
  | { readonly kind: 'failed'; readonly error: string; readonly category: RunFailureCategory }
) & { readonly records?: readonly ProtocolRecord[]; readonly checkpoint?: import('@anybox/models').JsonValue }

export function validateRunInput(input: RunInput): RunInput {
  if (input && ('modelProfileId' in input || 'model' in input || 'selection' in input || 'llmPlan' in input)) {
    throw new TypeError('RunInput accepts only a modelId for model selection')
  }
  const rawFiles = input?.files ?? []
  if (!Array.isArray(rawFiles) || rawFiles.some(file => !file || typeof file !== 'object' || Array.isArray(file) || Object.keys(file).some(key => key !== 'snapshotId'))) throw new TypeError('invalid input files')
  const files = validateSnapshotIds(rawFiles.map(file => file.snapshotId))
  const images = input?.images ?? []
  if (!Array.isArray(images) || images.length > imageLimits.maxImages || images.some(image => !image || typeof image !== 'object' ||
    Array.isArray(image) || Object.keys(image).some(key => key !== 'assetId') || typeof image.assetId !== 'string' || !image.assetId.trim())) {
    throw new TypeError('invalid input images')
  }
  if (typeof input?.input !== 'string' || (!input.input.trim() && !images.length && !files.length)) throw new TypeError('input must contain text, images or files')
  return Object.freeze({
    sessionId: nonEmpty(input?.sessionId, 'sessionId'),
    ...(input?.modelId === undefined ? {} : { modelId: nonEmpty(input.modelId, 'modelId') }),
    parentNodeId: input?.parentNodeId === null ? null : nonEmpty(input?.parentNodeId, 'parentNodeId'),
    input: input.input.trim(),
    files: Object.freeze(files.map(snapshotId => Object.freeze({ snapshotId }))),
    images: Object.freeze(images.map(image => Object.freeze({ assetId: nonEmpty(image.assetId, 'assetId') }))),
    idempotencyKey: nonEmpty(input?.idempotencyKey, 'idempotencyKey'),
  })
}

export function sameRunInput(left: RunInput, right: RunInput): boolean {
  return left.input === right.input && left.parentNodeId === right.parentNodeId && left.modelId === right.modelId &&
    JSON.stringify((left.images ?? []).map(image => image.assetId)) === JSON.stringify((right.images ?? []).map(image => image.assetId)) &&
    JSON.stringify((left.files ?? []).map(file => file.snapshotId)) === JSON.stringify((right.files ?? []).map(file => file.snapshotId))
}

export function requestCancellation(run: Run, now: string): Run {
  return run.status === 'running' ? Object.freeze({ ...run, status: 'cancelling', updatedAt: now }) : run
}

export function settleRun(run: Run, outcome: RunOutcome, now: string): Run {
  if (run.status !== 'running' && run.status !== 'cancelling') return run
  // Infrastructure failure must remain visible even if cancellation was already requested.
  if (outcome.kind === 'cleanup-failed' || (outcome.kind === 'failed' && outcome.category === 'state-write-failure')) {
    return Object.freeze({ ...run, status: 'failed', error: outcome.error, errorCategory: outcome.category, updatedAt: now })
  }
  if (run.status === 'cancelling') return Object.freeze({ ...run, status: 'cancelled', updatedAt: now })
  if (outcome.kind === 'completed') {
    return Object.freeze({ ...run, status: 'completed', output: outcome.output, updatedAt: now })
  }
  if (outcome.kind === 'failed') {
    return Object.freeze({ ...run, status: 'failed', error: outcome.error, errorCategory: outcome.category, updatedAt: now })
  }
  return Object.freeze({ ...run, status: 'cancelled', updatedAt: now })
}

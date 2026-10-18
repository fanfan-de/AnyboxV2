import type { JsonValue, NativeModelSnapshot, NativeImageResourceRef } from '@anybox/models'
import type { FileRef, FileContent } from '../project-files/domain.js'
import type { ImageRef } from '../image/port.js'
import type { ToolDefinition } from '../tool/definition.js'
import type { ToolSelectionSnapshot } from '../tool/catalog.js'
export type { NativeModelSnapshot } from '@anybox/models'
import type { OwnedCall } from '../contracts.js'
import type { PromptSnapshot } from '../prompt/domain.js'
import type { RunFailureCategory, RunOutcome, ToolObservation, ValidatedToolRequest } from './domain.js'

/** Application-owned serializable boundaries. Protocol SDK objects never cross these interfaces. */
export interface ProtocolBindingSnapshot {
  readonly protocolId: string
  readonly generationId: string
  readonly driverVersion: string
  readonly loopVersion: string
  readonly recordFormatVersion: number
  readonly viewSchemaVersion: number
}

export type NativeInitialization = {
  readonly schemaVersion: 1
  readonly prompts: readonly PromptSnapshot[]
  readonly tools: readonly ToolDefinition[]
  readonly toolContractVersion: 'known-tools-v1'
} | {
  readonly schemaVersion: 2
  readonly prompts: readonly PromptSnapshot[]
  readonly tools: readonly ToolDefinition[]
  readonly toolContractVersion: 'tool-library-v1'
  readonly toolSelection: ToolSelectionSnapshot
}

/** The template is applied exactly once before protocol encoding. */
export type NativeRunInput = {
  readonly schemaVersion: 1
  readonly raw: string
  readonly text: string
  readonly template: PromptSnapshot | null
} | {
  readonly schemaVersion: 2
  readonly raw: string
  readonly text: string
  readonly images: readonly ImageRef[]
  readonly template: PromptSnapshot | null
} | {
  readonly schemaVersion: 3
  readonly raw: string
  readonly text: string
  readonly images: readonly ImageRef[]
  readonly files: readonly FileRef[]
  readonly template: PromptSnapshot | null
}

export function inputFiles(input: NativeRunInput | undefined): readonly FileRef[] { return input?.schemaVersion === 3 ? input.files : [] }

export function inputImages(input: NativeRunInput | undefined): readonly ImageRef[] {
  return input && input.schemaVersion !== 1 ? input.images : []
}

export interface ProtocolRecord {
  readonly id: string
  readonly kind: 'request' | 'response' | 'checkpoint' | 'diagnostic'
  readonly exchangeId?: string
  readonly formatVersion: number
  readonly payload: JsonValue
  readonly resourceRefs?: readonly NativeImageResourceRef[]
}

export interface StoredProtocolRecord extends ProtocolRecord {
  readonly runId: string
  readonly protocolId: string
}

/** Materialized only while preparing a Run; storage keeps immutable per-Run segments. */
export interface NativeHistory {
  readonly contextRef: string
  readonly initialization: NativeInitialization
  readonly modelSnapshot: NativeModelSnapshot
  readonly binding: ProtocolBindingSnapshot
  readonly records: readonly StoredProtocolRecord[]
  readonly checkpoint: JsonValue
}

export interface OperationObservation {
  readonly records?: readonly ProtocolRecord[]
  readonly checkpoint?: JsonValue
  /** Interpreted only by the bound protocol Loop. Committed with the response records. */
  readonly protocolCursor?: JsonValue
}

export interface RunResumeBatch {
  readonly id: string
  readonly requests: readonly ValidatedToolRequest[]
  readonly operationIds: readonly string[]
}
/** Separate from the historical execution phase reader; no credentials or live handles. */
export interface RunResumeState {
  readonly schemaVersion: 1
  readonly runOwnerEpoch: number
  readonly revision: number
  readonly stage: 'model-pending' | 'response' | 'cleanup' | 'settling'
  readonly protocolCursor?: JsonValue
  readonly batch?: RunResumeBatch
  readonly totalToolOutputBytes: number
  readonly conclusion?: ProtocolConclusion
  /** Final exit facts and outcome, fixed before the terminal transaction; records live in the immutable ledger. */
  readonly settlement?: RunOutcome
}
export interface RunResumeRecord {
  readonly run: import('./domain.js').Run
  readonly projectId: string
  readonly initialization: NativeInitialization
  readonly history?: NativeHistory
  readonly records: readonly StoredProtocolRecord[]
  readonly state: RunResumeState
}
export interface RunResumePatch {
  readonly stage?: RunResumeState['stage']
  readonly batch?: RunResumeBatch
  readonly conclusion?: ProtocolConclusion
  /** Any supplied exit records are committed atomically and omitted from the stored cursor. */
  readonly settlement?: RunOutcome
}

/** A complete committed response already proves the native context; no credential or live execution is needed. */
export function runResumeCheckpoint(resume: RunResumeRecord): JsonValue {
  const snapshot = resume.run.modelSnapshot, binding = resume.run.protocolBinding
  if (snapshot?.schemaVersion !== 3 || !binding || snapshot.protocolId !== binding.protocolId) throw new TypeError('invalid accepted Run metadata')
  return JSON.parse(JSON.stringify({ protocolId: snapshot.protocolId, recordFormatVersion: binding.recordFormatVersion, modelSnapshot: snapshot })) as JsonValue
}

export interface OperationDescriptor<T> {
  readonly id: string
  readonly kind: 'model' | 'operation'
  readonly intent: JsonValue
  readonly records?: readonly ProtocolRecord[]
  observe(value: T): OperationObservation
}

export interface ProtocolViewFrame {
  readonly protocolId: string
  readonly schemaVersion: number
  readonly exchangeId: string
  readonly payload: JsonValue
}

export interface RunHost {
  readonly signal: AbortSignal
  perform<T>(descriptor: OperationDescriptor<T>, start: () => OwnedCall<T>): Promise<T>
  executeTools(requests: readonly ValidatedToolRequest[], scheduling?: 'serial', batchId?: string): Promise<readonly ToolObservation[]>
  publish(frame: ProtocolViewFrame): void
}

export type ProtocolConclusion =
  | { readonly kind: 'completed'; readonly output: string; readonly resultRecordIds: readonly string[] }
  | { readonly kind: 'failed'; readonly category: RunFailureCategory; readonly error: string }

export interface ProgramExitReport {
  readonly records: readonly ProtocolRecord[]
  /** Small protocol state; full historical messages belong in referenced immutable records. */
  readonly checkpoint: JsonValue
  readonly cleanup: 'completed' | 'failed'
}

export interface PreparedRunProgram {
  readonly binding: ProtocolBindingSnapshot
  readonly modelSnapshot: NativeModelSnapshot
  readonly initialization: NativeInitialization
  readonly input: NativeRunInput
  /** Immediate per-generation revocation, including while a local tool is running. */
  readonly signal: AbortSignal
  execute(host: RunHost): Promise<ProtocolConclusion>
  close(): Promise<ProgramExitReport>
  /** Release the binding lease only after resources and persistence have settled. */
  release(): void
}

export interface PrepareRunInput {
  readonly runId: string
  readonly sessionId: string
  readonly modelId: string
  readonly signal: AbortSignal
  readonly initialization: NativeInitialization
  readonly input: NativeRunInput
  readonly fileContents?: readonly FileContent[]
  readonly history?: NativeHistory
  /** Trusted active-Run preparation; ordinary callers use prepareResume. */
  readonly resume?: RunResumeRecord
}

export const protocolAgentServiceKey = 'harness.protocol-agents'
export interface ProtocolAgentPort {
  protocolForModel(modelId: string): string
  prepare(input: PrepareRunInput): Promise<PreparedRunProgram>
  prepareResume(input: { readonly resume: RunResumeRecord; readonly signal: AbortSignal }): Promise<PreparedRunProgram>
}

import type { JsonValue, NativeExecution, NativeObject, NativeRecordDraft, NativeReply } from '@anybox/models'
import type { NativeInitialization, ProtocolConclusion, ProtocolRecord, RunHost } from '../run/program.js'
import { modelFailure } from '../run/model.js'
import { validateToolBatch } from '../run/domain.js'
import type { ToolObservation, ValidatedToolRequest } from '../run/domain.js'
import type { ProtocolViewExchange, ProtocolViewSnapshot } from '../web/protocols/types.js'
import { boundProtocolView, projectNativeResponse, reduceNativeView } from './projection.js'

export function nativeObject(value: unknown): NativeObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw modelFailure('invalid-response')
  return value as NativeObject
}
export function nativeArray(value: unknown): readonly JsonValue[] {
  if (!Array.isArray(value)) throw modelFailure('invalid-response')
  return value
}
export function nativeString(value: unknown): string {
  if (typeof value !== 'string') throw modelFailure('invalid-response')
  return value
}
export function nonempty(value: unknown): string {
  const text = nativeString(value)
  if (!text.trim()) throw modelFailure('invalid-response')
  return text
}
export function jsonArguments(value: unknown): NativeObject {
  try { return nativeObject(JSON.parse(nativeString(value))) } catch { throw modelFailure('invalid-response') }
}
export function toProtocolRecord(record: NativeRecordDraft): ProtocolRecord {
  return { id: record.id, exchangeId: record.exchangeId, kind: record.kind, formatVersion: record.recordFormatVersion, payload: record.payload }
}
export function toNativeRecord(protocolId: string, record: ProtocolRecord): NativeRecordDraft {
  if (!record.exchangeId || record.formatVersion !== 1 || !['request', 'response', 'diagnostic'].includes(record.kind)) throw modelFailure('unsupported-request')
  return { id: record.id, exchangeId: record.exchangeId, protocolId, recordFormatVersion: 1,
    kind: record.kind as NativeRecordDraft['kind'], payload: record.payload }
}
export function serializable(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue }

export interface ExchangeRunner {
  call(intent: NativeObject): Promise<NativeReply>
  tools(calls: readonly ValidatedToolRequest[]): Promise<readonly ToolObservation[]>
}

/** Common resource plumbing contains no protocol flow decisions. */
export function createExchangeRunner(execution: NativeExecution, host: RunHost, identity: { sessionId: string; runId: string }): ExchangeRunner {
  let exchanges: readonly ProtocolViewExchange[] = []
  let revision = 0, toolExchange = 0
  const update = (exchange: ProtocolViewExchange) => {
    const index = exchanges.findIndex(item => item.id === exchange.id)
    const next = [...exchanges]
    if (index < 0) next.push(exchange); else next[index] = exchange
    exchanges = boundProtocolView(next)
  }
  const publish = (exchangeId: string) => {
    const snapshot: ProtocolViewSnapshot = { envelopeVersion: 1, protocolId: execution.snapshot.protocolId, viewSchemaVersion: 1,
      ...identity, viewRevision: ++revision, status: 'provisional', exchanges }
    host.publish({ protocolId: snapshot.protocolId, schemaVersion: 1, exchangeId, payload: serializable(snapshot) })
  }
  return {
    async call(intent) {
      host.signal.throwIfAborted()
      const prepared = execution.prepareExchange(intent)
      update({ id: prepared.exchangeId, blocks: [] })
      const reply = await host.perform({ id: prepared.exchangeId, kind: 'model', intent: serializable(prepared.request),
        records: [toProtocolRecord(prepared.record)], observe: reply => ({ records: reply.records.map(toProtocolRecord) }) },
      () => prepared.start(event => {
        const previous = exchanges.find(item => item.id === prepared.exchangeId)?.blocks ?? []
        update({ id: prepared.exchangeId, blocks: reduceNativeView(execution.snapshot.protocolId, previous, event) })
        publish(prepared.exchangeId)
      }))
      update({ id: prepared.exchangeId, blocks: projectNativeResponse(execution.snapshot.protocolId, reply.response) })
      publish(prepared.exchangeId)
      return reply
    },
    async tools(calls) {
      if (!execution.capabilities.tools) throw modelFailure('unsupported-request')
      const validated = validateToolBatch(calls)
      const results = await host.executeTools(validated, 'serial')
      const id = 'tools-' + (++toolExchange)
      update({ id, blocks: results.map((result, index) => ({ id: validated[index]!.id, kind: 'tool',
        label: result.name, status: 'observed', requestId: validated[index]!.id, detail: JSON.stringify(result.result) })) })
      publish(id)
      return results
    },
  }
}

export function completed(reply: NativeReply, output: string): ProtocolConclusion {
  const ids = reply.records.filter(record => record.kind === 'response').map(record => record.id)
  if (!ids.length) throw modelFailure('invalid-response')
  return { kind: 'completed', output, resultRecordIds: ids }
}

export function initialMessages(initialization: NativeInitialization): readonly NativeObject[] {
  return initialization.prompts.map(prompt => ({ role: prompt.role, content: prompt.content }))
}
export function toolResult(value: ToolObservation): string { return JSON.stringify(value.result) }

import { nativeImageResourceUri, type JsonValue, type NativeExecution, type NativeObject, type NativeRecordDraft, type NativeReply, type NativeImageResourceRef } from '@anybox/models'
import type { NativeInitialization, ProtocolConclusion, ProtocolRecord, RunHost } from '../run/program.js'
import { modelFailure } from '../run/model.js'
import { validateToolBatch } from '../run/domain.js'
import type { ToolObservation, ValidatedToolRequest } from '../run/domain.js'
import type { ProtocolViewExchange, ProtocolViewSnapshot } from '../view/types.js'
import { boundProtocolView, projectNativeRequest, projectNativeExchange, reduceNativeExchange } from './projection.js'
import type { PromptSnapshot } from '../prompt/domain.js'
import type { ToolDefinition } from '../tool/definition.js'
import { validateImageBatch } from '../image/limits.js'

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
  return { id: record.id, exchangeId: record.exchangeId, kind: record.kind, formatVersion: record.recordFormatVersion, payload: record.payload,
    ...(record.resourceRefs === undefined ? {} : { resourceRefs: record.resourceRefs }) }
}
export function toNativeRecord(protocolId: string, record: ProtocolRecord): NativeRecordDraft {
  if (!record.exchangeId || (record.formatVersion !== 1 && record.formatVersion !== 2) || !['request', 'response', 'diagnostic'].includes(record.kind)) throw modelFailure('unsupported-request')
  return { id: record.id, exchangeId: record.exchangeId, protocolId, recordFormatVersion: record.formatVersion,
    kind: record.kind as NativeRecordDraft['kind'], payload: record.payload,
    ...(record.resourceRefs === undefined ? {} : { resourceRefs: record.resourceRefs }) }
}
export function serializable(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)) as JsonValue }

export interface ExchangeRunner {
  call(intent: NativeObject): Promise<NativeReply>
  tools(calls: readonly ValidatedToolRequest[]): Promise<readonly ToolObservation[]>
}

/** Common resource plumbing contains no protocol flow decisions. */
export function createExchangeRunner(execution: NativeExecution, host: RunHost, identity: { sessionId: string; runId: string },
  initialResources: readonly NativeImageResourceRef[] = [], prompts?: readonly PromptSnapshot[],
  acceptResources?: (refs: readonly NativeImageResourceRef[]) => void, allowedTools?: readonly ToolDefinition[], replay?: NativeReply): ExchangeRunner {
  let initial = replay === undefined, replayReply = replay, latestExchangeId: string | undefined
  let nextResources: readonly NativeImageResourceRef[] = []
  let exchanges: readonly ProtocolViewExchange[] = []
  let revision = 0
  const update = (exchange: ProtocolViewExchange) => {
    const index = exchanges.findIndex(item => item.id === exchange.id)
    const next = [...exchanges]
    if (index < 0) next.push(exchange); else next[index] = { ...next[index]!, ...exchange }
    exchanges = boundProtocolView(next)
  }
  const publish = (exchangeId: string) => {
    const snapshot: ProtocolViewSnapshot = { envelopeVersion: 1, protocolId: execution.snapshot.protocolId, viewSchemaVersion: 2,
      ...identity, viewRevision: ++revision, status: 'provisional', exchanges }
    host.publish({ protocolId: snapshot.protocolId, schemaVersion: 2, exchangeId, payload: serializable(snapshot) })
  }
  return {
    async call(intent) {
      host.signal.throwIfAborted()
      if (replayReply) {
        const reply = replayReply
        replayReply = undefined
        latestExchangeId = reply.exchangeId
        update({ id: reply.exchangeId, ...projectNativeExchange(execution.snapshot.protocolId, reply.response) })
        publish(reply.exchangeId)
        return reply
      }
      const resources = initial ? initialResources : nextResources
      const prepared = execution.prepareExchange(intent, resources.length ? { resourceRefs: resources } : undefined)
      nextResources = []
      const inputs = projectNativeRequest(execution.snapshot.protocolId, prepared.record.payload, initial ? prompts : undefined)
      initial = false
      update({ id: prepared.exchangeId, ...(inputs.length ? { inputs } : {}), blocks: [] })
      publish(prepared.exchangeId)
      const reply = await host.perform({ id: prepared.exchangeId, kind: 'model', intent: serializable(prepared.request),
        records: [toProtocolRecord(prepared.record)], observe: reply => ({ records: reply.records.map(toProtocolRecord),
          protocolCursor: { schemaVersion: 1, protocolId: execution.snapshot.protocolId, exchangeId: reply.exchangeId } }) },
      () => prepared.start(event => {
        const previous = exchanges.find(item => item.id === prepared.exchangeId) ?? { id: prepared.exchangeId, blocks: [] }
        update(reduceNativeExchange(execution.snapshot.protocolId, previous, event))
        publish(prepared.exchangeId)
      }))
      update({ id: prepared.exchangeId, ...projectNativeExchange(execution.snapshot.protocolId, reply.response) })
      publish(prepared.exchangeId)
      latestExchangeId = reply.exchangeId
      return reply
    },
    async tools(calls) {
      if (!execution.capabilities.tools) throw modelFailure('unsupported-request')
      const validated = validateToolBatch(calls, allowedTools)
      const results = await host.executeTools(validated, 'serial', latestExchangeId)
      const images = results.flatMap(result => 'images' in result ? result.images ?? [] : [])
      validateImageBatch(images)
      nextResources = [...new Map(images.map(image => [image.assetId, { id: image.assetId, sha256: image.sha256,
        byteLength: image.byteLength, mimeType: image.mediaType }])).values()]
      // Runtime returns only after the Session observation and retain transaction commits.
      if (nextResources.length) acceptResources?.(nextResources)
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

/** Image tool observations use the already-supported native user-image shapes.
 * The tool result carries correlation; raw bytes are resolved privately at operation start. */
export function toolImageInputs(protocolId: string, results: readonly ToolObservation[]): readonly NativeObject[] {
  return results.flatMap(result => ('images' in result ? result.images ?? [] : []).map((image): NativeObject => {
    const text = `Image returned by tool ${result.name}: ${image.assetId}`
    const uri = nativeImageResourceUri(image.assetId)
    if (protocolId === 'responses') return { role: 'user', content: [{ type: 'input_text', text }, { type: 'input_image', image_url: uri }] }
    if (protocolId === 'chat-completions') return { role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: uri } }] }
    if (protocolId === 'anthropic-messages') return { role: 'user', content: [{ type: 'text', text }, { type: 'image', source: { type: 'url', url: uri } }] }
    return { type: 'user_input', content: [{ type: 'text', text }, { type: 'image', uri }] }
  }))
}

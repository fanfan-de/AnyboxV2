import { nativeImageResourceUri } from '@anybox/models'
import type { JsonValue, NativeImageResourceRef } from '@anybox/models'
import type { ProtocolRecord } from '../run/program.js'
import { object, array } from './projection-common.js'
import { projectNativeUsage } from './projection.js'

const approximateImageTokens = 768

function projectedTokens(text: string): number {
  // Approximate tokenizers by UTF-8 size when the provider has not reported the actual input.
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3)
}

export function estimateNativeIntent(intent: JsonValue, refs: readonly NativeImageResourceRef[] = []): number {
  const encoded = JSON.stringify(intent)
  return projectedTokens(encoded) + refs.reduce((tokens, ref) =>
    tokens + (encoded.split(nativeImageResourceUri(ref.id)).length - 1) * approximateImageTokens, 0)
}

/** These are the response items each native driver appends to its request history. */
function replayedResponse(protocolId: string, payload: JsonValue): unknown {
  const response = object(payload)
  switch (protocolId) {
    case 'chat-completions': return object(array(response.choices)[0]).message
    case 'responses': return response.output
    case 'anthropic-messages': return { role: 'assistant', content: response.content }
    case 'gemini-interactions': return response.steps
    default: return undefined
  }
}

/** Start from the latest reported full input and count only subsequent replayed items. */
export function estimateNativePrefix(protocolId: string, records: readonly ProtocolRecord[], prefix: () => number): number {
  let added = 0
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index]!
    if (record.kind === 'response') {
      const replay = replayedResponse(protocolId, record.payload)
      if (replay !== undefined) added += projectedTokens(JSON.stringify(replay))
      const measured = projectNativeUsage(protocolId, record.payload)?.inputTokens
      if (measured !== undefined) return Math.min(measured + added, Number.MAX_SAFE_INTEGER)
    } else if (record.kind === 'request') {
      added += estimateNativeIntent(record.payload, record.resourceRefs)
    }
  }
  return Math.min(prefix() + added, Number.MAX_SAFE_INTEGER)
}

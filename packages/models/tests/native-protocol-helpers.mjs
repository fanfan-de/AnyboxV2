import { createExecution } from '../dist/execution.js'
export const declared = { tools: { support: 'supported' }, streaming: { support: 'supported' }, imageInput: { support: 'unknown' }, webSearch: { support: 'supported' }, reasoning: { support: 'supported', modes: ['disabled', 'adaptive', 'enabled'], efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], budget: { min: 1024, max: 8192 } } }
export const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
export function sse(values, { fragment = 1, newline = '\n', close = true, cancel } = {}) {
  const bytes = new TextEncoder().encode(values.map(value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}${newline}${newline}`).join(''))
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += fragment) controller.enqueue(bytes.slice(i, i + fragment)); if (close) controller.close() }, ...(cancel ? { cancel } : {}) }))
}
export function nativeSession(protocol, { parameters = protocol.initialParameters?.() ?? {}, streaming = false, restore, signal, credential = 'private-native-test-key', auth = 'api-key' } = {}) {
  protocol.validateParameters(parameters, declared)
  const controller = new AbortController(); signal?.addEventListener('abort', () => controller.abort(), { once: true })
  return createExecution({ protocol, credential, provider: { providerDefinitionId: 'pd', protocolId: protocol.descriptor.id, name: 'test', enabled: true, baseUrl: 'https://unit.invalid/v1', auth, timeoutMs: 10000 }, capabilities: { ...protocol.effectiveCapabilities(declared, parameters), streaming }, restore, controller, onRelease() {},
    snapshot: { schemaVersion: 3, modelDefinitionId: 'md', providerDefinitionId: 'pd', modelDefinitionVersionId: 'mdv', modelId: 'model', modelRevision: 1, modelVersionId: 'mv', providerId: 'account', providerRevision: 1, providerVersionId: 'pv', remoteModelId: 'remote', protocolId: protocol.descriptor.id, protocolVersion: protocol.descriptor.version, registrationGenerationId: 'generation', historyScopeEpoch: 'scope', capabilities: { ...protocol.effectiveCapabilities(declared, parameters), streaming }, parameters: { protocolId: protocol.descriptor.id, formatVersion: 1, value: parameters } } })
}
export async function run(execution, intent, events) { return (await execution.prepareExchange(intent).start(events ? event => events.push(event) : undefined).result).response }
export const responseText = text => ({ type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] })
export const responseReply = (output, status = 'completed') => ({ id: 'response-id', object: 'response', status, output, usage: { input_tokens: 3, output_tokens: 4 } })
export const chatReply = (message = { role: 'assistant', content: 'answer' }, finish_reason = 'stop') => ({ id: 'chat-id', choices: [{ index: 0, message, finish_reason }] })
export const chatChunk = (delta, finish_reason = null) => ({ id: 'chat-id', choices: [{ index: 0, delta, finish_reason }] })

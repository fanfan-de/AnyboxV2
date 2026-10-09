import { responsesImages, imageContent, withImages } from './images.js';
import { modelsError } from '../errors.js';
import { assert } from '../domain.js';
import { terminalDiagnostic, withNativeDiagnostic } from '../diagnostics.js';
import type { JsonValue } from '../types.js';
import type { NativeObject, NativeProtocol } from '../native-types.js';
import { array, captureOptions, connectionFields, conversation, effectiveCapabilities, effortOption, index, mergeTools, native, nonempty, numberOption, object, optionKeys, parseJson, protocolComponent, reasoningEfforts, requireLocalTools, restoreRecords, string, validateProvider, validateServerTools, type ProtocolOptions } from './shared.js';
import { check, discover, request } from './transport.js';
export type ResponsesIntent = NativeObject;
export type ResponsesResponse = NativeObject;
export type ResponsesEvent = NativeObject;
function validateIntent(intent: NativeObject, images = true): void {
  for (const value of array(intent.input)) { const item = object(value);
    if (item.type === 'function_call_output') { nonempty(item.call_id); string(item.output); }
    else { if (!['system', 'developer', 'user'].includes(string(item.role))) throw modelsError('capability-unsupported'); imageContent(item.content, responsesImages, images && item.role === 'user', 'input_text'); }
  }
  if (intent.instructions !== undefined) string(intent.instructions);
}
function validateResponse(raw: unknown): NativeObject {
  const response = native(raw);
  if (response.error != null || response.status === 'failed' || response.status === 'cancelled') throw withNativeDiagnostic(modelsError('provider-failure'), terminalDiagnostic(response));
  if (!['completed', 'incomplete'].includes(string(response.status))) throw modelsError('invalid-response');
  const ids = new Set<string>();
  for (const value of array(response.output)) {
    const item = object(value);
    if (item.type === 'function_call') {
      const id = nonempty(item.call_id); if (ids.has(id)) throw modelsError('invalid-response'); ids.add(id); nonempty(item.name); string(item.arguments);
      if (response.status === 'completed' && (item.status === undefined || item.status === 'completed')) object(parseJson(string(item.arguments)));
    } else if (item.type === 'message') {
      if (item.role !== 'assistant') throw modelsError('invalid-response');
      for (const block of array(item.content)) { const content = object(block); if (content.type === 'output_text') string(content.text); else if (content.type === 'refusal') string(content.refusal); }
    } else if (item.type === 'reasoning' && item.encrypted_content != null) string(item.encrypted_content);
  }
  return response;
}
function commit(state: NativeObject, intent: NativeObject, response: NativeObject): NativeObject {
  validateIntent(intent);
  const value = validateResponse(response), next = conversation(state, intent, 'input', ['tools', 'instructions']);
  return native({ ...next, input: [...array(next.input), ...array(value.output)] });
}
function readGeneratedText(response: NativeObject): string {
  const value = validateResponse(response), text: string[] = [];
  if (value.status === 'incomplete' && value.incomplete_details != null) {
    const details = object(value.incomplete_details);
    if (details.reason === 'content_filter') throw modelsError('refused-response');
  }
  for (const entry of array(value.output)) {
    const item = object(entry), type = string(item.type);
    if (type === 'reasoning') continue;
    if (type.endsWith('_call') || type === 'mcp_approval_request') throw modelsError('capability-unsupported');
    if (type !== 'message' || item.role !== 'assistant') throw modelsError('invalid-response');
    if (item.status !== undefined && item.status !== 'completed') throw modelsError('incomplete-response');
    for (const entry of array(item.content)) {
      const block = object(entry);
      if (block.type === 'refusal') throw modelsError('refused-response');
      if (block.type !== 'output_text') throw modelsError('invalid-response');
      text.push(string(block.text));
    }
  }
  if (value.status !== 'completed') throw modelsError('incomplete-response');
  const result = text.join('\n');
  if (!result.trim()) throw modelsError('invalid-response');
  return result;
}
export function createResponsesProtocol(options: ProtocolOptions = {}): NativeProtocol {
  options = captureOptions(options);
  return {
    descriptor: { id: 'responses', version: '2.2.0', name: 'Responses', connectionFields, responseModes: ['stream', 'complete'],
      modelFields: [{ key: 'temperature', label: 'Temperature', type: 'number', min: 0, max: 2 },
        { key: 'max_output_tokens', label: 'Maximum output tokens', type: 'number', min: 1, integer: true },
        { key: 'reasoning.effort', label: 'Reasoning effort', type: 'enum', values: reasoningEfforts },
        { key: 'reasoning.summary', label: 'Reasoning summary', type: 'enum', values: ['auto', 'concise', 'detailed'] }], supportsDiscovery: true, supportsCheck: true },
    validateProvider: provider => validateProvider(provider, 'responses'),
    validateParameters(options, declared) {
      optionKeys(options, ['temperature', 'max_output_tokens', 'reasoning', 'tools']); numberOption(options.temperature, 0, 2); numberOption(options.max_output_tokens, 1, Number.MAX_SAFE_INTEGER, true);
      const reasoning = options.reasoning === undefined ? {} : object(options.reasoning); optionKeys(reasoning, ['effort', 'summary']); effortOption(reasoning.effort, declared, reasoningEfforts);
      if (reasoning.summary !== undefined) { assert(['auto', 'concise', 'detailed'].includes(string(reasoning.summary))); if (declared.reasoning.support !== 'supported' || reasoning.effort === 'none') throw modelsError('capability-unsupported'); }
      validateServerTools(options.tools, declared, 'responses');
    },
    effectiveCapabilities: (declared, options) => ({ ...effectiveCapabilities(declared, options.reasoning !== undefined && object(options.reasoning).effort === 'none', true), imageInput: declared.imageInput.support === 'supported' }),
    recordFormatVersion: 2,
    canRestoreVersion: version => version === '2.0.0' || version === '2.1.0' || version === '2.2.0',
    textGeneration: {
      createIntent: input => native({ input: [{ role: 'user', content: input.input }], ...(input.instruction === undefined ? {} : { instructions: input.instruction }) }),
      validateParameters: parameters => { if (parameters.tools !== undefined && array(parameters.tools).length) throw modelsError('capability-unsupported'); },
      readText: readGeneratedText,
    },
    resourceIds: responsesImages.ids,
    restore: records => {
      for (const record of records) if (record.kind === 'request') validateIntent(native(record.payload), record.recordFormatVersion === 2);
      return restoreRecords('responses', records, commit, [1, 2]);
    },
    prepare(input) {
      validateIntent(input.intent);
      if (responsesImages.ids(input.intent).length && !input.capabilities.imageInput) throw modelsError('capability-unsupported');
      requireLocalTools(input.intent.tools, input.capabilities.tools);
      const next = conversation(input.state, input.intent, 'input', ['tools', 'instructions']);
      const tools = mergeTools(next.tools, input.parameters.tools);
      for (const value of next.tools === undefined ? [] : array(next.tools)) { const tool = object(value); if (tool.type !== 'function') throw modelsError('invalid-config'); object(tool.parameters); }
      const streaming = input.responseMode === undefined ? input.capabilities.streaming : input.responseMode === 'stream';
      return native({ ...input.parameters, model: input.remoteModelId, input: next.input, store: false, stream: streaming,
        include: ['reasoning.encrypted_content'], ...(next.instructions === undefined ? {} : { instructions: next.instructions }), ...(tools.length ? { tools } : {}) });
    },
    exchange(input) {
      return withImages(responsesImages, input, (wire, signal) => request(options, { ...input, signal }, 'responses', wire, async reader => {
        if (!input.request.stream) return validateResponse(await reader.json());
        let terminal: NativeObject | undefined;
        const received = new Map<number, Record<string, JsonValue>>();
        await reader.sse(data => {
          if (data === '[DONE]') { if (!terminal) throw modelsError('invalid-response'); return; }
          if (terminal) throw modelsError('invalid-response');
          const event = native(parseJson(data)), type = string(event.type);
          if (type === 'error' || type === 'response.failed' || type === 'response.cancelled') {
            const raw = event.response === undefined ? event : object(event.response);
            throw withNativeDiagnostic(modelsError('provider-failure'), terminalDiagnostic({ ...raw, ...(type === 'error' ? {} : { status: type.slice(9) }) }, { field: 'output', values: [...received.entries()].sort(([a], [b]) => a - b).map(([, value]) => value) }));
          }
          if (type === 'response.completed' || type === 'response.incomplete') {
            const response = object(event.response); if (response.status !== type.slice(9)) throw modelsError('invalid-response'); terminal = validateResponse(response); input.onEvent(event); return true;
          }
          if (event.output_index !== undefined) index(event.output_index);
          // Partial blocks are diagnostic data only; the terminal response remains authoritative.
          if (type === 'response.output_item.added' || type === 'response.output_item.done') received.set(index(event.output_index), structuredClone(object(event.item)));
          else if (event.output_index !== undefined) {
            const item = received.get(index(event.output_index));
            if (item && (type === 'response.content_part.added' || type === 'response.content_part.done')) {
              const content = item.content === undefined ? [] : array(item.content), at = index(event.content_index);
              if (at <= content.length) { content[at] = structuredClone(object(event.part)); item.content = content; }
            } else if (item && type === 'response.function_call_arguments.delta') item.arguments = string(item.arguments ?? '') + string(event.delta);
            else if (item && event.content_index !== undefined && ['response.output_text.delta', 'response.refusal.delta'].includes(type)) {
              const content = item.content === undefined ? [] : array(item.content), block = content[index(event.content_index)];
              if (block) { const part = object(block), field = type === 'response.refusal.delta' ? 'refusal' : 'text'; part[field] = string(part[field] ?? '') + string(event.delta); }
            }
          }
          input.onEvent(event);
        });
        if (!terminal) throw modelsError('invalid-response'); return terminal;
      }));
    },
    commit: input => commit(input.state, input.intent, input.response),
    discover: input => discover(options, input), check: input => check(options, input),
  };
}
export function createResponsesProtocolComponent(options: ProtocolOptions = {}) { return protocolComponent(createResponsesProtocol(options)); }

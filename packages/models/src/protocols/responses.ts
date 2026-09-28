import { modelsError } from '../errors.js';
import { assert } from '../domain.js';
import { terminalDiagnostic, withNativeDiagnostic } from '../diagnostics.js';
import type { JsonValue } from '../types.js';
import type { NativeObject, NativeProtocol } from '../native-types.js';
import { array, captureOptions, connectionFields, conversation, effectiveCapabilities, effortOption, index, mergeTools, native, nonempty, numberOption, object, optionKeys, parseJson, protocolComponent, reasoningEfforts, requireLocalTools, restoreRecords, string, textBlocks, validateProvider, validateServerTools, type ProtocolOptions } from './shared.js';
import { check, discover, request } from './transport.js';
export type ResponsesIntent = NativeObject;
export type ResponsesResponse = NativeObject;
export type ResponsesEvent = NativeObject;
function validateIntent(intent: NativeObject): void {
  for (const value of array(intent.input)) { const item = object(value);
    if (item.type === 'function_call_output') { nonempty(item.call_id); string(item.output); }
    else { if (!['system', 'developer', 'user'].includes(string(item.role))) throw modelsError('capability-unsupported'); textBlocks(item.content, 'input_text'); }
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
export function createResponsesProtocol(options: ProtocolOptions = {}): NativeProtocol {
  options = captureOptions(options);
  return {
    descriptor: { id: 'responses', version: '2.0.0', name: 'Responses', connectionFields,
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
    effectiveCapabilities: (declared, options) => effectiveCapabilities(declared, options.reasoning !== undefined && object(options.reasoning).effort === 'none', true),
    restore: records => restoreRecords('responses', records, commit),
    prepare(input) {
      validateIntent(input.intent); requireLocalTools(input.intent.tools, input.capabilities.tools);
      const next = conversation(input.state, input.intent, 'input', ['tools', 'instructions']);
      const tools = mergeTools(next.tools, input.parameters.tools);
      for (const value of next.tools === undefined ? [] : array(next.tools)) { const tool = object(value); if (tool.type !== 'function') throw modelsError('invalid-config'); object(tool.parameters); }
      return native({ ...input.parameters, model: input.remoteModelId, input: next.input, store: false, stream: input.capabilities.streaming,
        include: ['reasoning.encrypted_content'], ...(next.instructions === undefined ? {} : { instructions: next.instructions }), ...(tools.length ? { tools } : {}) });
    },
    exchange(input) {
      return request(options, input, 'responses', input.request, async reader => {
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
      });
    },
    commit: input => commit(input.state, input.intent, input.response),
    discover: input => discover(options, input), check: input => check(options, input),
  };
}
export function createResponsesProtocolComponent(options: ProtocolOptions = {}) { return protocolComponent(createResponsesProtocol(options)); }

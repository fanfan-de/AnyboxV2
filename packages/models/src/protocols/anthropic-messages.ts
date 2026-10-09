import { anthropicImages, withImages } from './images.js';
import { modelsError } from '../errors.js';
import { assert } from '../domain.js';
import { terminalDiagnostic, withNativeDiagnostic } from '../diagnostics.js';
import type { DeclaredCapabilities, DiscoveredModel, JsonValue } from '../types.js';
import type { NativeObject, NativeProtocol } from '../native-types.js';
import { array, captureOptions, connectionFields, conversation, effectiveCapabilities, effortOption, index, mergeTools, native, nonempty, numberOption, object, optionKeys, parseJson, protocolComponent, requireLocalTools, restoreRecords, string, textBlocks, validateProvider, validateServerTools, type ProtocolOptions } from './shared.js';
import { pagedDiscover, request } from './transport.js';
const protocolId = 'anthropic-messages';
const requestOptions = { headers: { 'anthropic-version': '2023-06-01' }, authHeader: 'anthropic-api-key' } as const;
const modes = ['disabled', 'adaptive', 'enabled'] as const, efforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
function integer(value: unknown): number { return index(value); }
function supported(value: unknown): boolean { const raw = object(value); if (typeof raw.supported !== 'boolean') throw modelsError('invalid-response'); return raw.supported; }
function validateIntent(intent: NativeObject, images = true): void {
  if (intent.system !== undefined) textBlocks(intent.system);
  for (const value of array(intent.messages)) { const message = object(value); if (message.role !== 'user') throw modelsError('capability-unsupported');
    if (typeof message.content === 'string') continue;
    for (const value of array(message.content)) { const block = object(value); if (block.type === 'text') string(block.text); else if (block.type === 'tool_result') { nonempty(block.tool_use_id); textBlocks(block.content); } else if (!images || anthropicImages.id(block) === undefined) throw modelsError('capability-unsupported'); }
  }
}
function validateResponse(raw: unknown): NativeObject {
  const message = native(raw);
  if (message.error != null || message.type === 'error') throw withNativeDiagnostic(modelsError('provider-failure'), terminalDiagnostic(message));
  if (message.type !== 'message' || message.role !== 'assistant' || !['end_turn', 'stop_sequence', 'tool_use', 'max_tokens', 'model_context_window_exceeded', 'pause_turn', 'refusal'].includes(string(message.stop_reason))) throw modelsError('invalid-response');
  const ids = new Set<string>();
  for (const value of array(message.content)) {
    const block = object(value);
    if (block.type === 'text') string(block.text);
    else if (block.type === 'thinking') { string(block.thinking); if (!['max_tokens', 'model_context_window_exceeded'].includes(string(message.stop_reason))) nonempty(block.signature); else if (block.signature !== undefined) string(block.signature); }
    else if (block.type === 'redacted_thinking') nonempty(block.data);
    else if (block.type === 'tool_use' || block.type === 'server_tool_use') { const id = nonempty(block.id); if (ids.has(id)) throw modelsError('invalid-response'); ids.add(id); nonempty(block.name); if (!['max_tokens', 'model_context_window_exceeded'].includes(string(message.stop_reason))) object(block.input); }
    else if (block.type === 'web_search_tool_result') { nonempty(block.tool_use_id); if (!Array.isArray(block.content)) object(block.content); }
    else nonempty(block.type);
  }
  return message;
}
function commit(state: NativeObject, intent: NativeObject, response: NativeObject): NativeObject {
  validateIntent(intent);
  const message = validateResponse(response), next = conversation(state, intent, 'messages', ['system', 'tools']);
  return native({ ...next, messages: [...array(next.messages), { role: 'assistant', content: message.content }] });
}
function readGeneratedText(response: NativeObject): string {
  const message = validateResponse(response);
  if (message.stop_reason === 'refusal') throw modelsError('refused-response');
  const text: string[] = [];
  for (const value of array(message.content)) {
    const block = object(value);
    if (block.type === 'text') text.push(string(block.text));
    else if (['tool_use', 'server_tool_use', 'web_search_tool_result'].includes(string(block.type))) throw modelsError('capability-unsupported');
    else if (block.type !== 'thinking' && block.type !== 'redacted_thinking') throw modelsError('invalid-response');
  }
  if (message.stop_reason === 'tool_use') throw modelsError('capability-unsupported');
  if (message.stop_reason !== 'end_turn' && message.stop_reason !== 'stop_sequence') throw modelsError('incomplete-response');
  return nonempty(text.join('\n'));
}
function parsePage(raw: unknown): { models: readonly DiscoveredModel[]; nextPath?: string } {
  const page = object(raw);
  if (typeof page.has_more !== 'boolean') throw modelsError('invalid-response');
  const models = array(page.data).map(value => {
    const model = object(value);
    const id = nonempty(model.id);
    const result: DiscoveredModel = { remoteModelId: id, name: model.display_name === undefined ? id : nonempty(model.display_name) };
    if (model.capabilities == null) return result;
    const rawCapabilities = object(model.capabilities);
    const reasoning: { support: DeclaredCapabilities['reasoning']['support']; modes?: string[]; efforts?: string[] } = { support: 'unknown' };
    const suggestions: { reasoning?: DeclaredCapabilities['reasoning']; imageInput?: DeclaredCapabilities['imageInput'] } = {};
    if (rawCapabilities.thinking !== undefined) {
      const thinking = object(rawCapabilities.thinking);
      reasoning.support = supported(thinking) ? 'supported' : 'unsupported';
      if (thinking.types !== undefined) {
        const types = object(thinking.types);
        const known = ['adaptive', 'enabled'].filter(mode => types[mode] !== undefined && supported(types[mode]));
        if (reasoning.support === 'supported' && known.length) reasoning.modes = known;
      }
      suggestions.reasoning = reasoning;
    }
    if (rawCapabilities.effort !== undefined) {
      const capability = object(rawCapabilities.effort);
      if (supported(capability)) {
        const known = efforts.filter(effort => capability[effort] !== undefined && supported(capability[effort]));
        if (known.length) reasoning.efforts = known;
      }
      suggestions.reasoning = reasoning;
    }
    if (rawCapabilities.image_input !== undefined) suggestions.imageInput = { support: supported(rawCapabilities.image_input) ? 'supported' : 'unsupported' };
    return Object.keys(suggestions).length ? { ...result, suggestedCapabilities: suggestions } : result;
  });
  if (!page.has_more) return { models };
  const last = nonempty(page.last_id);
  if (!models.length || models.at(-1)!.remoteModelId !== last) throw modelsError('invalid-response');
  return { models, nextPath: `models?limit=1000&after_id=${encodeURIComponent(last)}` };
}

export function createAnthropicMessagesProtocol(options: ProtocolOptions = {}): NativeProtocol {
  options = captureOptions(options);
  return {
    descriptor: { id: protocolId, version: '2.2.0', name: 'Anthropic Messages', responseModes: ['stream', 'complete'], connectionFields,
      modelFields: [{ key: 'temperature', label: 'Temperature', type: 'number', min: 0, max: 1 }, { key: 'max_tokens', label: 'Maximum output tokens', type: 'number', min: 1, integer: true, required: true, defaultValue: 4096 },
        { key: 'thinking.type', label: 'Thinking mode', type: 'enum', values: modes }, { key: 'thinking.budget_tokens', label: 'Thinking token budget', type: 'number', min: 1024, integer: true },
        { key: 'thinking.display', label: 'Thinking display', type: 'enum', values: ['summarized', 'omitted'] }, { key: 'output_config.effort', label: 'Reasoning effort', type: 'enum', values: efforts }], supportsDiscovery: true, supportsCheck: true },
    initialParameters: outputLimit => ({ max_tokens: Math.min(4096, outputLimit ?? 4096) }),
    validateProvider: provider => validateProvider(provider, protocolId),
    validateParameters(options, declared) {
      optionKeys(options, ['temperature', 'max_tokens', 'thinking', 'output_config', 'tools']); numberOption(options.max_tokens, 1, Number.MAX_SAFE_INTEGER, true, true); numberOption(options.temperature, 0, 1);
      const thinking = options.thinking === undefined ? {} : object(options.thinking); optionKeys(thinking, ['type', 'budget_tokens', 'display']);
      const mode = thinking.type;
      if (mode !== undefined) { assert(typeof mode === 'string' && modes.includes(mode as typeof modes[number])); if (declared.reasoning.support !== 'supported' || !declared.reasoning.modes?.includes(mode)) throw modelsError('capability-unsupported'); }
      if (mode === 'enabled') { numberOption(thinking.budget_tokens, 1024, Number(options.max_tokens) - 1, true, true); if (declared.reasoning.budget && (Number(thinking.budget_tokens) < declared.reasoning.budget.min || Number(thinking.budget_tokens) > declared.reasoning.budget.max)) throw modelsError('capability-unsupported'); }
      else assert(thinking.budget_tokens === undefined);
      if (mode === 'adaptive' || mode === 'enabled') assert(options.temperature === undefined || options.temperature === 1);
      if (thinking.display !== undefined) assert(['summarized', 'omitted'].includes(string(thinking.display)) && (mode === 'adaptive' || mode === 'enabled'));
      const output = options.output_config === undefined ? {} : object(options.output_config); optionKeys(output, ['effort']); effortOption(output.effort, declared, efforts);
      validateServerTools(options.tools, declared, protocolId);
    },
    effectiveCapabilities: (declared, options) => ({ ...effectiveCapabilities(declared, options.thinking !== undefined && object(options.thinking).type === 'disabled', true), imageInput: declared.imageInput.support === 'supported' }),
    recordFormatVersion: 2,
    canRestoreVersion: version => version === '2.0.0' || version === '2.1.0' || version === '2.2.0',
    textGeneration: {
      createIntent: input => native({ messages: [{ role: 'user', content: [{ type: 'text', text: input.input }] }], ...(input.instruction === undefined ? {} : { system: [{ type: 'text', text: input.instruction }] }) }),
      validateParameters: parameters => { if (parameters.tools !== undefined && array(parameters.tools).length) throw modelsError('capability-unsupported'); },
      readText: readGeneratedText,
    },
    resourceIds: anthropicImages.ids,
    restore: records => {
      for (const record of records) if (record.kind === 'request') validateIntent(native(record.payload), record.recordFormatVersion === 2);
      return restoreRecords(protocolId, records, commit, [1, 2]);
    },
    prepare(input) {
      validateIntent(input.intent);
      if (anthropicImages.ids(input.intent).length && !input.capabilities.imageInput) throw modelsError('capability-unsupported');
      requireLocalTools(input.intent.tools, input.capabilities.tools);
      const next = conversation(input.state, input.intent, 'messages', ['system', 'tools']);
      for (const value of array(next.messages)) { const message = object(value); if (!['user', 'assistant'].includes(string(message.role))) throw modelsError('invalid-config'); if (typeof message.content !== 'string') array(message.content); }
      for (const value of next.tools === undefined ? [] : array(next.tools)) { const tool = object(value); if (tool.type !== undefined) throw modelsError('invalid-config'); nonempty(tool.name); object(tool.input_schema); }
      const tools = mergeTools(next.tools, input.parameters.tools);
      return native({ ...input.parameters, messages: next.messages, ...(next.system === undefined ? {} : { system: next.system }), ...(tools.length ? { tools } : {}), model: input.remoteModelId, stream: input.responseMode === undefined ? input.capabilities.streaming : input.responseMode === 'stream' });
    },
    exchange(input) {
      return withImages(anthropicImages, input, (wire, signal) => request(options, { ...input, signal }, 'messages', wire, async reader => {
        if (!input.request.stream) return validateResponse(await reader.json());
        let message: Record<string, JsonValue> | undefined, finished = false, stopped = false;
        const blocks = new Map<number, { value: Record<string, JsonValue>; stopped: boolean; arguments?: string }>();
        await reader.sse(data => {
          if (data === '[DONE]') throw modelsError('invalid-response');
          const event = native(parseJson(data)), type = string(event.type);
          if (type === 'ping') return;
          if (type === 'error') throw withNativeDiagnostic(modelsError('provider-failure'), terminalDiagnostic({ ...message, ...event }, { field: 'content', values: [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => ({ ...block.value, ...(block.arguments === undefined ? {} : { input: block.arguments }) })) }));
          if (finished) throw modelsError('invalid-response');
          if (type === 'message_start') { if (message) throw modelsError('invalid-response'); message = { ...object(event.message) }; if (array(message.content).length) throw modelsError('invalid-response'); }
          else if (!message) throw modelsError('invalid-response');
          else if (type === 'content_block_start') {
            const at = index(event.index); if (blocks.has(at) || stopped) throw modelsError('invalid-response'); blocks.set(at, { value: { ...object(event.content_block) }, stopped: false });
          } else if (type === 'content_block_delta') {
            const block = blocks.get(index(event.index)); if (!block || block.stopped || stopped) throw modelsError('invalid-response'); const delta = object(event.delta);
            if (delta.type === 'text_delta' && block.value.type === 'text') block.value.text = string(block.value.text ?? '') + string(delta.text);
            else if (delta.type === 'thinking_delta' && block.value.type === 'thinking') block.value.thinking = string(block.value.thinking ?? '') + string(delta.thinking);
            else if (delta.type === 'signature_delta' && block.value.type === 'thinking') block.value.signature = string(block.value.signature ?? '') + string(delta.signature);
            else if (delta.type === 'input_json_delta' && ['tool_use', 'server_tool_use'].includes(string(block.value.type))) block.arguments = (block.arguments ?? '') + string(delta.partial_json);
            else if (delta.type === 'citations_delta' && block.value.type === 'text') block.value.citations = [...(block.value.citations === undefined ? [] : array(block.value.citations)), object(delta.citation)];
            else throw modelsError('invalid-response');
          } else if (type === 'content_block_stop') {
            const block = blocks.get(index(event.index)); if (!block || block.stopped) throw modelsError('invalid-response'); block.stopped = true;
            // A truncated tool fragment remains native data and never becomes executable input.
            if (block.arguments !== undefined) { try { block.value.input = object(parseJson(block.arguments)); } catch { block.value.input = block.arguments; } }
          } else if (type === 'message_delta') {
            if (stopped || [...blocks.values()].some(block => !block.stopped)) throw modelsError('invalid-response'); stopped = true;
            message = { ...message, ...object(event.delta), ...(event.usage === undefined ? {} : { usage: { ...(message.usage === undefined ? {} : object(message.usage)), ...object(event.usage) } }) };
          } else if (type === 'message_stop') {
            if (!stopped || [...blocks.values()].some(block => !block.stopped)) throw modelsError('invalid-response');
            const ordered = [...blocks.entries()].sort(([a], [b]) => a - b); if (ordered.some(([at], index) => at !== index)) throw modelsError('invalid-response');
            message.content = ordered.map(([, block]) => block.value); finished = true; validateResponse(message); input.onEvent(event); return true;
          } else throw modelsError('invalid-response');
          input.onEvent(event);
        });
        if (!finished || !message) throw modelsError('invalid-response'); return validateResponse(message);
      }, requestOptions));
    },
    commit: input => commit(input.state, input.intent, input.response),
    discover: input => pagedDiscover(options, input, 'models?limit=1000', parsePage, requestOptions),
    check: input => request(options, input, 'models?limit=1', undefined, async reader => { parsePage(await reader.json()); }, requestOptions),
  };
}
export function createAnthropicMessagesProtocolComponent(options: ProtocolOptions = {}) { return protocolComponent(createAnthropicMessagesProtocol(options)); }

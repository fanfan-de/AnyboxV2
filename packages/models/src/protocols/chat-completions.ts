import { modelsError } from '../errors.js';
import { assert } from '../domain.js';
import type { NativeObject, NativeProtocol } from '../native-types.js';
import type { JsonValue } from '../types.js';
import { array, captureOptions, connectionFields, conversation, effectiveCapabilities, effortOption, index, native, nonempty, numberOption, object, optionKeys, parseJson, protocolComponent, reasoningEfforts, requireLocalTools, restoreRecords, string, validateProvider, type ProtocolOptions } from './shared.js';
import { check, discover, request } from './transport.js';
import { parseNativeImageResourceUri } from '../resources.js';
import { chatImageIds, withChatImages } from './chat-images.js';
export interface ChatCompletionsRequestPolicy {
  readonly protocolId: string;
  readonly name: string;
  readonly maxTokensField?: 'max_completion_tokens' | 'max_tokens';
  readonly disableThinking?: boolean;
  readonly allowDeveloper?: boolean;
  readonly sourceMappings?: import('../types.js').ProtocolDescriptor['sourceMappings'];
}
function validateIntent(intent: NativeObject, images = true): void {
  for (const value of array(intent.messages)) {
    const item = object(value); if (!['system', 'developer', 'user', 'tool'].includes(string(item.role))) throw modelsError('capability-unsupported');
    if (typeof item.content === 'string') { if (item.role === 'tool') nonempty(item.tool_call_id); continue; }
    if (item.role !== 'user' || !images) throw modelsError('capability-unsupported');
    const blocks = array(item.content); assert(blocks.length > 0);
    for (const value of blocks) {
      const block = object(value);
      if (block.type === 'text') { optionKeys(block, ['type', 'text']); string(block.text); }
      else if (block.type === 'image_url' && images) {
        optionKeys(block, ['type', 'image_url']); const image = object(block.image_url); optionKeys(image, ['url']);
        if (!parseNativeImageResourceUri(string(image.url))) throw modelsError('capability-unsupported');
      } else throw modelsError('capability-unsupported');
    }
  }
}
function validateResponse(raw: unknown): NativeObject {
  const response = native(raw);
  if (response.error !== undefined) throw modelsError('provider-failure');
  const choices = array(response.choices); if (choices.length !== 1) throw modelsError('invalid-response');
  const choice = object(choices[0]), message = object(choice.message);
  if (!['stop', 'tool_calls', 'length', 'content_filter'].includes(string(choice.finish_reason)) || message.role !== 'assistant') throw modelsError('invalid-response');
  if (message.content != null && typeof message.content !== 'string') throw modelsError('invalid-response');
  if (message.refusal != null) string(message.refusal);
  const ids = new Set<string>();
  const calls = message.tool_calls === undefined ? [] : array(message.tool_calls);
  for (const value of calls) {
    const call = object(value), fn = object(call.function); if (call.type !== 'function') throw modelsError('invalid-response');
    const id = nonempty(call.id); if (ids.has(id)) throw modelsError('invalid-response'); ids.add(id); nonempty(fn.name); string(fn.arguments);
    if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') object(parseJson(string(fn.arguments)));
  }
  if (choice.finish_reason === 'tool_calls' && !calls.length || message.function_call !== undefined) throw modelsError('invalid-response');
  return response;
}
function commit(state: NativeObject, intent: NativeObject, response: NativeObject): NativeObject {
  validateIntent(intent);
  const value = validateResponse(response), next = conversation(state, intent, 'messages', ['tools']);
  return native({ ...next, messages: [...array(next.messages), object(array(value.choices)[0]).message] });
}
/** Extensions select explicit wire differences; transport, SSE and native history remain shared. */
export function createChatCompletionsProtocol(options: ProtocolOptions = {}, policy: ChatCompletionsRequestPolicy = { protocolId: 'chat-completions', name: 'Chat Completions' }): NativeProtocol {
  options = captureOptions(options); policy = Object.freeze({ ...policy });
  const protocolId = policy.protocolId, tokenField = policy.maxTokensField ?? 'max_completion_tokens';
  return {
    descriptor: { id: protocolId, version: '2.1.0', name: policy.name, connectionFields,
      modelFields: [{ key: 'temperature', label: 'Temperature', type: 'number', min: 0, max: 2 }, { key: tokenField, label: 'Maximum output tokens', type: 'number', min: 1, integer: true },
        ...(!policy.disableThinking ? [{ key: 'reasoning_effort', label: 'Reasoning effort', type: 'enum' as const, values: reasoningEfforts }] : [])],
      supportsDiscovery: true, supportsCheck: true, ...(policy.sourceMappings ? { sourceMappings: policy.sourceMappings } : {}) },
    validateProvider: provider => validateProvider(provider, protocolId),
    validateParameters(options, declared) { optionKeys(options, ['temperature', tokenField, ...(!policy.disableThinking ? ['reasoning_effort'] : [])]); numberOption(options.temperature, 0, 2); numberOption(options[tokenField], 1, Number.MAX_SAFE_INTEGER, true); effortOption(options.reasoning_effort, declared, reasoningEfforts); },
    recordFormatVersion: 2,
    canRestoreVersion: version => version === '2.0.0' || version === '2.1.0',
    resourceIds: chatImageIds,
    effectiveCapabilities: (declared, options) => ({ ...effectiveCapabilities(declared, policy.disableThinking || options.reasoning_effort === 'none'), imageInput: declared.imageInput.support === 'supported' }),
    restore: records => {
      for (const record of records) if (record.kind === 'request') validateIntent(native(record.payload), record.recordFormatVersion === 2);
      return restoreRecords(protocolId, records, commit, [1, 2]);
    },
    prepare(input) {
      validateIntent(input.intent); requireLocalTools(input.intent.tools, input.capabilities.tools);
      if (chatImageIds(input.intent).length && !input.capabilities.imageInput) throw modelsError('capability-unsupported');
      const next = conversation(input.state, input.intent, 'messages', ['tools']);
      if (policy.allowDeveloper === false && array(next.messages).some(item => object(item).role === 'developer')) throw modelsError('invalid-config');
      for (const value of next.tools === undefined ? [] : array(next.tools)) { const tool = object(value); if (tool.type !== 'function') throw modelsError('invalid-config'); object(object(tool.function).parameters); }
      return native({ ...input.parameters, ...next, model: input.remoteModelId, stream: input.capabilities.streaming,
        ...(input.capabilities.streaming ? { stream_options: { include_usage: true } } : {}), ...(policy.disableThinking ? { thinking: { type: 'disabled' } } : {}) });
    },
    exchange(input) {
      return withChatImages(input, (wire, signal) => request(options, { ...input, signal }, 'chat/completions', wire, async reader => {
        if (!input.request.stream) return validateResponse(await reader.json());
        let message: Record<string, JsonValue> = { role: 'assistant', content: '' }, finish: JsonValue | undefined, usage: JsonValue | undefined, completed = false;
        const calls = new Map<number, Record<string, JsonValue>>(); let envelope: Record<string, JsonValue> = {};
        await reader.sse(data => {
          if (data === '[DONE]') { if (completed || finish === undefined) throw modelsError('invalid-response'); completed = true; return true; }
          if (completed) throw modelsError('invalid-response');
          const chunk = native(parseJson(data)); if (chunk.error !== undefined) throw modelsError('provider-failure'); input.onEvent(chunk);
          const { choices: _choices, usage: rawUsage, ...metadata } = chunk; envelope = { ...envelope, ...metadata };
          if (rawUsage != null) usage = rawUsage;
          const choices = array(chunk.choices); if (choices.length > 1) throw modelsError('invalid-response'); if (!choices.length) return;
          const choice = object(choices[0]); if (choice.index !== 0 || finish !== undefined) throw modelsError('invalid-response');
          const delta = object(choice.delta);
          for (const [key, value] of Object.entries(delta)) {
            if (key === 'tool_calls') continue;
            if (key === 'content' || key === 'refusal') { if (value != null) message[key] = string(message[key] ?? '') + string(value); }
            else message[key] = value;
          }
          for (const value of delta.tool_calls === undefined ? [] : array(delta.tool_calls)) {
            const tool = object(value), at = index(tool.index); const previous: Record<string, JsonValue> = calls.get(at) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (tool.id !== undefined) previous.id = string(previous.id) + string(tool.id);
            const fn = tool.function === undefined ? {} : object(tool.function), old = object(previous.function);
            previous.function = { ...old, ...fn, name: string(old.name) + string(fn.name ?? ''), arguments: string(old.arguments) + string(fn.arguments ?? '') };
            for (const [key, item] of Object.entries(tool)) if (!['id', 'function', 'index'].includes(key)) previous[key] = item;
            calls.set(at, previous);
          }
          if (choice.finish_reason != null) finish = choice.finish_reason;
        });
        if (!completed) throw modelsError('invalid-response');
        if (calls.size) message = { ...message, tool_calls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value) };
        return validateResponse({ ...envelope, choices: [{ index: 0, message, finish_reason: finish }], ...(usage === undefined ? {} : { usage }) });
      }));
    },
    commit: input => commit(input.state, input.intent, input.response),
    discover: input => discover(options, input), check: input => check(options, input),
  };
}
export function createChatCompletionsProtocolComponent(options: ProtocolOptions = {}) { return protocolComponent(createChatCompletionsProtocol(options)); }

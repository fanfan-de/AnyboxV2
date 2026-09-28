import { randomUUID } from 'node:crypto';
import { modelsError } from '../errors.js';
import type { DeclaredCapabilities, DiscoveredModel, EffectiveCapabilities, FormField, GenerationOptions, JsonValue, ModelMessage, ModelProtocol, ModelResult, ModelUsage, ProtocolCallInput, ProtocolOutcome, ToolCall } from '../types.js';
import { array, captureOptions, connectionFields, object, parseJson, protocolComponent, string, validateProvider, type NativeObject, type ProtocolOptions } from './shared.js';
import { pagedDiscover, request } from './transport.js';

const protocolId = 'anthropic-messages';
const requestOptions = { headers: { 'anthropic-version': '2023-06-01' }, authHeader: 'anthropic-api-key' } as const;
const modes = ['disabled', 'adaptive', 'enabled'] as const;
const efforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const displays = ['summarized', 'omitted'] as const;
const modelFields: readonly FormField[] = [
  { key: 'temperature', label: 'Temperature', type: 'number', min: 0, max: 1, description: 'Thinking requires the default temperature. Newer models may reject other values.' },
  { key: 'maxOutputTokens', label: 'Maximum output tokens', type: 'number', min: 1, integer: true, required: true, defaultValue: 4096 },
  { key: 'protocol.reasoningMode', label: 'Thinking mode', type: 'enum', values: modes, description: 'Only use modes explicitly declared for this model. Omit to use the server default.' },
  { key: 'protocol.reasoningBudgetTokens', label: 'Thinking token budget', type: 'number', min: 1024, integer: true, description: 'Required in enabled mode, and smaller than the maximum output tokens.' },
  { key: 'protocol.reasoningEffort', label: 'Reasoning effort', type: 'enum', values: efforts, description: 'Only use effort levels explicitly declared for this model.' },
  { key: 'protocol.reasoningDisplay', label: 'Thinking display', type: 'enum', values: displays, description: 'Requires an explicit adaptive or enabled thinking mode.' },
];

interface NativeMessage { readonly role: 'user' | 'assistant'; readonly content: readonly NativeObject[] }
interface AnthropicContinuation {
  readonly kind: typeof protocolId;
  readonly system: readonly NativeObject[];
  readonly messages: readonly NativeMessage[];
  readonly toolIds: readonly (readonly [string, string])[];
}
interface RequestState {
  readonly system: readonly NativeObject[];
  readonly messages: readonly NativeMessage[];
  readonly toolIds: ReadonlyMap<string, string>;
}
interface StreamBlock {
  readonly native: NativeObject;
  stopped: boolean;
  json?: string;
}

function nonempty(value: unknown): string {
  const parsed = string(value);
  if (!parsed) throw modelsError('invalid-response');
  return parsed;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw modelsError('invalid-response');
  return value;
}
function supported(value: unknown): boolean {
  const raw = object(value);
  if (typeof raw.supported !== 'boolean') throw modelsError('invalid-response');
  return raw.supported;
}
function validateOptions(options: GenerationOptions, declared: DeclaredCapabilities): void {
  if (Object.keys(options).some(key => !['temperature', 'maxOutputTokens', 'protocol'].includes(key))) throw modelsError('invalid-config');
  if (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens! < 1) throw modelsError('invalid-config');
  if (options.temperature !== undefined && (typeof options.temperature !== 'number' || !Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 1)) throw modelsError('invalid-config');
  const specific = options.protocol ?? {};
  if (specific === null || typeof specific !== 'object' || Array.isArray(specific) || Object.keys(specific).some(key => !['reasoningMode', 'reasoningBudgetTokens', 'reasoningEffort', 'reasoningDisplay'].includes(key))) throw modelsError('invalid-config');
  const mode = specific.reasoningMode;
  if (mode !== undefined) {
    if (typeof mode !== 'string' || !modes.includes(mode as typeof modes[number])) throw modelsError('invalid-config');
    if (declared.reasoning.support !== 'supported' || !declared.reasoning.modes?.includes(mode)) throw modelsError('capability-unsupported');
  }
  const budget = specific.reasoningBudgetTokens;
  if (mode === 'enabled') {
    if (typeof budget !== 'number' || !Number.isSafeInteger(budget) || budget < 1024 || budget >= options.maxOutputTokens!) throw modelsError('invalid-config');
    if (declared.reasoning.budget && (budget < declared.reasoning.budget.min || budget > declared.reasoning.budget.max)) throw modelsError('capability-unsupported');
  } else if (budget !== undefined) throw modelsError('invalid-config');
  if ((mode === 'adaptive' || mode === 'enabled') && options.temperature !== undefined && options.temperature !== 1) throw modelsError('invalid-config');
  const effort = specific.reasoningEffort;
  if (effort !== undefined) {
    if (typeof effort !== 'string' || !efforts.includes(effort as typeof efforts[number])) throw modelsError('invalid-config');
    if (declared.reasoning.support !== 'supported' || !declared.reasoning.efforts?.includes(effort)) throw modelsError('capability-unsupported');
  }
  const display = specific.reasoningDisplay;
  if (display !== undefined && (typeof display !== 'string' || !displays.includes(display as typeof displays[number]) || (mode !== 'adaptive' && mode !== 'enabled'))) throw modelsError('invalid-config');
}
function effectiveCapabilities(declared: DeclaredCapabilities, options: GenerationOptions): EffectiveCapabilities {
  const declaredModes = declared.reasoning.modes?.filter(mode => modes.includes(mode as typeof modes[number]));
  const declaredEfforts = declared.reasoning.efforts?.filter(effort => efforts.includes(effort as typeof efforts[number]));
  return {
    tools: declared.tools.support === 'supported', streaming: declared.streaming.support === 'supported', imageInput: false,
    reasoning: {
      support: options.protocol?.reasoningMode === 'disabled' ? 'unsupported' : declared.reasoning.support,
      ...(declaredModes?.length ? { modes: declaredModes } : {}),
      ...(declaredEfforts?.length ? { efforts: declaredEfforts } : {}),
      ...(declared.reasoning.budget ? { budget: declared.reasoning.budget } : {}),
    },
  };
}

function append(messages: NativeMessage[], role: NativeMessage['role'], content: readonly NativeObject[]): void {
  const previous = messages.at(-1);
  if (previous?.role === role) messages[messages.length - 1] = { role, content: [...previous.content, ...content] };
  else messages.push({ role, content });
}
function encode(messages: readonly ModelMessage[], toolIds: Map<string, string>, allowSystem: boolean): { system: NativeObject[]; messages: NativeMessage[] } {
  const system: NativeObject[] = [];
  const result: NativeMessage[] = [];
  let leading = allowSystem;
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      if (!leading) throw modelsError('invalid-config');
      if (message.content) system.push({ type: 'text', text: message.content });
      continue;
    }
    leading = false;
    if (message.role === 'tool') {
      const nativeId = toolIds.get(message.callId);
      if (!nativeId) throw modelsError('invalid-config');
      append(result, 'user', [{ type: 'tool_result', tool_use_id: nativeId, content: message.content }]);
    } else if (message.role === 'assistant') {
      const content: NativeObject[] = message.content ? [{ type: 'text', text: message.content }] : [];
      for (const call of message.toolCalls ?? []) {
        if (call.arguments === null || typeof call.arguments !== 'object' || Array.isArray(call.arguments)) throw modelsError('invalid-config');
        if (toolIds.has(call.id)) throw modelsError('invalid-config');
        const nativeId = `toolu_${randomUUID().replaceAll('-', '')}`;
        toolIds.set(call.id, nativeId);
        content.push({ type: 'tool_use', id: nativeId, name: call.name, input: call.arguments });
      }
      append(result, 'assistant', content);
    } else append(result, 'user', [{ type: 'text', text: message.content }]);
  }
  return { system, messages: result };
}
function nativeInput(input: ProtocolCallInput): RequestState {
  if (input.continuation === undefined) {
    const toolIds = new Map<string, string>();
    return { ...encode(input.messages, toolIds, true), toolIds };
  }
  const raw = object(input.continuation);
  if (raw.kind !== protocolId) throw modelsError('invalid-response');
  const toolIds = new Map<string, string>();
  for (const pair of array(raw.toolIds)) {
    const entries = array(pair);
    if (entries.length !== 2 || toolIds.has(nonempty(entries[0]))) throw modelsError('invalid-response');
    toolIds.set(nonempty(entries[0]), nonempty(entries[1]));
  }
  const system = array(raw.system).map(object);
  const messages = array(raw.messages).map(value => {
    const message = object(value);
    if (message.role !== 'user' && message.role !== 'assistant') throw modelsError('invalid-response');
    return { role: message.role, content: array(message.content).map(object) } satisfies NativeMessage;
  });
  const added = encode(input.newMessages, toolIds, false);
  for (const message of added.messages) append(messages, message.role, message.content);
  return { system, messages, toolIds };
}
function body(input: ProtocolCallInput, state: RequestState): NativeObject {
  const specific = input.options.protocol ?? {};
  const mode = specific.reasoningMode;
  return {
    model: input.remoteModelId, messages: state.messages, max_tokens: input.options.maxOutputTokens, stream: input.capabilities.streaming,
    ...(state.system.length ? { system: state.system } : {}),
    ...(input.options.temperature === undefined ? {} : { temperature: input.options.temperature }),
    ...(mode === undefined ? {} : { thinking: {
      type: mode,
      ...(mode === 'enabled' ? { budget_tokens: specific.reasoningBudgetTokens } : {}),
      ...(specific.reasoningDisplay === undefined ? {} : { display: specific.reasoningDisplay }),
    } }),
    ...(specific.reasoningEffort === undefined ? {} : { output_config: { effort: specific.reasoningEffort } }),
    ...(input.tools.length ? { tools: input.tools.map(tool => ({ name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), input_schema: tool.parameters })) } : {}),
  };
}
function nativeUsage(value: unknown): ModelUsage | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = object(value);
  const input = raw.input_tokens === undefined ? undefined : integer(raw.input_tokens);
  const output = raw.output_tokens === undefined ? undefined : integer(raw.output_tokens);
  const creation = raw.cache_creation_input_tokens === undefined ? 0 : integer(raw.cache_creation_input_tokens);
  const cached = raw.cache_read_input_tokens === undefined ? 0 : integer(raw.cache_read_input_tokens);
  const inputTokens = input === undefined ? undefined : integer(input + creation + cached);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }), ...(output === undefined ? {} : { outputTokens: output }),
    ...(inputTokens === undefined || output === undefined ? {} : { totalTokens: integer(inputTokens + output) }),
  };
}
function status(reason: unknown, details: unknown): ModelResult['status'] {
  if (typeof reason !== 'string' || !['end_turn', 'stop_sequence', 'tool_use', 'max_tokens', 'model_context_window_exceeded', 'pause_turn', 'refusal'].includes(reason)) throw modelsError('invalid-response');
  if (reason === 'refusal' || (details != null && object(details).type === 'refusal')) return 'refused';
  return ['max_tokens', 'model_context_window_exceeded', 'pause_turn'].includes(reason) ? 'incomplete' : 'completed';
}
function parseMessage(raw: unknown, state: RequestState, streamIds: ReadonlyMap<number, string> = new Map()): ProtocolOutcome {
  const message = object(raw);
  if (message.error != null || message.type === 'error') throw modelsError('provider-failure');
  if (message.type !== 'message' || message.role !== 'assistant') throw modelsError('invalid-response');
  const resultStatus = status(message.stop_reason, message.stop_details);
  const content = array(message.content).map(object);
  const toolIds = new Map(state.toolIds);
  const seenNativeIds = new Set(toolIds.values());
  const calls: ToolCall[] = [];
  let text = '';
  for (const [index, block] of content.entries()) {
    if (block.type === 'text') text += string(block.text);
    else if (block.type === 'thinking') {
      string(block.thinking);
      if (resultStatus === 'completed') nonempty(block.signature);
      else if (block.signature !== undefined) string(block.signature);
    } else if (block.type === 'redacted_thinking') nonempty(block.data);
    else if (block.type === 'tool_use') {
      const nativeId = nonempty(block.id);
      const name = nonempty(block.name);
      if (seenNativeIds.has(nativeId)) throw modelsError('invalid-response');
      seenNativeIds.add(nativeId);
      if (resultStatus === 'completed') {
        const id = streamIds.get(index) ?? randomUUID();
        const args = object(block.input);
        toolIds.set(id, nativeId);
        calls.push({ id, name, arguments: args as JsonValue });
      }
    } else throw modelsError('invalid-response');
  }
  if (resultStatus === 'completed' && ((message.stop_reason === 'tool_use') !== (calls.length > 0))) throw modelsError('invalid-response');
  return {
    result: { status: resultStatus, text, toolCalls: calls, ...(message.usage == null ? {} : { usage: nativeUsage(message.usage) }) },
    ...(resultStatus === 'completed' ? { continuation: {
      kind: protocolId, system: state.system, messages: [...state.messages, { role: 'assistant', content }], toolIds: [...toolIds],
    } satisfies AnthropicContinuation } : {}),
  };
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

export function createAnthropicMessagesProtocol(options: ProtocolOptions = {}): ModelProtocol {
  options = captureOptions(options);
  return {
    descriptor: { id: protocolId, version: '1.0.0', name: 'Anthropic Messages', connectionFields, modelFields, supportsDiscovery: true, supportsCheck: true },
    validateProvider: provider => validateProvider(provider, protocolId), validateOptions, effectiveCapabilities,
    discover: input => pagedDiscover(options, input, 'models?limit=1000', parsePage, requestOptions),
    check: input => request(options, input, 'models?limit=1', undefined, async reader => { parsePage(await reader.json()); }, requestOptions),
    call(input) {
      const state = nativeInput(input);
      return request(options, input, 'messages', body(input, state), async reader => {
        if (!input.capabilities.streaming) {
          const raw = await reader.json();
          const outcome = parseMessage(raw, state);
          for (const value of array(object(raw).content)) {
            const block = object(value);
            if (block.type === 'thinking' && block.thinking) input.onEvent({ type: 'reasoning-summary-delta', delta: string(block.thinking) });
          }
          return outcome;
        }
        let message: NativeObject | undefined;
        let terminal: ProtocolOutcome | undefined;
        const blocks = new Map<number, StreamBlock>();
        const publicIds = new Map<number, string>();
        const nativeIds = new Set(state.toolIds.values());
        await reader.sse(data => {
          const event = object(parseJson(data));
          const type = string(event.type);
          if (type === 'error') throw modelsError('provider-failure');
          if (type === 'ping') return;
          if (type === 'message_start') {
            if (message) throw modelsError('invalid-response');
            const raw = object(event.message);
            if (raw.type !== 'message' || raw.role !== 'assistant' || array(raw.content).length || raw.stop_reason != null) throw modelsError('invalid-response');
            if (raw.usage !== undefined) nativeUsage(raw.usage);
            message = { ...raw };
          } else if (type === 'content_block_start') {
            if (!message || message.stop_reason != null) throw modelsError('invalid-response');
            const index = integer(event.index);
            if (blocks.has(index)) throw modelsError('invalid-response');
            const native = { ...object(event.content_block) };
            if (native.type === 'text') string(native.text);
            else if (native.type === 'thinking') { string(native.thinking); if (native.signature !== undefined) string(native.signature); }
            else if (native.type === 'redacted_thinking') nonempty(native.data);
            else if (native.type !== 'tool_use') throw modelsError('invalid-response');
            let publicId: string | undefined;
            if (native.type === 'tool_use') {
              const id = nonempty(native.id);
              const name = nonempty(native.name);
              object(native.input);
              if (nativeIds.has(id)) throw modelsError('invalid-response');
              nativeIds.add(id);
              publicId = randomUUID(); publicIds.set(index, publicId);
              input.onEvent({ type: 'tool-call-delta', index, id: publicId, name, argumentsDelta: Object.keys(object(native.input)).length ? JSON.stringify(native.input) : '' });
            }
            blocks.set(index, { native, stopped: false });
          } else if (type === 'content_block_delta') {
            if (!message || message.stop_reason != null) throw modelsError('invalid-response');
            const index = integer(event.index);
            const block = blocks.get(index);
            if (!block || block.stopped) throw modelsError('invalid-response');
            const delta = object(event.delta);
            if (delta.type === 'text_delta' && block.native.type === 'text') {
              const part = string(delta.text); block.native.text = string(block.native.text) + part;
              if (part) input.onEvent({ type: 'text-delta', delta: part });
            } else if (delta.type === 'thinking_delta' && block.native.type === 'thinking') {
              const part = string(delta.thinking); block.native.thinking = string(block.native.thinking) + part;
              if (part) input.onEvent({ type: 'reasoning-summary-delta', delta: part });
            } else if (delta.type === 'signature_delta' && block.native.type === 'thinking') {
              block.native.signature = (block.native.signature === undefined ? '' : string(block.native.signature)) + string(delta.signature);
            } else if (delta.type === 'input_json_delta' && block.native.type === 'tool_use') {
              if (Object.keys(object(block.native.input)).length) throw modelsError('invalid-response');
              const part = string(delta.partial_json); block.json = (block.json ?? '') + part;
              input.onEvent({ type: 'tool-call-delta', index, argumentsDelta: part });
            } else throw modelsError('invalid-response');
          } else if (type === 'content_block_stop') {
            if (!message || message.stop_reason != null) throw modelsError('invalid-response');
            const block = blocks.get(integer(event.index));
            if (!block || block.stopped) throw modelsError('invalid-response');
            block.stopped = true;
          } else if (type === 'message_delta') {
            if (!message || [...blocks.values()].some(block => !block.stopped)) throw modelsError('invalid-response');
            const delta = object(event.delta);
            if (delta.stop_reason != null) {
              status(delta.stop_reason, delta.stop_details);
              if (message.stop_reason != null && message.stop_reason !== delta.stop_reason) throw modelsError('invalid-response');
            }
            message = { ...message, ...delta };
            if (event.usage !== undefined) {
              message.usage = { ...(message.usage == null ? {} : object(message.usage)), ...object(event.usage) };
              nativeUsage(message.usage);
            }
          } else if (type === 'message_stop') {
            if (!message || [...blocks.values()].some(block => !block.stopped)) throw modelsError('invalid-response');
            const resultStatus = status(message.stop_reason, message.stop_details);
            const content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([index, block], position) => {
              if (index !== position) throw modelsError('invalid-response');
              if (resultStatus === 'completed' && block.native.type === 'tool_use' && block.json !== undefined && block.json !== '') block.native.input = object(parseJson(block.json));
              return block.native;
            });
            terminal = parseMessage({ ...message, content }, state, publicIds);
            return true;
          }
        });
        if (!terminal) throw modelsError('invalid-response');
        return terminal;
      }, requestOptions);
    },
  };
}
export function createAnthropicMessagesProtocolComponent(options: ProtocolOptions = {}) {
  return protocolComponent(createAnthropicMessagesProtocol(options));
}

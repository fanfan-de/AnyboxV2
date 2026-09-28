import { modelsError } from '../errors.js';
import { json } from '../domain.js';
import type { DeclaredCapabilities, DiscoveredModel, EffectiveCapabilities, GenerationOptions, JsonValue, ModelMessage, ModelProtocol, ModelResult, ModelUsage, ProtocolCallInput, ProtocolOutcome } from '../types.js';
import { array, captureOptions, connectionFields, object, parseJson, protocolComponent, string, validateProvider, type NativeObject, type ProtocolOptions } from './shared.js';
import { pagedDiscover, request } from './transport.js';

const levels = ['minimal', 'low', 'medium', 'high'] as const;
const authentication = { authHeader: 'google-api-key' } as const;
interface CallIdentity { readonly publicId: string; readonly nativeId: string; readonly name: string }
interface GeminiContinuation {
  readonly kind: 'gemini-interactions';
  readonly input: readonly NativeObject[];
  readonly calls: readonly CallIdentity[];
  readonly nextCallId: number;
}
interface RequestState {
  readonly input: readonly NativeObject[];
  readonly calls: CallIdentity[];
  readonly reservedIds: Set<string>;
  readonly outputCalls: Map<string, CallIdentity>;
  nextCallId: number;
}
interface StreamStep {
  readonly step: NativeObject;
  stopped: boolean;
  arguments?: string;
}
function nonempty(value: unknown): string {
  const result = string(value);
  if (!result.trim()) throw modelsError('invalid-response');
  return result;
}
function index(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) throw modelsError('invalid-response');
  return value;
}
function textContent(text: string): NativeObject { return { type: 'text', text }; }
function systemInstructions(messages: readonly ModelMessage[]): readonly string[] {
  const instructions: string[] = [];
  let leading = true;
  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      if (!leading) throw modelsError('invalid-config');
      instructions.push(message.content);
    } else leading = false;
  }
  return instructions;
}
function encode(messages: readonly ModelMessage[], calls: CallIdentity[]): NativeObject[] {
  return messages.flatMap((message): NativeObject[] => {
    if (message.role === 'system' || message.role === 'developer') return [];
    if (message.role === 'tool') {
      const call = calls.find(value => value.publicId === message.callId);
      if (!call) throw modelsError('invalid-response');
      return [{ type: 'function_result', call_id: call.nativeId, name: call.name, result: [textContent(message.content)] }];
    }
    if (message.role === 'user') return [{ type: 'user_input', content: [textContent(message.content)] }];
    if (message.role !== 'assistant') return [];
    const result: NativeObject[] = message.content || !message.toolCalls?.length
      ? [{ type: 'model_output', content: [textContent(message.content)] }] : [];
    for (const call of message.toolCalls ?? []) {
      object(call.arguments);
      if (calls.some(value => value.publicId === call.id)) throw modelsError('invalid-response');
      calls.push({ publicId: call.id, nativeId: call.id, name: call.name });
      result.push({ type: 'function_call', id: call.id, name: call.name, arguments: call.arguments });
    }
    return result;
  });
}
function requestState(input: ProtocolCallInput): RequestState {
  const reservedIds = new Set(input.messages.flatMap(message => message.role === 'assistant' ? (message.toolCalls ?? []).map(call => call.id) : []));
  const calls: CallIdentity[] = [];
  let previous: readonly NativeObject[] = [];
  let nextCallId = 0;
  if (input.continuation !== undefined) {
    const state = object(input.continuation);
    if (state.kind !== 'gemini-interactions') throw modelsError('invalid-response');
    previous = array(state.input).map(object);
    nextCallId = index(state.nextCallId);
    for (const value of array(state.calls)) {
      const call = object(value);
      const identity = { publicId: nonempty(call.publicId), nativeId: nonempty(call.nativeId), name: nonempty(call.name) };
      if (calls.some(existing => existing.publicId === identity.publicId)) throw modelsError('invalid-response');
      calls.push(identity);
      reservedIds.add(identity.publicId);
    }
  }
  return { input: [...previous, ...encode(input.continuation === undefined ? input.messages : input.newMessages, calls)], calls, reservedIds, outputCalls: new Map(), nextCallId };
}
function outputIdentity(state: RequestState, nativeId: string, name: string): CallIdentity {
  const previous = state.outputCalls.get(nativeId);
  if (previous) {
    if (previous.name !== name) throw modelsError('invalid-response');
    return previous;
  }
  let publicId: string;
  do {
    if (state.nextCallId >= 2_147_483_647) throw modelsError('invalid-response');
    publicId = `gemini-call-${state.nextCallId++}`;
  } while (state.reservedIds.has(publicId));
  state.reservedIds.add(publicId);
  const identity = { publicId, nativeId, name };
  state.outputCalls.set(nativeId, identity);
  return identity;
}
function modelText(step: NativeObject): string {
  if (step.error != null) throw modelsError('provider-failure');
  return (step.content === undefined ? [] : array(step.content)).map(value => {
    const content = object(value);
    if (content.type !== 'text') throw modelsError('invalid-response');
    return string(content.text);
  }).join('');
}
function validateThought(step: NativeObject): void {
  if (step.signature !== undefined) string(step.signature);
  if (step.summary !== undefined) {
    for (const value of array(step.summary)) {
      const content = object(value);
      if (content.type !== 'text') throw modelsError('invalid-response');
      string(content.text);
    }
  }
}
function nativeUsage(value: unknown): ModelUsage | undefined {
  if (value == null) return undefined;
  const raw = object(value);
  const result: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};
  for (const [key, nativeKey] of [['inputTokens', 'total_input_tokens'], ['outputTokens', 'total_output_tokens'], ['totalTokens', 'total_tokens']] as const) {
    const count = raw[nativeKey];
    if (count !== undefined && count !== null) {
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw modelsError('invalid-response');
      result[key] = count;
    }
  }
  return result;
}
function toolArguments(value: unknown): Readonly<Record<string, JsonValue>> {
  const argumentsObject = object(value);
  if (!json(argumentsObject)) throw modelsError('invalid-response');
  return argumentsObject as Readonly<Record<string, JsonValue>>;
}
function terminalStatus(response: NativeObject): ModelResult['status'] {
  if (response.errors !== undefined && array(response.errors).length) throw modelsError('provider-failure');
  if (response.status === 'failed' || response.status === 'cancelled') throw modelsError('provider-failure');
  if (response.status === 'completed' || response.status === 'requires_action') return 'completed';
  if (response.status === 'incomplete' || response.status === 'budget_exceeded') return 'incomplete';
  throw modelsError('invalid-response');
}
function parseResponse(raw: unknown, state: RequestState): ProtocolOutcome {
  const response = object(raw);
  const status = terminalStatus(response);
  const steps = array(response.steps).map(object);
  const calls: ModelResult['toolCalls'][number][] = [];
  const identities: CallIdentity[] = [];
  const nativeIds = new Set<string>();
  let text = '';
  for (const step of steps) {
    if (step.type === 'model_output') text += modelText(step);
    else if (step.type === 'thought') validateThought(step);
    else if (step.type === 'function_call') {
      // Truncated calls may contain unfinished streamed JSON. They never execute.
      if (status !== 'completed') continue;
      const nativeId = nonempty(step.id);
      const name = nonempty(step.name);
      if (nativeIds.has(nativeId)) throw modelsError('invalid-response');
      nativeIds.add(nativeId);
      const identity = outputIdentity(state, nativeId, name);
      calls.push({ id: identity.publicId, name, arguments: toolArguments(step.arguments) });
      identities.push(identity);
    } else throw modelsError('invalid-response');
  }
  if (response.status === 'requires_action' && !calls.length) throw modelsError('invalid-response');
  const usage = nativeUsage(response.usage);
  return {
    result: { status, text, toolCalls: calls, ...(usage === undefined ? {} : { usage }) },
    ...(status === 'completed' ? { continuation: {
      kind: 'gemini-interactions', input: [...state.input, ...steps], calls: [...state.calls, ...identities], nextCallId: state.nextCallId,
    } satisfies GeminiContinuation } : {}),
  };
}
function body(input: ProtocolCallInput, state: RequestState): NativeObject {
  const instructions = systemInstructions(input.messages);
  const generation: NativeObject = {};
  if (input.options.maxOutputTokens !== undefined) generation.max_output_tokens = input.options.maxOutputTokens;
  if (input.options.protocol?.thinkingLevel !== undefined) generation.thinking_level = input.options.protocol.thinkingLevel;
  if (input.options.protocol?.thinkingSummaries !== undefined) generation.thinking_summaries = input.options.protocol.thinkingSummaries;
  return {
    model: input.remoteModelId, input: state.input, store: false, stream: input.capabilities.streaming,
    ...(instructions.length ? { system_instruction: instructions.join('\n\n') } : {}),
    ...(Object.keys(generation).length ? { generation_config: generation } : {}),
    ...(input.tools.length ? { tools: input.tools.map(tool => ({ type: 'function', name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), parameters: tool.parameters })) } : {}),
  };
}
function validateOptions(options: GenerationOptions, declared: DeclaredCapabilities): void {
  if (Object.keys(options).some(key => !['maxOutputTokens', 'protocol'].includes(key))) throw modelsError('invalid-config');
  if (options.maxOutputTokens !== undefined && (!Number.isSafeInteger(options.maxOutputTokens) || options.maxOutputTokens < 1 || options.maxOutputTokens > 2_147_483_647)) throw modelsError('invalid-config');
  if (options.protocol === null) throw modelsError('invalid-config');
  const specific = options.protocol ?? {};
  if (specific === null || typeof specific !== 'object' || Array.isArray(specific) || Object.keys(specific).some(key => !['thinkingLevel', 'thinkingSummaries'].includes(key))) throw modelsError('invalid-config');
  const level = specific.thinkingLevel;
  if (level !== undefined) {
    if (typeof level !== 'string' || !levels.includes(level as typeof levels[number])) throw modelsError('invalid-config');
    if (declared.reasoning.support !== 'supported' || !declared.reasoning.efforts?.includes(level)) throw modelsError('capability-unsupported');
  }
  const summaries = specific.thinkingSummaries;
  if (summaries !== undefined) {
    if (typeof summaries !== 'string' || !['auto', 'none'].includes(summaries)) throw modelsError('invalid-config');
    if (declared.reasoning.support !== 'supported') throw modelsError('capability-unsupported');
  }
}
function effectiveCapabilities(declared: DeclaredCapabilities): EffectiveCapabilities {
  const efforts = declared.reasoning.efforts?.filter(value => levels.includes(value as typeof levels[number]));
  return { tools: declared.tools.support === 'supported', streaming: declared.streaming.support === 'supported', imageInput: false,
    reasoning: { support: declared.reasoning.support, ...(efforts?.length ? { efforts } : {}) } };
}
function discoverPage(raw: unknown): { models: readonly DiscoveredModel[]; nextPath?: string } {
  const page = object(raw);
  const models = (page.models === undefined ? [] : array(page.models)).map(value => {
    const model = object(value);
    const resource = nonempty(model.name);
    const remoteModelId = resource.startsWith('models/') ? resource.slice('models/'.length) : resource;
    if (!remoteModelId) throw modelsError('invalid-response');
    return { remoteModelId, name: model.displayName === undefined ? remoteModelId : nonempty(model.displayName) };
  });
  const token = page.nextPageToken;
  if (token !== undefined && typeof token !== 'string') throw modelsError('invalid-response');
  return { models, ...(token ? { nextPath: `models?pageSize=1000&pageToken=${encodeURIComponent(token)}` } : {}) };
}
function startStep(raw: unknown): StreamStep {
  const step = object(raw);
  if (step.type === 'model_output') {
    modelText(step);
    return { step: { ...step, content: (step.content === undefined ? [] : array(step.content)).map(value => ({ ...object(value) })) }, stopped: false };
  }
  if (step.type === 'thought') {
    validateThought(step);
    return { step: { ...step, ...(step.summary === undefined ? {} : { summary: [...array(step.summary)] }) }, stopped: false };
  }
  if (step.type === 'function_call') {
    nonempty(step.id); nonempty(step.name); object(step.arguments);
    return { step: { ...step }, stopped: false };
  }
  throw modelsError('invalid-response');
}
function appendText(step: NativeObject, delta: string): void {
  const content = array(step.content).map(object);
  const last = content.at(-1);
  if (last) last.text = string(last.text) + delta;
  else content.push(textContent(delta));
  step.content = content;
}
export function createGeminiInteractionsProtocol(options: ProtocolOptions = {}): ModelProtocol {
  options = captureOptions(options);
  return {
    descriptor: { id: 'gemini-interactions', version: '1.0.0', name: 'Gemini Interactions', connectionFields,
      modelFields: [
        { key: 'maxOutputTokens', label: 'Maximum output tokens', type: 'number', min: 1, max: 2_147_483_647, integer: true },
        { key: 'protocol.thinkingLevel', label: 'Thinking level', type: 'enum', values: levels, description: 'Only use levels declared for this model. Omit to use the server default.' },
        { key: 'protocol.thinkingSummaries', label: 'Thinking summaries', type: 'enum', values: ['auto', 'none'] },
      ], supportsDiscovery: true, supportsCheck: true },
    validateProvider: provider => validateProvider(provider, 'gemini-interactions'),
    validateOptions, effectiveCapabilities,
    discover: input => pagedDiscover(options, input, 'models?pageSize=1000', discoverPage, authentication),
    check: input => request(options, input, 'models?pageSize=1000', undefined, async reader => { discoverPage(await reader.json()); }, authentication),
    call(input) {
      const state = requestState(input);
      return request(options, input, 'interactions', body(input, state), async reader => {
        if (!input.capabilities.streaming) {
          const raw = await reader.json();
          const outcome = parseResponse(raw, state);
          for (const value of array(object(raw).steps)) {
            const step = object(value);
            if (step.type === 'thought') for (const item of step.summary === undefined ? [] : array(step.summary)) {
              const delta = string(object(item).text);
              if (delta) input.onEvent({ type: 'reasoning-summary-delta', delta });
            }
          }
          return outcome;
        }
        const steps = new Map<number, StreamStep>();
        const callIds = new Set<string>();
        let terminal: ProtocolOutcome | undefined;
        await reader.sse(data => {
          if (data === '[DONE]') { if (!terminal) throw modelsError('invalid-response'); return; }
          if (terminal) throw modelsError('invalid-response');
          const event = object(parseJson(data));
          const type = string(event.event_type);
          if (type === 'error') throw modelsError('provider-failure');
          if (type === 'interaction.created' || type === 'interaction.status_update') return;
          if (type === 'interaction.completed') {
            const response = object(event.interaction);
            nonempty(response.id);
            const status = terminalStatus(response);
            const ordered = [...steps.entries()].sort(([a], [b]) => a - b);
            if (ordered.some(([position, step], order) => position !== order || (status === 'completed' && !step.stopped))) throw modelsError('invalid-response');
            const output = response.steps === undefined ? ordered.map(([, step]) => ({ ...step.step,
              ...(step.arguments === undefined ? {} : { arguments: status === 'completed' ? object(parseJson(step.arguments)) : step.arguments }),
            })) : array(response.steps);
            terminal = parseResponse({ ...response, steps: output }, state);
            return true;
          }
          if (type === 'step.start') {
            const position = index(event.index);
            if (steps.has(position)) throw modelsError('invalid-response');
            const step = startStep(event.step);
            steps.set(position, step);
            if (step.step.type === 'model_output') {
              const text = modelText(step.step);
              if (text) input.onEvent({ type: 'text-delta', delta: text });
            } else if (step.step.type === 'thought') {
              for (const value of step.step.summary === undefined ? [] : array(step.step.summary)) input.onEvent({ type: 'reasoning-summary-delta', delta: string(object(value).text) });
            } else if (step.step.type === 'function_call') {
              const nativeId = nonempty(step.step.id);
              if (callIds.has(nativeId)) throw modelsError('invalid-response');
              callIds.add(nativeId);
              const call = outputIdentity(state, nativeId, nonempty(step.step.name));
              input.onEvent({ type: 'tool-call-delta', index: position, id: call.publicId, name: call.name,
                ...(Object.keys(object(step.step.arguments)).length ? { argumentsDelta: JSON.stringify(step.step.arguments) } : {}) });
            }
            return;
          }
          const position = index(event.index);
          const step = steps.get(position);
          if (!step || step.stopped) throw modelsError('invalid-response');
          if (type === 'step.stop') { step.stopped = true; return; }
          if (type !== 'step.delta') throw modelsError('invalid-response');
          const delta = object(event.delta);
          if (delta.type === 'text' && step.step.type === 'model_output') {
            const text = string(delta.text);
            appendText(step.step, text);
            input.onEvent({ type: 'text-delta', delta: text });
          } else if (delta.type === 'text_annotation_delta' && step.step.type === 'model_output') {
            if (delta.annotations !== undefined) {
              const content = array(step.step.content).map(object);
              const last = content.at(-1);
              if (!last) throw modelsError('invalid-response');
              last.annotations = [...(last.annotations === undefined ? [] : array(last.annotations)), ...array(delta.annotations).map(object)];
            }
          } else if (delta.type === 'arguments_delta' && step.step.type === 'function_call') {
            if (delta.arguments !== undefined) {
              if (Object.keys(object(step.step.arguments)).length) throw modelsError('invalid-response');
              const value = string(delta.arguments);
              step.arguments = (step.arguments ?? '') + value;
              input.onEvent({ type: 'tool-call-delta', index: position, argumentsDelta: value });
            }
          } else if (delta.type === 'thought_signature' && step.step.type === 'thought') {
            if (delta.signature !== undefined) step.step.signature = string(delta.signature);
          } else if (delta.type === 'thought_summary' && step.step.type === 'thought') {
            if (delta.content !== undefined) {
              const content = object(delta.content);
              if (content.type !== 'text') throw modelsError('invalid-response');
              const text = string(content.text);
              step.step.summary = [...(step.step.summary === undefined ? [] : array(step.step.summary)), content];
              input.onEvent({ type: 'reasoning-summary-delta', delta: text });
            }
          } else throw modelsError('invalid-response');
        });
        if (!terminal) throw modelsError('invalid-response');
        return terminal;
      }, authentication);
    },
  };
}
export function createGeminiInteractionsProtocolComponent(options: ProtocolOptions = {}) {
  return protocolComponent(createGeminiInteractionsProtocol(options));
}

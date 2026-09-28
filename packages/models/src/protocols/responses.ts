import { modelsError } from '../errors.js';
import type { ModelMessage, ModelProtocol, ModelResult, ProtocolCallInput, ProtocolOutcome } from '../types.js';
import { array, captureOptions, commonFields, connectionFields, effectiveCapabilities, effortField, object, parseJson, parseTool, protocolComponent, string, usage, validateOptions, validateProvider, type NativeObject, type ProtocolOptions } from './shared.js';
import { check, discover, request } from './transport.js';

interface ResponsesContinuation { readonly kind: 'responses'; readonly input: readonly NativeObject[] }
function encode(messages: readonly ModelMessage[]): NativeObject[] {
  return messages.flatMap((message): NativeObject[] => {
    if (message.role === 'tool') return [{ type: 'function_call_output', call_id: message.callId, output: message.content }];
    const text = { role: message.role, content: message.content };
    if (message.role !== 'assistant' || !message.toolCalls?.length) return [text];
    return [text, ...message.toolCalls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) }))];
  });
}
function nativeInput(input: ProtocolCallInput): readonly NativeObject[] {
  if (input.continuation === undefined) return encode(input.messages);
  const state = object(input.continuation);
  if (state.kind !== 'responses') throw modelsError('invalid-response');
  return [...array(state.input).map(object), ...encode(input.newMessages)];
}
function parseResponse(raw: unknown, requestInput: readonly NativeObject[]): ProtocolOutcome {
  const response = object(raw);
  if (response.error != null || response.status === 'failed' || response.status === 'cancelled') throw modelsError('provider-failure');
  if (typeof response.status !== 'string' || !['completed', 'incomplete'].includes(response.status)) throw modelsError('invalid-response');
  const output = array(response.output).map(object);
  let incomplete = response.status === 'incomplete';
  let refused = false;
  let text = '';
  const pendingCalls: NativeObject[] = [];
  for (const item of output) {
    if (item.status !== undefined && item.status !== 'completed') incomplete = true;
    if (item.type === 'reasoning') {
      if (item.encrypted_content !== undefined && item.encrypted_content !== null) string(item.encrypted_content);
      continue;
    }
    if (item.type === 'function_call') { pendingCalls.push(item); continue; }
    if (item.type !== 'message' || item.role !== 'assistant') throw modelsError('invalid-response');
    if (item.phase !== undefined && item.phase !== null && (typeof item.phase !== 'string' || !['commentary', 'final_answer'].includes(item.phase))) throw modelsError('invalid-response');
    for (const blockValue of array(item.content)) {
      const block = object(blockValue);
      if (block.type === 'output_text') text += string(block.text);
      else if (block.type === 'refusal') { string(block.refusal); refused = true; }
      else throw modelsError('invalid-response');
    }
  }
  const status: ModelResult['status'] = refused ? 'refused' : incomplete ? 'incomplete' : 'completed';
  const calls = status === 'completed' ? pendingCalls.map(call => parseTool(call.call_id, call.name, call.arguments)) : [];
  if (new Set(calls.map(call => call.id)).size !== calls.length) throw modelsError('invalid-response');
  return {
    result: { status, text, toolCalls: calls, ...(response.usage == null ? {} : { usage: usage(response.usage, true) }) },
    ...(status === 'completed' ? { continuation: { kind: 'responses', input: [...requestInput, ...output] } satisfies ResponsesContinuation } : {}),
  };
}
function body(input: ProtocolCallInput, items: readonly NativeObject[]): NativeObject {
  const effort = input.options.protocol?.reasoningEffort;
  const summary = input.options.protocol?.reasoningSummary;
  return {
    model: input.remoteModelId, input: items, store: false, stream: input.capabilities.streaming,
    // Explicit include keeps stateless continuation compatible with older Responses servers.
    include: ['reasoning.encrypted_content'],
    ...(input.options.temperature === undefined ? {} : { temperature: input.options.temperature }),
    ...(input.options.maxOutputTokens === undefined ? {} : { max_output_tokens: input.options.maxOutputTokens }),
    ...(effort === undefined && summary === undefined ? {} : { reasoning: { ...(effort === undefined ? {} : { effort }), ...(summary === undefined ? {} : { summary }) } }),
    ...(input.tools.length ? { tools: input.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })) } : {}),
  };
}
export function createResponsesProtocol(options: ProtocolOptions = {}): ModelProtocol {
  options = captureOptions(options);
  return {
    descriptor: { id: 'responses', version: '1.0.0', name: 'Responses', connectionFields,
      modelFields: [...commonFields, effortField, { key: 'protocol.reasoningSummary', label: 'Reasoning summary', type: 'enum', values: ['auto', 'concise', 'detailed'] }],
      supportsDiscovery: true, supportsCheck: true,
    },
    validateProvider: provider => validateProvider(provider, 'responses'),
    validateOptions: (generation, capabilities) => validateOptions(generation, capabilities, true),
    effectiveCapabilities,
    discover: input => discover(options, input), check: input => check(options, input),
    call(input) {
      const items = nativeInput(input);
      return request(options, input, 'responses', body(input, items), async reader => {
        if (!input.capabilities.streaming) return parseResponse(await reader.json(), items);
        let terminal: ProtocolOutcome | undefined;
        await reader.sse(data => {
          if (data === '[DONE]') {
            if (!terminal) throw modelsError('invalid-response');
            return;
          }
          if (terminal) throw modelsError('invalid-response');
          const event = object(parseJson(data));
          const type = string(event.type);
          if (type === 'error' || type === 'response.failed' || type === 'response.cancelled') throw modelsError('provider-failure');
          if (type === 'response.completed' || type === 'response.incomplete') {
            const response = object(event.response);
            if (response.status !== type.slice('response.'.length)) throw modelsError('invalid-response');
            terminal = parseResponse(response, items);
            return true;
          } else if (type === 'response.output_text.delta') {
            input.onEvent({ type: 'text-delta', delta: string(event.delta) });
          } else if (type === 'response.reasoning_summary_text.delta') {
            input.onEvent({ type: 'reasoning-summary-delta', delta: string(event.delta) });
          } else if (type === 'response.output_item.added') {
            const item = object(event.item);
            if (item.type === 'function_call') input.onEvent({ type: 'tool-call-delta', index: index(event.output_index), id: string(item.call_id), name: string(item.name), argumentsDelta: string(item.arguments) });
          } else if (type === 'response.function_call_arguments.delta') {
            input.onEvent({ type: 'tool-call-delta', index: index(event.output_index), argumentsDelta: string(event.delta) });
          }
        });
        if (!terminal) throw modelsError('invalid-response');
        return terminal;
      });
    },
  };
}
function index(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw modelsError('invalid-response');
  return value;
}
export function createResponsesProtocolComponent(options: ProtocolOptions = {}) {
  return protocolComponent(createResponsesProtocol(options));
}

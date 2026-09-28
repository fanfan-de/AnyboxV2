import { modelsError } from '../errors.js';
import type { ModelMessage, ModelProtocol, ModelResult, ProtocolCallInput, ProtocolOutcome } from '../types.js';
import { array, captureOptions, commonFields, connectionFields, effectiveCapabilities, effortField, object, parseJson, parseTool, protocolComponent, string, usage, validateOptions, validateProvider, type NativeObject, type ProtocolOptions } from './shared.js';
import { check, discover, request } from './transport.js';

function message(input: ModelMessage): NativeObject {
  if (input.role === 'tool') return { role: 'tool', tool_call_id: input.callId, content: input.content };
  if (input.role !== 'assistant') return { role: input.role, content: input.content };
  return {
    role: 'assistant', content: input.content,
    ...(input.toolCalls?.length ? { tool_calls: input.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}),
  };
}
function result(rawMessage: NativeObject, finish: unknown, rawUsage: unknown): ModelResult {
  if (typeof finish !== 'string' || !['stop', 'tool_calls', 'length', 'content_filter'].includes(finish)) throw modelsError('invalid-response');
  const content = rawMessage.content;
  if (content !== null && content !== undefined && typeof content !== 'string') throw modelsError('invalid-response');
  const refusal = rawMessage.refusal;
  if (refusal !== undefined && refusal !== null && typeof refusal !== 'string') throw modelsError('invalid-response');
  const status = finish === 'length' ? 'incomplete' : finish === 'content_filter' || Boolean(refusal) ? 'refused' : 'completed';
  const calls = status === 'completed' && rawMessage.tool_calls !== undefined ? array(rawMessage.tool_calls).map(value => {
    const call = object(value);
    if (call.type !== 'function') throw modelsError('invalid-response');
    const fn = object(call.function);
    return parseTool(call.id, fn.name, fn.arguments);
  }) : [];
  if (status === 'completed' && finish === 'tool_calls' && !calls.length) throw modelsError('invalid-response');
  if (new Set(calls.map(call => call.id)).size !== calls.length) throw modelsError('invalid-response');
  if (rawMessage.function_call !== undefined) throw modelsError('invalid-response');
  return { status, text: content ?? '', toolCalls: calls, ...(rawUsage === undefined ? {} : { usage: usage(rawUsage, false) }) } as ModelResult;
}
function body(input: ProtocolCallInput): NativeObject {
  return {
    model: input.remoteModelId, messages: input.messages.map(message), stream: input.capabilities.streaming,
    ...(input.capabilities.streaming ? { stream_options: { include_usage: true } } : {}),
    ...(input.options.temperature === undefined ? {} : { temperature: input.options.temperature }),
    ...(input.options.maxOutputTokens === undefined ? {} : { max_completion_tokens: input.options.maxOutputTokens }),
    ...(input.options.protocol?.reasoningEffort === undefined ? {} : { reasoning_effort: input.options.protocol.reasoningEffort }),
    ...(input.tools.length ? { tools: input.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters, strict: false } })) } : {}),
  };
}
export function createChatCompletionsProtocol(options: ProtocolOptions = {}): ModelProtocol {
  options = captureOptions(options);
  return {
    descriptor: { id: 'chat-completions', version: '1.0.0', name: 'Chat Completions', connectionFields, modelFields: [...commonFields, effortField], supportsDiscovery: true, supportsCheck: true },
    validateProvider: provider => validateProvider(provider, 'chat-completions'),
    validateOptions: (generation, capabilities) => validateOptions(generation, capabilities, false),
    effectiveCapabilities,
    discover: input => discover(options, input), check: input => check(options, input),
    call(input) {
      return request(options, input, 'chat/completions', body(input), async reader => {
        if (!input.capabilities.streaming) {
          const raw = object(await reader.json());
          const choices = array(raw.choices);
          if (choices.length !== 1) throw modelsError('invalid-response');
          const choice = object(choices[0]);
          return { result: result(object(choice.message), choice.finish_reason, raw.usage) };
        }
        let text = '';
        let refusal = '';
        let finish: unknown;
        let completed = false;
        let rawUsage: unknown;
        const calls = new Map<number, { id: string; name: string; arguments: string }>();
        await reader.sse(data => {
          if (data === '[DONE]') {
            if (completed || finish === undefined) throw modelsError('invalid-response');
            completed = true;
            return true;
          }
          if (completed) throw modelsError('invalid-response');
          const chunk = object(parseJson(data));
          if (chunk.error !== undefined) throw modelsError('provider-failure');
          if (chunk.usage !== undefined && chunk.usage !== null) rawUsage = chunk.usage;
          const choices = array(chunk.choices);
          if (choices.length > 1) throw modelsError('invalid-response');
          if (!choices.length) return;
          const choice = object(choices[0]);
          if (choice.index !== 0 || finish !== undefined) throw modelsError('invalid-response');
          const delta = object(choice.delta);
          if (delta.content !== undefined && delta.content !== null) {
            const part = string(delta.content); text += part;
            if (part) input.onEvent({ type: 'text-delta', delta: part });
          }
          if (delta.refusal !== undefined && delta.refusal !== null) refusal += string(delta.refusal);
          if (delta.function_call !== undefined) throw modelsError('invalid-response');
          if (delta.tool_calls !== undefined) for (const value of array(delta.tool_calls)) {
            const tool = object(value);
            if (typeof tool.index !== 'number' || !Number.isSafeInteger(tool.index) || tool.index < 0) throw modelsError('invalid-response');
            if (tool.type !== undefined && tool.type !== 'function') throw modelsError('invalid-response');
            const stored = calls.get(tool.index) ?? { id: '', name: '', arguments: '' };
            if (tool.id !== undefined) stored.id += string(tool.id);
            const fn = tool.function === undefined ? {} : object(tool.function);
            if (fn.name !== undefined) stored.name += string(fn.name);
            if (fn.arguments !== undefined) stored.arguments += string(fn.arguments);
            calls.set(tool.index, stored);
            input.onEvent({ type: 'tool-call-delta', index: tool.index,
              ...(tool.id === undefined ? {} : { id: string(tool.id) }),
              ...(fn.name === undefined ? {} : { name: string(fn.name) }),
              ...(fn.arguments === undefined ? {} : { argumentsDelta: string(fn.arguments) }),
            });
          }
          if (choice.finish_reason !== null && choice.finish_reason !== undefined) finish = choice.finish_reason;
        });
        if (!completed) throw modelsError('invalid-response');
        const native: NativeObject = { content: text, refusal: refusal || null,
          tool_calls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => ({ type: 'function', id: call.id, function: { name: call.name, arguments: call.arguments } })),
        };
        return { result: result(native, finish, rawUsage) } satisfies ProtocolOutcome;
      });
    },
  };
}
export function createChatCompletionsProtocolComponent(options: ProtocolOptions = {}) {
  return protocolComponent(createChatCompletionsProtocol(options));
}

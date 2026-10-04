import { geminiImages, imageContent, withImages } from './images.js';
import { isModelsError, modelsError } from '../errors.js';
import { withNativeDiagnostic } from '../diagnostics.js';
import { assert } from '../domain.js';
import type { DiscoveredModel, JsonValue } from '../types.js';
import type { NativeObject, NativeProtocol } from '../native-types.js';
import { array, captureOptions, connectionFields, conversation, effectiveCapabilities, effortOption, index, native, nonempty, numberOption, object, optionKeys, parseJson, protocolComponent, requireLocalTools, restoreRecords, string, textBlocks, validateProvider, type ProtocolOptions } from './shared.js';
import { pagedDiscover, request } from './transport.js';
const protocolId = 'gemini-interactions', levels = ['minimal', 'low', 'medium', 'high'] as const;
const authentication = { authHeader: 'google-api-key' } as const;
const lifecycleEvents = ['interaction.created', 'interaction.status_update', 'interaction.in_progress', 'interaction.requires_action'];
const streamEvents = [...lifecycleEvents, 'interaction.completed', 'step.start', 'step.delta', 'step.stop', 'error'];
function failureDiagnostic(stage: string, event?: NativeObject): NativeObject {
  const known = (value: JsonValue | undefined, allowed: readonly string[]) => typeof value === 'string' && allowed.includes(value) ? value : 'unknown';
  const detail = (value: JsonValue | undefined): NativeObject | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as NativeObject : undefined;
  const step = detail(event?.step), delta = detail(event?.delta);
  return { type: 'gemini_response_diagnostic', stage,
    ...(event ? { event_type: known(event.event_type, streamEvents),
      ...(Number.isSafeInteger(event.index) && Number(event.index) >= 0 ? { index: Number(event.index) } : {}),
      ...(step ? { step_type: known(step.type, ['model_output', 'thought', 'function_call']) } : {}),
      ...(delta ? { delta_type: known(delta.type, ['text', 'text_annotation_delta', 'arguments_delta', 'thought_signature', 'thought_summary']) } : {}) } : {}) };
}
function validateIntent(intent: NativeObject, images = true): void {
  if (intent.system_instruction !== undefined) string(intent.system_instruction);
  for (const value of array(intent.input)) { const item = object(value); if (item.type === 'user_input') imageContent(item.content, geminiImages, images); else if (item.type === 'function_result') { nonempty(item.call_id); nonempty(item.name); textBlocks(item.result); } else throw modelsError('capability-unsupported'); }
}
function validateResponse(raw: unknown): NativeObject {
  const response = native(raw);
  if (response.errors !== undefined && array(response.errors).length || response.status === 'failed' || response.status === 'cancelled') throw modelsError('provider-failure');
  if (!['completed', 'requires_action', 'incomplete', 'budget_exceeded'].includes(string(response.status))) throw modelsError('invalid-response');
  const complete = response.status === 'completed' || response.status === 'requires_action', ids = new Set<string>(); let calls = 0;
  for (const value of array(response.steps)) {
    const step = object(value); if (step.error != null) throw modelsError('provider-failure');
    if (step.type === 'model_output') for (const item of step.content === undefined ? [] : array(step.content)) { const content = object(item); if (content.type === 'text') string(content.text); }
    else if (step.type === 'thought') { if (step.signature !== undefined) string(step.signature); if (step.summary !== undefined) array(step.summary); }
    else if (step.type === 'function_call') { const id = nonempty(step.id); if (ids.has(id)) throw modelsError('invalid-response'); ids.add(id); nonempty(step.name); if (complete) object(step.arguments); calls++; }
    else nonempty(step.type);
  }
  if (response.status === 'requires_action' && !calls) throw modelsError('invalid-response');
  return response;
}
function commit(state: NativeObject, intent: NativeObject, response: NativeObject): NativeObject {
  validateIntent(intent);
  const value = validateResponse(response), next = conversation(state, intent, 'input', ['system_instruction', 'tools']);
  return native({ ...next, input: [...array(next.input), ...array(value.steps)] });
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
export function createGeminiInteractionsProtocol(options: ProtocolOptions = {}): NativeProtocol {
  options = captureOptions(options);
  return {
    descriptor: { id: protocolId, version: '2.1.0', name: 'Gemini Interactions', connectionFields,
      modelFields: [{ key: 'generation_config.max_output_tokens', label: 'Maximum output tokens', type: 'number', min: 1, max: 2_147_483_647, integer: true },
        { key: 'generation_config.thinking_level', label: 'Thinking level', type: 'enum', values: levels }, { key: 'generation_config.thinking_summaries', label: 'Thinking summaries', type: 'enum', values: ['auto', 'none'] }], supportsDiscovery: true, supportsCheck: true },
    validateProvider: provider => validateProvider(provider, protocolId),
    validateParameters(options, declared) {
      optionKeys(options, ['generation_config']); const generation = options.generation_config === undefined ? {} : object(options.generation_config); optionKeys(generation, ['max_output_tokens', 'thinking_level', 'thinking_summaries']);
      numberOption(generation.max_output_tokens, 1, 2_147_483_647, true); effortOption(generation.thinking_level, declared, levels);
      if (generation.thinking_summaries !== undefined) { assert(['auto', 'none'].includes(string(generation.thinking_summaries))); if (declared.reasoning.support !== 'supported') throw modelsError('capability-unsupported'); }
    },
    effectiveCapabilities: declared => ({ ...effectiveCapabilities(declared), imageInput: declared.imageInput.support === 'supported' }),
    recordFormatVersion: 2,
    canRestoreVersion: version => version === '2.0.0' || version === '2.1.0',
    resourceIds: geminiImages.ids,
    restore: records => {
      for (const record of records) if (record.kind === 'request') validateIntent(native(record.payload), record.recordFormatVersion === 2);
      return restoreRecords(protocolId, records, commit, [1, 2]);
    },
    prepare(input) {
      validateIntent(input.intent);
      if (geminiImages.ids(input.intent).length && !input.capabilities.imageInput) throw modelsError('capability-unsupported');
      requireLocalTools(input.intent.tools, input.capabilities.tools);
      const next = conversation(input.state, input.intent, 'input', ['system_instruction', 'tools']);
      for (const value of next.tools === undefined ? [] : array(next.tools)) { const tool = object(value); if (tool.type !== 'function') throw modelsError('invalid-config'); object(tool.parameters); }
      return native({ ...input.parameters, ...next, model: input.remoteModelId, store: false, stream: input.capabilities.streaming });
    },
    exchange(input) {
      return withImages(geminiImages, input, (wire, signal) => request(options, { ...input, signal }, 'interactions', wire, async reader => {
        let stage = input.request.stream ? 'sse-stream' : 'json-response', lastEvent: NativeObject | undefined;
        try {
          if (!input.request.stream) return validateResponse(await reader.json());
          const steps = new Map<number, { step: Record<string, JsonValue>; stopped: boolean; arguments?: string }>(); let terminal: NativeObject | undefined;
          await reader.sse(data => {
            stage = 'sse-event'; lastEvent = undefined;
            if (data === '[DONE]') { if (!terminal) throw modelsError('invalid-response'); return; }
            if (terminal) throw modelsError('invalid-response');
            const event = native(parseJson(data)), type = string(event.event_type);
            lastEvent = event;
            if (type === 'error') throw modelsError('provider-failure');
            if (lifecycleEvents.includes(type)) { input.onEvent(event); stage = 'sse-stream'; return; }
            if (type === 'interaction.completed') {
              stage = 'sse-terminal';
              // store:false streams can omit the server interaction ID. Local
              // history uses the ordered steps; function call IDs stay required.
              const response = object(event.interaction);
              const complete = response.status === 'completed' || response.status === 'requires_action', ordered = [...steps.entries()].sort(([a], [b]) => a - b);
              if (ordered.some(([position, step], order) => position !== order || complete && !step.stopped)) throw modelsError('invalid-response');
              const output = response.steps === undefined ? ordered.map(([, value]) => ({ ...value.step, ...(value.arguments === undefined ? {} : { arguments: complete ? object(parseJson(value.arguments)) : value.arguments }) })) : array(response.steps);
              terminal = validateResponse({ ...response, steps: output }); input.onEvent(event); return true;
            }
            const position = index(event.index);
            if (type === 'step.start') { if (steps.has(position)) throw modelsError('invalid-response'); steps.set(position, { step: structuredClone(object(event.step)), stopped: false }); input.onEvent(event); return; }
            const value = steps.get(position); if (!value || value.stopped) throw modelsError('invalid-response');
            if (type === 'step.stop') { value.stopped = true; if (event.step !== undefined) value.step = { ...value.step, ...object(event.step) }; input.onEvent(event); return; }
            if (type !== 'step.delta') throw modelsError('invalid-response');
            const delta = object(event.delta), step = value.step;
            if (delta.type === 'text' && step.type === 'model_output') {
              const content = (step.content === undefined ? [] : array(step.content)).map(item => ({ ...object(item) })); const last = content.at(-1);
              if (last) last.text = string(last.text) + string(delta.text); else content.push({ type: 'text', text: string(delta.text) }); step.content = content;
            } else if (delta.type === 'text_annotation_delta' && step.type === 'model_output') {
              if (delta.annotations !== undefined) { const content = array(step.content).map(item => ({ ...object(item) })), last = content.at(-1); if (!last) throw modelsError('invalid-response'); last.annotations = [...(last.annotations === undefined ? [] : array(last.annotations)), ...array(delta.annotations)]; step.content = content; }
            } else if (delta.type === 'arguments_delta' && step.type === 'function_call') {
              if (delta.arguments !== undefined) { if (Object.keys(object(step.arguments)).length) throw modelsError('invalid-response'); value.arguments = (value.arguments ?? '') + string(delta.arguments); }
            } else if (delta.type === 'thought_signature' && step.type === 'thought') { if (delta.signature !== undefined) step.signature = string(delta.signature); }
            else if (delta.type === 'thought_summary' && step.type === 'thought') { if (delta.content !== undefined) step.summary = [...(step.summary === undefined ? [] : array(step.summary)), object(delta.content)]; }
            else throw modelsError('invalid-response');
            input.onEvent(event); stage = 'sse-stream';
          });
          if (!terminal) { stage = 'sse-terminal-missing'; throw modelsError('invalid-response'); } return terminal;
        } catch (error) {
          if (isModelsError(error) && (error.code === 'invalid-response' || error.code === 'provider-failure')) throw withNativeDiagnostic(error, failureDiagnostic(stage, lastEvent));
          throw error;
        }
      }, authentication));
    },
    commit: input => commit(input.state, input.intent, input.response),
    discover: input => pagedDiscover(options, input, 'models?pageSize=1000', discoverPage, authentication),
    check: input => request(options, input, 'models?pageSize=1000', undefined, async reader => { discoverPage(await reader.json()); }, authentication),
  };
}
export function createGeminiInteractionsProtocolComponent(options: ProtocolOptions = {}) { return protocolComponent(createGeminiInteractionsProtocol(options)); }

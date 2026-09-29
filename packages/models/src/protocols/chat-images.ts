import { assert } from '../domain.js';
import { modelsError, normalizeError } from '../errors.js';
import { abortLink, deferred, joinOperation, throwAborted } from '../lifecycle.js';
import { nativeWireLimit, parseNativeImageResourceUri, resourceDataUrl } from '../resources.js';
import type { NativeImageResourceRef, NativeObject, NativeResourceResolver } from '../native-types.js';
import type { ProtocolOperation } from '../types.js';
import { array, object, string } from './shared.js';

/** Only user image_url blocks participate in resource resolution. */
export function chatImageIds(request: NativeObject): readonly string[] {
  const ids = new Set<string>();
  for (const value of array(request.messages)) {
    const message = object(value);
    if (message.role !== 'user' || typeof message.content === 'string') continue;
    for (const value of array(message.content)) {
      const block = object(value); if (block.type !== 'image_url') continue;
      const id = parseNativeImageResourceUri(string(object(block.image_url).url));
      if (!id) throw modelsError('capability-unsupported'); ids.add(id);
    }
  }
  return [...ids];
}

export function withChatImages<T>(input: { readonly request: NativeObject; readonly signal: AbortSignal; readonly resources?: NativeResourceResolver; readonly resourceRefs?: readonly NativeImageResourceRef[] },
  start: (request: NativeObject, signal: AbortSignal) => ProtocolOperation<T>): ProtocolOperation<T> {
  const controller = new AbortController(), unlink = abortLink(input.signal, controller), output = deferred<T>();
  const done = (async () => {
    try {
      throwAborted(controller.signal);
      const refs = new Map((input.resourceRefs ?? []).map(ref => [ref.id, ref]));
      let estimated = Buffer.byteLength(JSON.stringify(input.request));
      const messages = array(input.request.messages);
      for (const value of messages) {
        const message = object(value); if (message.role !== 'user' || typeof message.content === 'string') continue;
        for (const value of array(message.content)) {
          const block = object(value); if (block.type !== 'image_url') continue;
          const url = string(object(block.image_url).url), id = parseNativeImageResourceUri(url), ref = id ? refs.get(id) : undefined;
          assert(ref); estimated += `data:${ref.mimeType};base64,`.length + 4 * Math.ceil(ref.byteLength / 3) - Buffer.byteLength(url);
        }
      }
      if (estimated > nativeWireLimit) throw modelsError('request-too-large');
      const urls = new Map<string, string>();
      for (const id of chatImageIds(input.request)) {
        const ref = refs.get(id); assert(ref);
        urls.set(id, await resourceDataUrl(ref, input.resources, controller.signal));
      }
      throwAborted(controller.signal);
      const wire: NativeObject = { ...input.request, messages: messages.map(value => {
        const message = object(value); if (message.role !== 'user' || typeof message.content === 'string') return message;
        return { ...message, content: array(message.content).map(value => {
          const block = object(value); if (block.type !== 'image_url') return block;
          const image = object(block.image_url), id = parseNativeImageResourceUri(string(image.url)); assert(id && urls.has(id));
          return { ...block, image_url: { ...image, url: urls.get(id)! } };
        }) };
      }) };
      if (Buffer.byteLength(JSON.stringify(wire)) > nativeWireLimit) throw modelsError('request-too-large');
      const result = await joinOperation(start(wire, controller.signal), controller.signal);
      urls.clear(); output.resolve(result);
    } catch (error) {
      const failure = normalizeError(error); output.reject(failure);
      if (failure.code === 'cleanup-failure') throw failure;
    } finally { unlink(); }
  })();
  void done.catch(() => {});
  return { result: output.promise, done, cancel: () => controller.abort() };
}

import { assert, immutable } from '../domain.js';
import { nativeDiagnostic, withNativeDiagnostic } from '../diagnostics.js';
import { modelsError, normalizeError } from '../errors.js';
import { abortLink, deferred, joinOperation, throwAborted } from '../lifecycle.js';
import { nativeWireLimit, parseNativeImageResourceUri, resourceDataUrl } from '../resources.js';
import type { NativeImageResourceRef, NativeObject, NativeResourceResolver } from '../native-types.js';
import type { ProtocolOperation } from '../types.js';
import { array, object, optionKeys, string } from './shared.js';

interface ImageData { readonly mimeType: string; readonly data: string; readonly url: string }
interface ImageCodec {
  id(block: NativeObject): string | undefined;
  ids(request: NativeObject): readonly string[];
  map(request: NativeObject, resolve: (id: string) => ImageData): NativeObject;
}
function resourceId(value: unknown): string {
  const id = parseNativeImageResourceUri(string(value));
  if (!id) throw modelsError('capability-unsupported');
  return id;
}
/** Only explicitly selected user content blocks participate; never recursively rewrite native state. */
function codec(field: 'messages' | 'input', user: (item: NativeObject) => boolean, type: string,
  read: (block: NativeObject) => string, wire: (block: NativeObject, data: ImageData) => NativeObject): ImageCodec {
  const id = (block: NativeObject): string | undefined => block.type === type ? read(block) : undefined;
  const map = (request: NativeObject, replace: (block: NativeObject, id: string) => NativeObject): NativeObject => ({ ...request,
    [field]: array(request[field]).map(value => {
      const item = object(value);
      if (!user(item) || typeof item.content === 'string') return item;
      return { ...item, content: array(item.content).map(value => {
        const block = object(value), resource = id(block);
        return resource === undefined ? block : replace(block, resource);
      }) };
    }),
  });
  return { id, ids(request) { const ids = new Set<string>(); map(request, (block, id) => { ids.add(id); return block; }); return [...ids]; },
    map: (request, resolve) => map(request, (block, id) => wire(block, resolve(id))) };
}
export const chatImages = codec('messages', item => item.role === 'user', 'image_url', block => {
  optionKeys(block, ['type', 'image_url']); const image = object(block.image_url); optionKeys(image, ['url']); return resourceId(image.url);
}, (block, data) => ({ ...block, image_url: { url: data.url } }));
export const responsesImages = codec('input', item => item.role === 'user', 'input_image', block => {
  optionKeys(block, ['type', 'image_url']); return resourceId(block.image_url);
}, (block, data) => ({ ...block, image_url: data.url }));
export const anthropicImages = codec('messages', item => item.role === 'user', 'image', block => {
  optionKeys(block, ['type', 'source']); const source = object(block.source); optionKeys(source, ['type', 'url']);
  if (source.type !== 'url') throw modelsError('capability-unsupported'); return resourceId(source.url);
}, (block, data) => ({ ...block, source: { type: 'base64', media_type: data.mimeType, data: data.data } }));
export const geminiImages = codec('input', item => item.type === 'user_input', 'image', block => {
  optionKeys(block, ['type', 'uri']); return resourceId(block.uri);
}, (_block, data) => ({ type: 'image', mime_type: data.mimeType, data: data.data }));

export function imageContent(value: unknown, images: ImageCodec, allowed: boolean, textType: 'text' | 'input_text' = 'text'): void {
  if (typeof value === 'string') return;
  const blocks = array(value);
  for (const value of blocks) {
    const block = object(value);
    if (block.type === textType) string(block.text);
    else if (!allowed || images.id(block) === undefined) throw modelsError('capability-unsupported');
  }
}

/** Resource reads, materialization and HTTP share one cancellation/actual-exit barrier. */
export function withImages<T extends NativeObject>(images: ImageCodec,
  input: { readonly request: NativeObject; readonly signal: AbortSignal; readonly resources?: NativeResourceResolver; readonly resourceRefs?: readonly NativeImageResourceRef[] },
  start: (request: NativeObject, signal: AbortSignal) => ProtocolOperation<T>): ProtocolOperation<T> {
  const controller = new AbortController(), unlink = abortLink(input.signal, controller), output = deferred<T>();
  const done = (async () => {
    const data = new Map<string, ImageData>();
    let candidate: NativeObject | undefined, diagnostic: NativeObject | undefined;
    try {
      throwAborted(controller.signal);
      const refs = new Map((input.resourceRefs ?? []).map(ref => [ref.id, ref]));
      let encodedLength = 0;
      const skeleton = images.map(input.request, id => {
        const ref = refs.get(id); assert(ref);
        encodedLength += 4 * Math.ceil(ref.byteLength / 3);
        return { mimeType: ref.mimeType, data: '', url: `data:${ref.mimeType};base64,` };
      });
      if (Buffer.byteLength(JSON.stringify(skeleton)) + encodedLength > nativeWireLimit) throw modelsError('request-too-large');
      for (const id of images.ids(input.request)) {
        const ref = refs.get(id); assert(ref);
        const url = await resourceDataUrl(ref, input.resources, controller.signal);
        data.set(id, { mimeType: ref.mimeType, url, data: url.slice(url.indexOf(',') + 1) });
      }
      throwAborted(controller.signal);
      const wire = images.map(input.request, id => { const value = data.get(id); assert(value); return value; });
      if (Buffer.byteLength(JSON.stringify(wire)) > nativeWireLimit) throw modelsError('request-too-large');
      const operation = start(wire, controller.signal);
      // Preserve terminal native diagnostics when cancellation or cleanup prevents a successful result.
      void operation.result.then(value => { candidate = immutable(value); }, error => { diagnostic = nativeDiagnostic(error); }).catch(() => {});
      output.resolve(await joinOperation(operation, controller.signal));
    } catch (error) {
      const failure = withNativeDiagnostic(normalizeError(error), diagnostic ?? nativeDiagnostic(error) ?? candidate); output.reject(failure);
      if (failure.code === 'cleanup-failure') throw failure;
    } finally { data.clear(); unlink(); }
  })();
  void done.catch(() => {});
  return { result: output.promise, done, cancel: () => controller.abort() };
}

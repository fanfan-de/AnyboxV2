import { modelsError, normalizeError } from '../errors.js';
import { abortLink, deferred, joinOperation, throwAborted } from '../lifecycle.js';
import type { DiscoveredModel, ProtocolConnection, ProtocolOperation } from '../types.js';
import { array, object, parseJson, string, type ProtocolOptions } from './shared.js';

interface Reader {
  json(): Promise<unknown>;
  sse(onData: (data: string) => boolean | void): Promise<void>;
}
/** Trusted adapter settings; neither headers nor authentication enter public configuration. */
export interface RequestOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly authHeader?: 'bearer' | 'google-api-key' | 'anthropic-api-key';
}
/** Own the fetch, reader, abort listener and asynchronous stream cancellation. */
export function request<T>(options: ProtocolOptions, connection: ProtocolConnection, path: string, body: unknown | undefined, parse: (reader: Reader) => Promise<T>, requestOptions: RequestOptions = {}): ProtocolOperation<T> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let reachedEnd = false;
  let cancellation: Promise<void> | undefined;
  let cleanupFailed = false;
  const cancelReader = (): Promise<void> => {
    if (cancellation) return cancellation;
    if (!reader || reachedEnd) return Promise.resolve();
    // Start cancellation before aborting fetch: abort first can error the reader,
    // whose cancel() then rejects with its already-observed AbortError.
    try { cancellation = reader.cancel().catch(() => { cleanupFailed = true; }); }
    catch { cleanupFailed = true; cancellation = Promise.resolve(); }
    return cancellation;
  };
  const cancel = () => {
    void cancelReader();
    controller.abort();
  };
  const onAbort = () => cancel();
  connection.signal.addEventListener('abort', onAbort, { once: true });
  if (connection.signal.aborted) cancel();
  let resolveResult!: (result: T) => void;
  let rejectResult!: (error: unknown) => void;
  const result = new Promise<T>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  const done = (async () => {
    try {
      if (controller.signal.aborted) throw modelsError('cancelled');
      if (connection.provider.auth === 'api-key' && !connection.credential) throw modelsError('credential-missing');
      const response = await (options.fetch ?? globalThis.fetch)(`${connection.provider.baseUrl.replace(/\/+$/u, '')}/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...requestOptions.headers,
          ...(connection.provider.auth !== 'api-key' ? {} : requestOptions.authHeader === 'google-api-key'
            ? { 'x-goog-api-key': connection.credential! } : requestOptions.authHeader === 'anthropic-api-key'
              ? { 'x-api-key': connection.credential! } : { Authorization: 'Bearer ' + connection.credential }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      reader = response.body?.getReader();
      if (controller.signal.aborted) throw modelsError('cancelled');
      if (!response.ok) throw modelsError('provider-failure');
      if (!reader) throw modelsError('invalid-response');
      const consume = async (onText: (text: string, final: boolean) => boolean | void) => {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let bytes = 0;
        while (true) {
          let part: ReadableStreamReadResult<Uint8Array>;
          try { part = await reader!.read(); } catch (error) {
            // A rejected read means the stream is already errored. Cancelling it
            // only repeats that stored error; releasing its lock is sufficient.
            reachedEnd = true;
            throw error;
          }
          if (controller.signal.aborted) throw modelsError('cancelled');
          if (part.done) {
            reachedEnd = true;
            let tail: string;
            try { tail = decoder.decode(); } catch { throw modelsError('invalid-response'); }
            onText(tail, true);
            return;
          }
          bytes += part.value.byteLength;
          if (bytes > 32 * 1024 * 1024) throw modelsError('invalid-response');
          let text: string;
          try { text = decoder.decode(part.value, { stream: true }); } catch { throw modelsError('invalid-response'); }
          if (onText(text, false)) return;
        }
      };
      const outcome = await parse({
        async json() {
          let text = '';
          await consume(chunk => { text += chunk; });
          return parseJson(text);
        },
        async sse(onData) {
          let buffer = '';
          let data: string[] = [];
          const line = (value: string) => {
            if (!value) {
              const stop = data.length > 0 && onData(data.join('\n'));
              data = [];
              return stop;
            } else if (value.startsWith('data:')) {
              data.push(value.slice(value[5] === ' ' ? 6 : 5));
            }
          };
          await consume((chunk, final) => {
            buffer += chunk;
            if (buffer.length > 8 * 1024 * 1024) throw modelsError('invalid-response');
            while (true) {
              const match = /[\r\n]/u.exec(buffer);
              if (!match) break;
              const at = match.index;
              if (buffer[at] === '\r' && at === buffer.length - 1 && !final) break;
              const delimiterLength = buffer[at] === '\r' && buffer[at + 1] === '\n' ? 2 : 1;
              if (line(buffer.slice(0, at))) return true;
              buffer = buffer.slice(at + delimiterLength);
            }
            // An unterminated SSE event is not a completed provider response.
            if (final && (buffer.length || data.length)) throw modelsError('invalid-response');
          });
        },
      });
      if (controller.signal.aborted) throw modelsError('cancelled');
      resolveResult(outcome);
    } catch (error) {
      rejectResult(controller.signal.aborted ? modelsError('cancelled') : normalizeError(error));
    } finally {
      await cancelReader();
      try { reader?.releaseLock(); } catch { cleanupFailed = true; }
      reader = undefined;
      connection.signal.removeEventListener('abort', onAbort);
      if (cleanupFailed) throw modelsError('cleanup-failure');
    }
  })();
  void result.catch(() => {});
  void done.catch(() => {});
  return { result, done, cancel };
}
export function discover(options: ProtocolOptions, connection: ProtocolConnection): ProtocolOperation<readonly DiscoveredModel[]> {
  return request(options, connection, 'models', undefined, async reader => {
    const data = array(object(await reader.json()).data);
    const ids = new Set<string>();
    return data.map(value => {
      const id = string(object(value).id);
      if (!id || ids.has(id)) throw modelsError('invalid-response');
      ids.add(id);
      return { remoteModelId: id, name: id };
    });
  });
}
export function check(options: ProtocolOptions, connection: ProtocolConnection): ProtocolOperation<void> {
  return request(options, connection, 'models', undefined, async reader => { array(object(await reader.json()).data); });
}

export interface DiscoveredPage {
  readonly models: readonly DiscoveredModel[];
  readonly nextPath?: string;
}

/** One operation owns every page, including cancellation and each reader's actual exit. */
export function pagedDiscover(options: ProtocolOptions, connection: ProtocolConnection, firstPath: string,
  parsePage: (value: unknown) => DiscoveredPage, requestOptions: RequestOptions = {}): ProtocolOperation<readonly DiscoveredModel[]> {
  const controller = new AbortController();
  const unlink = abortLink(connection.signal, controller);
  const output = deferred<readonly DiscoveredModel[]>();
  const done = (async () => {
    try {
      const models: DiscoveredModel[] = [], ids = new Set<string>(), paths = new Set<string>();
      let path: string | undefined = firstPath;
      while (path !== undefined) {
        throwAborted(controller.signal);
        if (!path || paths.has(path)) throw modelsError('invalid-response');
        paths.add(path);
        const raw = await joinOperation(request(options, { ...connection, signal: controller.signal }, path,
          undefined, reader => reader.json(), requestOptions), controller.signal);
        const page = parsePage(raw);
        for (const model of page.models) {
          if (!model.remoteModelId || ids.has(model.remoteModelId)) throw modelsError('invalid-response');
          ids.add(model.remoteModelId); models.push(model);
        }
        path = page.nextPath;
      }
      throwAborted(controller.signal);
      output.resolve(models);
    } catch (cause) {
      const error = normalizeError(cause);
      output.reject(error);
      if (error.code === 'cleanup-failure') throw error;
    } finally { unlink(); }
  })();
  void done.catch(() => {});
  return { result: output.promise, done, cancel: () => controller.abort() };
}

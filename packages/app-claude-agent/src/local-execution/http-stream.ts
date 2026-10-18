import { IncomingMessage } from 'node:http'
import type { ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { Writable } from 'node:stream'
import { failure } from '@anybox/application-api/node'
import { localExecutionLimits } from './protocol.js'

interface Deferred<T> { readonly promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no }), resolve: value => resolve(value), reject: error => reject(error) }
}

/** A Node HTTP adapter with an in-memory writable. No socket listens and no HTTP authentication is bypassed. */
export function createLocalHttpStream(method: string, body: unknown) {
  const request = new IncomingMessage(new Socket())
  request.method = method
  if (body !== undefined) {
    let text: string
    try { text = JSON.stringify(body) } catch { throw failure(400, 'invalid-input') }
    if (typeof text !== 'string') throw failure(400, 'invalid-input')
    const bytes = Buffer.from(text)
    if (bytes.length > localExecutionLimits.bodyBytes) throw failure(413, 'request-too-large')
    request.headers = { 'content-type': 'application/json', 'content-length': String(bytes.length) }
    request.push(bytes)
  }
  request.push(null); request.complete = true
  const controller = new AbortController(), head = deferred<{ status: number; headers: Record<string, string> }>()
  // Rejection is observed even when dispatch fails before the request awaits its headers.
  void head.promise.catch(() => {})
  const headers = new Map<string, string>()
  let headersSent = false, ended = false, destroyed = false, reading = false
  let pending: { bytes: Buffer; offset: number; callback(error?: Error | null): void } | undefined
  let changed = deferred<void>()
  const notify = () => { const previous = changed; changed = deferred<void>(); previous.resolve() }
  const sendHead = () => {
    if (headersSent) return
    headersSent = true
    head.resolve({ status: response.statusCode, headers: Object.fromEntries([...headers].filter(([key]) => ['content-type', 'content-length', 'cache-control'].includes(key))) })
  }
  const writable = new Writable({ highWaterMark: localExecutionLimits.frameBytes, autoDestroy: false,
    write(chunk: Buffer, _encoding, callback) {
      sendHead()
      if (chunk.length > localExecutionLimits.bufferedBytes) { callback(failure(503, 'response-too-large')); return }
      pending = { bytes: chunk, offset: 0, callback }; notify()
    },
    final(callback) { sendHead(); ended = true; notify(); callback() },
    destroy(error, callback) {
      destroyed = true; ended = true; controller.abort()
      const write = pending; pending = undefined
      write?.callback(error ?? failure(503, 'cancelled'))
      if (!headersSent) head.reject(error ?? failure(503, 'cancelled'))
      notify(); request.destroy(); callback(error)
    },
  })
  // All casts stay at this adapter: the existing handler sees its normal Node request/response contract.
  const response = writable as unknown as ServerResponse
  response.statusCode = 200
  response.setHeader = ((name: string, value: string | number | readonly string[]) => {
    if (headersSent) throw new Error('headers already sent')
    headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value)); return response
  }) as ServerResponse['setHeader']
  response.getHeader = name => headers.get(name.toLowerCase())
  response.writeHead = ((status: number, values?: Record<string, string>) => {
    response.statusCode = status
    if (values) for (const [name, value] of Object.entries(values)) response.setHeader(name, value)
    sendHead(); return response
  }) as ServerResponse['writeHead']
  response.flushHeaders = sendHead
  Object.defineProperty(response, 'headersSent', { get: () => headersSent })
  writable.on('error', () => {})
  return {
    request, response, signal: controller.signal, head: head.promise,
    async read(): Promise<{ chunk: string; done: boolean }> {
      if (reading) throw failure(409, 'stream-read-busy')
      reading = true
      try {
        for (;;) {
          if (pending) {
            const write = pending, end = Math.min(write.bytes.length, write.offset + localExecutionLimits.frameBytes)
            const chunk = write.bytes.subarray(write.offset, end).toString('base64')
            write.offset = end
            if (end === write.bytes.length) { pending = undefined; write.callback() }
            return { chunk, done: ended && !pending && writable.writableLength === 0 }
          }
          if (ended || destroyed) return { chunk: '', done: true }
          await changed.promise
        }
      } finally { reading = false }
    },
    close() { controller.abort(); writable.destroy(); request.destroy() },
  }
}

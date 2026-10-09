import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import * as fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { basename, extname, parse, relative, resolve, sep } from 'node:path'
import type { Component } from '@nya/core'
import type { JsonValue } from '@anybox/models'
import { rgPath } from '@vscode/ripgrep'
import picomatch from 'picomatch'
import type { OwnedCall } from '../contracts.js'
import { projectServiceKey } from '../project/component.js'
import type { ProjectPort } from '../project/component.js'
import { imageAssetsServiceKey, isImageAssetError } from '../image/port.js'
import type { ImageAssetsPort, ImageRef } from '../image/port.js'
import { excludedPath } from '../project-files/domain.js'
import { applyPatchServiceKey } from './apply-patch-component.js'
import type { ApplyPatchPort } from './apply-patch-component.js'
import { validatePatchText } from './apply-patch-domain.js'
import { patchDiagnostic } from './apply-patch-types.js'

export const fileToolsServiceKey = 'tools.files'

export interface FileToolResult {
  readonly result: JsonValue
  readonly images?: readonly ImageRef[]
}
export interface FileToolsPort {
  execute(input: {
    readonly runId: string; readonly sessionId: string; readonly projectId: string
    readonly name: string; readonly args: Readonly<Record<string, JsonValue>>
    readonly signal?: AbortSignal; readonly imageInput: boolean
  }): OwnedCall<FileToolResult>
}
export interface FileToolsOptions {
  readonly maxSourceBytes?: number
  readonly maxResultBytes?: number
  readonly searchTimeoutMs?: number
}

const supportedNames = new Set(['claude_code_Read', 'claude_code_Write', 'claude_code_Edit',
  'claude_code_Glob', 'claude_code_Grep', 'deepseek_harness_read', 'deepseek_harness_read_image',
  'deepseek_harness_write', 'deepseek_harness_edit', 'deepseek_harness_glob', 'deepseek_harness_grep', 'codex_view_image'])
const exclusionGlobs = ['**/.git/**', '**/.hg/**', '**/.svn/**', '**/node_modules/**', '**/.pnpm-store/**',
  '**/.venv/**', '**/venv/**', '**/.yarn/cache/**', '**/.yarn/unplugged/**']

/** Electron resolution names the archive even for an unpacked executable; spawn needs its physical path. */
export function searchBinaryPath(path: string = rgPath): string {
  return path.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
}

function toolError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { name: 'FileToolError', code })
}
function positive(value: number | undefined, fallback: number, name: string): number {
  const chosen = value ?? fallback
  if (!Number.isSafeInteger(chosen) || chosen < 1 || chosen > 2_147_483_647) throw new TypeError(`${name} must be a positive integer`)
  return chosen
}
function stringArg(args: Readonly<Record<string, JsonValue>>, name: string): string {
  if (typeof args[name] !== 'string' || !args[name] || args[name].includes('\0')) throw toolError('invalid-input', `${name} must be a non-empty string without NUL.`)
  return args[name]
}
function numberArg(args: Readonly<Record<string, JsonValue>>, name: string, fallback: number, minimum = 0): number {
  const value = args[name] ?? fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > 2_147_483_647) throw toolError('invalid-input', `${name} must be an integer from ${minimum} to 2147483647.`)
  return value
}
function text(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value)
  if (bytes.length <= maxBytes) return { text: value, truncated: false }
  let end = maxBytes
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true }
}
function imageSignature(bytes: Buffer): boolean {
  return (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
}
function sameStat(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

async function rejectLinkAncestors(path: string): Promise<void> {
  const root = parse(path).root
  let current = root
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = resolve(current, part)
    if ((await fs.lstat(current)).isSymbolicLink()) throw toolError('symbolic-link', 'Symbolic-link path components are unsupported.')
  }
}

/** Final-component symlinks and multiply linked files are never read or imported. */
async function readBytes(path: string, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted()
  await rejectLinkAncestors(path)
  const before = await fs.lstat(path, { bigint: true })
  if (before.isSymbolicLink()) throw toolError('symbolic-link', 'Symbolic-link targets are unsupported.')
  if (!before.isFile()) throw toolError('unsupported-file', 'Only ordinary files are supported.')
  if (before.nlink !== 1n) throw toolError('hard-link', 'Files with multiple hard links are unsupported.')
  if (before.size > BigInt(maxBytes)) throw toolError('file-too-large', `The file exceeds ${maxBytes} bytes.`)
  const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    if (!sameStat(before, await handle.stat({ bigint: true }))) throw toolError('file-changed', 'The file changed before it was opened.')
    const chunks: Buffer[] = []; let length = 0
    while (true) {
      signal.throwIfAborted()
      const buffer = Buffer.alloc(Math.min(65536, maxBytes + 1 - length))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      chunks.push(buffer.subarray(0, bytesRead)); length += bytesRead
      if (length > maxBytes) throw toolError('file-too-large', `The file exceeds ${maxBytes} bytes.`)
    }
    signal.throwIfAborted()
    const after = await handle.stat({ bigint: true }), current = await fs.lstat(path, { bigint: true })
    if (!current.isFile() || !sameStat(before, after) || !sameStat(before, current) || BigInt(length) !== before.size) {
      throw toolError('file-changed', 'The file changed while being read.')
    }
    return Buffer.concat(chunks, length)
  } finally {
    try { await handle.close() } catch { throw toolError('cleanup-failed', 'The file handle could not be closed.') }
  }
}

/** Search roots use ordinary filesystem access; traversal itself never follows links. */
async function searchTarget(projectPath: string, path: JsonValue | undefined): Promise<string> {
  if (path !== undefined && (typeof path !== 'string' || path.includes('\0'))) throw toolError('invalid-input', 'path must be a string without NUL.')
  const target = resolve(projectPath, typeof path === 'string' ? path : '.')
  await rejectLinkAncestors(target)
  const info = await fs.lstat(target)
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw toolError('unsupported-file', 'Search requires a regular file or directory, without a symbolic-link target.')
  if (excludedPath(target.split(sep).join('/'))) throw toolError('excluded-path', 'Version-control metadata and dependency directories are excluded from searches.')
  return target
}

/** The child is joined on every path, including timeout, output overflow and cancellation. */
async function runRg(arguments_: readonly string[], cwd: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
  signal.throwIfAborted()
  const child = spawn(searchBinaryPath(), [...arguments_], { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
  const chunks: Buffer[] = []; let kept = 0; let failure: Error | undefined; let killTimer: NodeJS.Timeout | undefined
  const kill = (kind: NodeJS.Signals) => {
    if (child.pid === undefined) return
    try { if (process.platform === 'win32') child.kill(kind); else process.kill(-child.pid, kind) }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) failure = toolError('cleanup-failed', 'The search process could not be stopped.') }
  }
  const stop = (error: Error) => {
    if (failure) return
    failure = error; kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 3000)
  }
  const abort = () => stop(toolError('cancelled', 'The file operation was cancelled.'))
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const timer = setTimeout(() => stop(toolError('search-timeout', 'The search timed out.')), timeoutMs)
  const exit = await new Promise<number | null>(yes => {
    child.stdout.on('data', (chunk: Buffer) => {
      kept += chunk.length
      if (kept > 20_000_000) stop(toolError('search-output-overflow', 'The search output exceeded 20 MB; narrow the search.'))
      else chunks.push(chunk)
    })
    child.stderr.on('data', () => {})
    child.once('error', () => { failure ??= toolError('search-unavailable', 'The bundled search process could not start.') })
    child.once('close', yes)
  })
  clearTimeout(timer); if (killTimer) clearTimeout(killTimer)
  signal.removeEventListener('abort', abort)
  if (failure) throw failure
  if (exit !== 0 && exit !== 1) throw toolError('invalid-pattern', 'The search pattern or target could not be processed.')
  return Buffer.concat(chunks).toString('utf8')
}

export function createFileToolsComponent(options: FileToolsOptions = {}): Component.Object<void, {
  [projectServiceKey]: ProjectPort; [applyPatchServiceKey]: ApplyPatchPort; [imageAssetsServiceKey]: ImageAssetsPort
}> {
  const maxSourceBytes = positive(options.maxSourceBytes, 10 * 1024 * 1024, 'maxSourceBytes')
  const maxResultBytes = positive(options.maxResultBytes, 65536, 'maxResultBytes')
  const searchTimeoutMs = positive(options.searchTimeoutMs, 30000, 'searchTimeoutMs')
  return {
    name: 'file-tools', inject: [projectServiceKey, applyPatchServiceKey, imageAssetsServiceKey],
    apply(ctx, _config, deps) {
      const active = new Set<OwnedCall<FileToolResult>>(), cleanupFailures = new Set<unknown>()
      let accepting = true
      ctx.effect(() => async () => {
        accepting = false
        const calls = [...active]
        for (const call of calls) call.cancel('owner-disposed')
        for (const exited of await Promise.allSettled(calls.map(call => call.done))) if (exited.status === 'rejected') cleanupFailures.add(exited.reason)
        if (cleanupFailures.size) throw new AggregateError([...cleanupFailures], 'file tools cleanup failed')
      }, 'cancel and join file operations')

      const service: FileToolsPort = {
        execute(input) {
          if (!accepting) throw toolError('unavailable', 'File tools are unavailable.')
          if (!input || !supportedNames.has(input.name) || !input.projectId || !input.sessionId || !input.runId || !input.args) {
            throw toolError('invalid-input', 'The file tool request is invalid.')
          }
          const controller = new AbortController()
          let nested: OwnedCall<unknown> | undefined
          let cleanupError: unknown
          const cancelNested = () => { try { nested?.cancel('file-tool-cancelled') } catch (error) { cleanupError ??= error } }
          const abort = () => { controller.abort(); cancelNested() }
          const ownedValue = async <T>(call: OwnedCall<T>): Promise<T> => {
            type Outcome = { kind: 'value'; value: T } | { kind: 'error'; error: unknown } | { kind: 'cleanup-failed' }
            nested = call
            if (controller.signal.aborted) cancelNested()
            const result: Promise<Outcome> = call.result.then(value => ({ kind: 'value' as const, value }), (error: unknown) => {
              cancelNested()
              return { kind: 'error' as const, error }
            })
            const exited = call.done.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }))
            // A failed actual exit must not wait forever for a broken business result.
            const early = exited.then<Outcome>(exit => exit.ok ? result : { kind: 'cleanup-failed' })
            const observed = await Promise.race([result, early])
            const exit = await exited
            if (!exit.ok) cleanupError ??= exit.error
            if (observed.kind === 'value') return observed.value
            if (observed.kind === 'error') throw observed.error
            throw toolError('cleanup-failed', 'The nested file operation failed to clean up.')
          }
          input.signal?.addEventListener('abort', abort, { once: true })
          if (input.signal?.aborted) abort()
          const operation = (async (): Promise<FileToolResult> => {
            const signal = controller.signal, args = input.args
            try {
              signal.throwIfAborted()
              const projectPath = (await deps[projectServiceKey].requireAvailable(input.projectId)).path
              signal.throwIfAborted()
              const claude = input.name.startsWith('claude_code_')
              const name = input.name.replace(/^(claude_code_|deepseek_harness_|codex_)/, '').toLowerCase()
              if (name === 'write' || name === 'edit') {
                const path = stringArg(args, 'file_path')
                const mutation = name === 'write' ? { kind: 'write' as const, content: typeof args.content === 'string' ? args.content : stringArg(args, 'content') }
                  : { kind: 'edit' as const, oldString: stringArg(args, 'old_string'),
                    newString: typeof args.new_string === 'string' ? args.new_string : stringArg(args, 'new_string'), replaceAll: args.replace_all === true }
                const observed = await ownedValue(deps[applyPatchServiceKey].mutateText({ projectId: input.projectId, path, mutation }))
                return { result: observed as unknown as JsonValue }
              }
              if (name === 'read' || name === 'read_image' || name === 'view_image') {
                const path = resolve(projectPath, stringArg(args, name === 'view_image' ? 'path' : 'file_path'))
                if (name === 'read' && (['.pdf', '.ipynb'].includes(extname(path).toLowerCase()) || args.pages !== undefined)) {
                  throw toolError('unsupported-format', 'PDF and notebook reads are unsupported by this tool implementation; read a text export instead.')
                }
                if (name !== 'read' && !input.imageInput) throw toolError('image-input-unavailable', 'The selected model does not declare image input.')
                const bytes = await readBytes(path, maxSourceBytes, signal)
                if (name !== 'read' || (claude && imageSignature(bytes))) {
                  if (!input.imageInput) throw toolError('image-input-unavailable', 'The selected model does not declare image input.')
                  const ref = await ownedValue(deps[imageAssetsServiceKey].importImage({ scopeId: input.sessionId, bytes: (async function* () { yield bytes })() }, signal))
                  return { result: { path, image: { assetId: ref.assetId, sha256: ref.sha256, mediaType: ref.mediaType,
                    byteLength: ref.byteLength, width: ref.width, height: ref.height } }, images: [ref] }
                }
                validatePatchText(bytes)
                const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
                const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? []
                const offset = numberArg(args, 'offset', 1, 1), limit = numberArg(args, 'limit', 2000, 1)
                const selected = lines.slice(offset - 1, offset - 1 + limit)
                const rendered = text(selected.map((line, index) => `${offset + index}: ${line.replace(/\r?\n$/, '')}`).join('\n'), maxResultBytes)
                const truncated = rendered.truncated || offset - 1 + selected.length < lines.length
                return { result: { path, text: rendered.text, offset, totalLines: lines.length, truncated,
                  nextOffset: truncated ? offset + (rendered.truncated ? Math.max(1, rendered.text.split('\n').length - 1) : selected.length) : null } }
              }
              const target = await searchTarget(projectPath, args.path)
              const common = ['--hidden', '--no-ignore', ...exclusionGlobs.flatMap(glob => ['--glob', `!${glob}`])]
              if (name === 'glob') {
                const pattern = stringArg(args, 'pattern')
                let matches: (path: string) => boolean
                try { matches = picomatch(pattern, { dot: true, bash: true, matchBase: !pattern.includes('/'), strictBrackets: true }) }
                catch { throw toolError('invalid-pattern', 'The glob pattern is invalid.') }
                const output = await runRg(['--files', '--null', ...common, '--', target], projectPath, signal, searchTimeoutMs)
                const candidates: { path: string; mtimeMs: number }[] = []
                for (const path of output.split('\0').filter(Boolean)) {
                  signal.throwIfAborted()
                  const relativePath = relative(target, path).split(sep).join('/') || basename(path)
                  if (excludedPath(relativePath) || !matches(relativePath)) continue
                  try {
                    const info = await fs.lstat(path)
                    if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1) candidates.push({ path: claude ? path : relative(projectPath, path).split(sep).join('/'), mtimeMs: info.mtimeMs })
                  } catch { /* A concurrently removed search entry is omitted. */ }
                }
                candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))
                const chosen: { path: string; mtimeMs: number }[] = []; let size = 0
                for (const item of candidates) {
                  const added = Buffer.byteLength(JSON.stringify(item.path))
                  if (chosen.length === 100 || size + added > maxResultBytes) break
                  chosen.push(item); size += added
                }
                return { result: { paths: chosen.map(item => item.path), truncated: chosen.length < candidates.length } }
              }
              if (name !== 'grep') throw toolError('invalid-input', 'The file tool is unsupported.')
              const pattern = stringArg(args, 'pattern'), flags = [...common]
              const filter = claude ? args.glob : args.include
              if (filter !== undefined) {
                if (typeof filter !== 'string' || !filter || (!claude && (filter.startsWith('!') || filter.includes(',')))) throw toolError('invalid-input', 'The file filter must be a single positive glob pattern.')
                flags.push('--glob', filter)
              }
              if (args['-i'] === true) flags.push('--ignore-case')
              if (args.multiline === true) flags.push('--multiline', '--multiline-dotall')
              const mode = claude ? (args.output_mode ?? 'files_with_matches') : 'content'
              if (mode === 'content') {
                const context = numberArg(args, 'context', numberArg(args, '-C', 0))
                flags.push('-B', String(numberArg(args, '-B', context)), '-A', String(numberArg(args, '-A', context)))
              }
              if (typeof args.type === 'string') flags.push('--type', args.type)
              const output = await runRg(['--json', ...flags, '-e', pattern, '--', target], projectPath, signal, searchTimeoutMs)
              const files = new Map<string, number>(), rows: JsonValue[] = [], checked = new Map<string, boolean>()
              for (const line of output.split('\n')) {
                if (!line) continue
                const event = JSON.parse(line) as { type: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number;
                  submatches?: readonly { match?: { text?: string }; start: number }[] } }
                if (event.type !== 'match' && event.type !== 'context') continue
                const data = event.data!, path = data.path?.text
                if (!path || !data.lines?.text) continue
                const rel = relative(projectPath, path).split(sep).join('/')
                if (excludedPath(rel)) continue
                if (!checked.has(path)) {
                  try {
                    await rejectLinkAncestors(path)
                    const info = await fs.lstat(path)
                    checked.set(path, info.isFile() && info.nlink === 1)
                  } catch { checked.set(path, false) }
                }
                if (!checked.get(path)) continue
                const display = claude ? path : rel
                if (event.type === 'match') files.set(display, (files.get(display) ?? 0) + (args.multiline === true ? data.submatches?.length ?? 1 : 1))
                if (mode === 'content') {
                  const parts = claude && args['-o'] === true && event.type === 'match'
                    ? (data.submatches ?? []).map(match => ({ content: match.match?.text ?? '',
                      line: (data.line_number ?? 1) + (Buffer.from(data.lines!.text!).subarray(0, match.start).toString('utf8').match(/\n/g)?.length ?? 0) }))
                    : [{ content: data.lines.text.replace(/\r?\n$/, ''), line: data.line_number ?? 1 }]
                  for (const part of parts) rows.push({ path: display, ...(args['-n'] === false ? {} : { line: part.line }),
                    text: text(part.content, 2000).text, ...(event.type === 'context' ? { context: true } : {}) })
                }
              }
              const all: JsonValue[] = mode === 'files_with_matches' ? [...files.keys()] : mode === 'count'
                ? [...files].map(([path, count]) => ({ path, count })) : rows
              const offset = numberArg(args, 'offset', 0), limit = numberArg(args, 'head_limit', claude ? 100 : 250)
              const selected = limit === 0 ? all.slice(offset) : all.slice(offset, offset + limit)
              const bounded: JsonValue[] = []; let size = 0
              for (const row of selected) { const added = Buffer.byteLength(JSON.stringify(row)); if (size + added > maxResultBytes) break; bounded.push(row); size += added }
              return { result: { outputMode: mode, matches: bounded, truncated: bounded.length < all.length - offset,
                nextOffset: bounded.length < all.length - offset ? offset + bounded.length : null } }
            } catch (error) {
              if (error instanceof Error && 'code' in error && error.code === 'cleanup-failed') { cleanupError ??= error; throw error }
              if (signal.aborted) return { result: { status: 'cancelled', code: 'cancelled', message: 'The file operation was cancelled.' } }
              if (error instanceof Error && error.name === 'FileToolError' && 'code' in error) return { result: { status: 'error', code: String(error.code), message: error.message } }
              const diagnostic = patchDiagnostic(error)
              if (diagnostic) return { result: { status: 'error', code: diagnostic.code, message: diagnostic.message } }
              if (isImageAssetError(error)) return { result: { status: 'error', code: error.code, message: 'The image could not be imported.' } }
              if (error instanceof Error && 'code' in error && ['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ELOOP', 'ENOTDIR'].includes(String(error.code))) {
                return { result: { status: 'error', code: String(error.code), message: 'The requested file or directory is missing or inaccessible.' } }
              }
              throw toolError('unavailable', 'The file operation could not be completed.')
            } finally {
              if (nested) try { await nested.done } catch (error) { cleanupError ??= error }
            }
          })()
          const call: OwnedCall<FileToolResult> = {
            result: operation,
            cancel: abort,
            done: operation.then(() => {}, () => {}).then(() => { if (cleanupError) throw cleanupError }).finally(() => {
              input.signal?.removeEventListener('abort', abort); active.delete(call)
            }),
          }
          active.add(call)
          void call.result.catch(() => {})
          void call.done.catch(error => cleanupFailures.add(error))
          return call
        },
      }
      ctx.provide(fileToolsServiceKey, service)
    },
  }
}

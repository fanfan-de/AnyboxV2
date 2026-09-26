import * as fs from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { Component } from '@nya/core'
import type { OwnedCall } from '../contracts.js'
import type { LLMToolDefinition } from '../llm/port.js'
import { projectServiceKey } from '../project/component.js'
import type { ProjectPort } from '../project/component.js'
import { applyPatchText, parsePatch, validatePatchText } from './apply-patch-domain.js'
import { patchDiagnostic, patchRejection } from './apply-patch-types.js'
import type { ApplyPatchResult, PatchChange, PatchDiagnostic, PatchOperation, PendingPatchOperation } from './apply-patch-types.js'

export const applyPatchServiceKey = 'tools.apply-patch'

export interface ApplyPatchPort {
  readonly definition: LLMToolDefinition
  execute(input: { readonly projectId: string; readonly patch: string }): OwnedCall<ApplyPatchResult>
}

export const applyPatchToolDefinition: LLMToolDefinition = Object.freeze({
  name: 'apply_patch',
  description: 'Use this tool for precise UTF-8 text file edits. Use *** Begin Patch / *** End Patch with *** Add File:, *** Update File:, or *** Delete File: headers. An update may include *** Move to:. Add-file lines start with +; update hunks start with @@ (optionally followed by an exact anchor) and use space, -, and + lines for context, removal, and addition. *** End of File anchors a hunk at EOF. Context must match exactly and uniquely. Example:\n*** Begin Patch\n*** Add File: hello.txt\n+Hello\n*** End Patch\nRelative paths use the current project directory; absolute paths and parent-directory paths use the application user\'s filesystem permissions. All files are checked first, then committed in order. A failure or cancellation may leave completed changes; inspect changes and pending before retrying.',
  parameters: Object.freeze({
    type: 'object',
    properties: Object.freeze({ patch: Object.freeze({ type: 'string', description: 'Complete patch text, including Begin Patch and End Patch markers' }) }),
    required: Object.freeze(['patch']),
    additionalProperties: false,
  }),
})

type ApplyPatchFailureCategory = 'invalid-request' | 'unavailable' | 'cleanup-failure'
type ApplyPatchFailure = Error & { readonly category: ApplyPatchFailureCategory }

function failure(category: ApplyPatchFailureCategory): ApplyPatchFailure {
  return Object.assign(new Error({
    'invalid-request': 'apply patch request is invalid',
    unavailable: 'apply patch tool is unavailable',
    'cleanup-failure': 'apply patch cleanup failed',
  }[category]), { name: 'ApplyPatchFailure', category })
}

export function isApplyPatchFailure(error: unknown): error is ApplyPatchFailure {
  return error instanceof Error && error.name === 'ApplyPatchFailure' && 'category' in error &&
    ['invalid-request', 'unavailable', 'cleanup-failure'].includes(String(error.category))
}

/** The filesystem boundary is injectable for deterministic fault and cancellation tests. */
export interface ApplyPatchFileInfo {
  readonly dev: number
  readonly ino: number
  readonly mode: number
  readonly nlink: number
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export interface ApplyPatchFileSystem {
  lstat(path: string): Promise<ApplyPatchFileInfo>
  realpath(path: string): Promise<string>
  readFile(path: string): Promise<Buffer>
  mkdir(path: string): Promise<unknown>
  mkdtemp(prefix: string): Promise<string>
  writeFile(path: string, bytes: Buffer, options: { readonly flag: 'wx'; readonly mode: number }): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  link(source: string, target: string): Promise<void>
  rename(source: string, target: string): Promise<void>
  unlink(path: string): Promise<void>
  rmdir(path: string): Promise<void>
}

export interface ApplyPatchOptions {
  readonly filesystem?: Partial<ApplyPatchFileSystem>
}

const defaultFilesystem: ApplyPatchFileSystem = {
  lstat: path => fs.lstat(path), realpath: path => fs.realpath(path), readFile: path => fs.readFile(path),
  mkdir: path => fs.mkdir(path), mkdtemp: prefix => fs.mkdtemp(prefix),
  writeFile: (path, bytes, options) => fs.writeFile(path, bytes, options), chmod: (path, mode) => fs.chmod(path, mode),
  link: (source, target) => fs.link(source, target), rename: (source, target) => fs.rename(source, target),
  unlink: path => fs.unlink(path), rmdir: path => fs.rmdir(path),
}

const filesystemCodes = new Set([
  'ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'ENOTDIR', 'EISDIR', 'ENOSPC', 'EROFS', 'EDQUOT',
  'EMFILE', 'ENFILE', 'EIO', 'EXDEV', 'EBUSY', 'EINVAL', 'ENAMETOOLONG', 'ELOOP', 'ENOTEMPTY', 'ENOTSUP', 'EOPNOTSUPP',
])

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

function filesystemDiagnostic(error: unknown, path?: string): PatchDiagnostic | undefined {
  const code = errorCode(error)
  if (!code || !filesystemCodes.has(code)) return undefined
  const category = code === 'EEXIST' ? 'target-exists' : code === 'ENOENT' ? 'file-not-found'
    : code === 'EACCES' || code === 'EPERM' || code === 'EROFS' ? 'permission-denied' : 'filesystem-error'
  const message = category === 'target-exists' ? 'The destination already exists.'
    : category === 'file-not-found' ? 'A required file or directory does not exist.'
      : category === 'permission-denied' ? 'The filesystem denied this operation.' : 'The filesystem operation could not be completed.'
  return Object.freeze({ code: category, message, ...(path === undefined ? {} : { path }) })
}

function sameInfo(left: ApplyPatchFileInfo, right: ApplyPatchFileInfo): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function requireRegularFile(info: ApplyPatchFileInfo, path: string): void {
  if (info.isSymbolicLink()) throw patchRejection('symbolic-link', 'Direct symbolic-link targets are not supported.', path)
  if (!info.isFile()) throw patchRejection('unsupported-file', 'Only regular text files are supported.', path)
  if (info.nlink !== 1) throw patchRejection('hard-link', 'Files with multiple hard links are not supported.', path)
}

interface Snapshot {
  readonly bytes: Buffer
  readonly info: ApplyPatchFileInfo
}

interface PreparedOperation {
  readonly operation: PatchOperation
  readonly source: string
  readonly target: string
  readonly snapshot?: Snapshot
  readonly output?: Buffer
}

function pendingOperation(operation: PatchOperation): PendingPatchOperation {
  return Object.freeze({ kind: operation.kind, path: operation.path,
    ...(operation.kind === 'update' && operation.moveTo !== undefined ? { moveTo: operation.moveTo } : {}) })
}

function result(status: ApplyPatchResult['status'], changes: readonly PatchChange[], pending: readonly PatchOperation[], diagnostic?: PatchDiagnostic): ApplyPatchResult {
  return Object.freeze({ status, changes: Object.freeze([...changes]), pending: Object.freeze(pending.map(pendingOperation)),
    ...(diagnostic === undefined ? {} : { diagnostic }) })
}

/** Owns a single queue across projects, temporary files and accepted filesystem operations. */
export function createApplyPatchComponent(options: ApplyPatchOptions = {}): Component.Object<void, {
  [projectServiceKey]: ProjectPort
}> {
  const filesystem: ApplyPatchFileSystem = { ...defaultFilesystem, ...options.filesystem }
  return {
    name: 'apply-patch-tool',
    inject: [projectServiceKey],
    apply(ctx, _config, deps) {
      const projects = deps[projectServiceKey]
      const active = new Set<OwnedCall<ApplyPatchResult>>()
      const failures = new Set<unknown>()
      let accepting = true
      let queue: Promise<void> = Promise.resolve()

      ctx.effect(() => async () => {
        accepting = false
        const calls = [...active]
        for (const call of calls) call.cancel('owner-disposed')
        for (const exited of await Promise.allSettled(calls.map(call => call.done))) {
          if (exited.status === 'rejected') failures.add(exited.reason)
        }
        if (failures.size === 1) throw [...failures][0]
        if (failures.size > 1) throw new AggregateError([...failures], 'apply patch cleanup failed')
      }, 'cancel and join patch operations')

      const service: ApplyPatchPort = {
        definition: applyPatchToolDefinition,
        execute(input) {
          if (!accepting) throw failure('unavailable')
          if (!input || typeof input.projectId !== 'string' || !input.projectId.trim() || typeof input.patch !== 'string') {
            throw failure('invalid-request')
          }
          let cancelled = false
          const cancellation = Symbol('patch-cancelled')
          const checkpoint = () => { if (cancelled) throw cancellation }
          let resolveResult!: (value: ApplyPatchResult) => void
          let rejectResult!: (error: unknown) => void
          const outcome = new Promise<ApplyPatchResult>((yes, no) => { resolveResult = yes; rejectResult = no })
          const temporaryFiles: string[] = []
          const temporaryDirectories: string[] = []
          const createdDirectories: string[] = []
          let operations: readonly PatchOperation[] = []
          const changes: PatchChange[] = []
          let next = 0
          let diagnosticPath: string | undefined

          const existingInfo = async (path: string): Promise<ApplyPatchFileInfo | undefined> => {
            try { return await filesystem.lstat(path) }
            catch (error) { if (errorCode(error) === 'ENOENT') return undefined; throw error }
          }

          // Resolve the existing parent prefix without creating anything. Parent links are allowed;
          // final-component links are checked separately and are never followed intentionally.
          const canonicalTarget = async (path: string): Promise<string> => {
            let parent = dirname(path)
            const missing: string[] = []
            while (true) {
              try {
                const canonical = await filesystem.realpath(parent)
                if (!(await filesystem.lstat(canonical)).isDirectory()) {
                  throw patchRejection('invalid-parent', 'The target parent must be a directory.', diagnosticPath)
                }
                return join(canonical, ...missing.reverse(), basename(path))
              } catch (error) {
                if (errorCode(error) !== 'ENOENT') throw error
                if (await existingInfo(parent)) {
                  throw patchRejection('invalid-parent', 'The target parent could not be resolved.', diagnosticPath)
                }
                const ancestor = dirname(parent)
                if (ancestor === parent) throw error
                missing.push(basename(parent))
                parent = ancestor
              }
            }
          }

          const snapshot = async (path: string, displayPath: string): Promise<Snapshot> => {
            const before = await filesystem.lstat(path)
            requireRegularFile(before, displayPath)
            const bytes = await filesystem.readFile(path)
            const after = await filesystem.lstat(path)
            requireRegularFile(after, displayPath)
            if (!sameInfo(before, after)) throw patchRejection('file-changed', 'The file changed while it was being read.', displayPath)
            validatePatchText(bytes)
            return { bytes, info: after }
          }

          const verifySource = async (prepared: PreparedOperation): Promise<void> => {
            const current = await snapshot(prepared.source, prepared.operation.path)
            if (!sameInfo(current.info, prepared.snapshot!.info) || !current.bytes.equals(prepared.snapshot!.bytes)) {
              throw patchRejection('file-changed', 'The file changed after patch preflight.', prepared.operation.path)
            }
          }

          const ensureParent = async (path: string): Promise<void> => {
            const missing: string[] = []
            let parent = dirname(path)
            while (!await existingInfo(parent)) {
              missing.push(parent)
              const ancestor = dirname(parent)
              if (ancestor === parent) throw patchRejection('invalid-parent', 'The target parent is unavailable.', diagnosticPath)
              parent = ancestor
            }
            if (!(await filesystem.lstat(parent)).isDirectory()) {
              throw patchRejection('invalid-parent', 'The target parent must be a directory.', diagnosticPath)
            }
            for (const directory of missing.reverse()) {
              try { await filesystem.mkdir(directory); createdDirectories.push(directory) }
              catch (error) {
                if (errorCode(error) !== 'EEXIST') throw error
                if (!(await filesystem.lstat(directory)).isDirectory()) {
                  throw patchRejection('invalid-parent', 'The target parent must be a directory.', diagnosticPath)
                }
              }
            }
            if (await filesystem.realpath(dirname(path)) !== dirname(path)) {
              throw patchRejection('file-changed', 'The target parent changed after patch preflight.', diagnosticPath)
            }
          }

          const stage = async (prepared: PreparedOperation): Promise<string> => {
            await ensureParent(prepared.target)
            const temporaryDirectory = await filesystem.mkdtemp(join(dirname(prepared.target), '.anybox-patch-'))
            temporaryDirectories.push(temporaryDirectory)
            const temporary = join(temporaryDirectory, 'content')
            temporaryFiles.push(temporary)
            await filesystem.writeFile(temporary, prepared.output!, { flag: 'wx', mode: 0o600 })
            await filesystem.chmod(temporary, prepared.snapshot ? prepared.snapshot.info.mode & 0o777 : 0o666 & ~process.umask())
            return temporary
          }

          const cleanup = async (): Promise<void> => {
            let failed = false
            for (const path of temporaryFiles.reverse()) {
              try { await filesystem.unlink(path) }
              catch (error) { if (errorCode(error) !== 'ENOENT') failed = true }
            }
            for (const path of temporaryDirectories.reverse()) {
              try { await filesystem.rmdir(path) }
              catch (error) { if (errorCode(error) !== 'ENOENT') failed = true }
            }
            // Keep directories containing committed files or concurrent users' new entries.
            for (const path of createdDirectories.reverse()) {
              try { await filesystem.rmdir(path) }
              catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(errorCode(error) ?? '')) failed = true }
            }
            if (failed) throw failure('cleanup-failure')
          }

          const work = async (): Promise<ApplyPatchResult> => {
            operations = parsePatch(input.patch)
            checkpoint()
            let projectPath: string
            try { projectPath = (await projects.requireAvailable(input.projectId)).path }
            catch { throw failure('unavailable') }
            checkpoint()
            const planned: PreparedOperation[] = []
            const claimed: string[] = []
            const claim = (path: string, displayPath: string) => {
              // Conservatively collapse Unicode case aliases as well as ordinary case.
              // This also rejects ambiguous spellings on case-sensitive macOS volumes.
              const key = process.platform === 'darwin'
                ? path.normalize('NFD').toUpperCase().toLowerCase().normalize('NFD')
                : process.platform === 'win32' ? path.toUpperCase().toLowerCase() : path
              if (claimed.some(prior => prior === key || prior.startsWith(`${key}${sep}`) || key.startsWith(`${prior}${sep}`))) {
                throw patchRejection('overlapping-paths', 'A patch cannot touch the same path, an alias, or parent and child targets more than once.', displayPath)
              }
              claimed.push(key)
            }
            for (const operation of operations) {
              diagnosticPath = operation.path
              checkpoint()
              let source = await canonicalTarget(resolve(projectPath, operation.path))
              checkpoint()
              if (operation.kind === 'add') {
                claim(source, operation.path)
                if (await existingInfo(source)) throw patchRejection('target-exists', 'The destination already exists.', operation.path)
                const output = Buffer.from(operation.content, 'utf8')
                validatePatchText(output)
                planned.push({ operation, source, target: source, output })
              } else {
                const prior = await snapshot(source, operation.path)
                source = await filesystem.realpath(source)
                claim(source, operation.path)
                const output = operation.kind === 'update' ? applyPatchText(prior.bytes, operation.chunks) : undefined
                let target = source
                if (operation.kind === 'update' && operation.moveTo !== undefined) {
                  diagnosticPath = operation.moveTo
                  target = await canonicalTarget(resolve(projectPath, operation.moveTo))
                  claim(target, operation.moveTo)
                  if (await existingInfo(target)) throw patchRejection('target-exists', 'The destination already exists.', operation.moveTo)
                }
                planned.push({ operation, source, target, snapshot: prior, output })
              }
              checkpoint()
            }
            // A later preflight read can give external writers time to change an earlier source.
            // Recheck the entire plan before allowing the first filesystem mutation.
            for (const prepared of planned) {
              diagnosticPath = prepared.operation.path
              checkpoint()
              if (prepared.snapshot) await verifySource(prepared)
              if (prepared.operation.kind === 'add' || prepared.target !== prepared.source) {
                if (await existingInfo(prepared.target)) throw patchRejection('target-exists', 'The destination already exists.', diagnosticPath)
              }
              checkpoint()
            }
            for (const prepared of planned) {
              checkpoint()
              diagnosticPath = prepared.operation.path
              // Once a file (including both halves of Move) starts committing, cancellation
              // waits for this unit to exit. It never interrupts a file write or drops its facts.
              if (prepared.operation.kind === 'delete') {
                await verifySource(prepared)
                await filesystem.unlink(prepared.source)
                changes.push(Object.freeze({ kind: 'deleted', path: prepared.operation.path }))
              } else {
                const temporary = await stage(prepared)
                if (prepared.snapshot) await verifySource(prepared)
                if (prepared.operation.kind === 'add' || prepared.target !== prepared.source) {
                  // link is an atomic, same-filesystem no-clobber publish; rename would replace
                  // a destination created by another writer after our preflight check.
                  await filesystem.link(temporary, prepared.target)
                  changes.push(Object.freeze({ kind: 'added', path: prepared.operation.kind === 'update'
                    ? prepared.operation.moveTo! : prepared.operation.path }))
                  if (prepared.operation.kind === 'update') {
                    try {
                      await verifySource(prepared)
                      await filesystem.unlink(prepared.source)
                    } catch (error) {
                      const diagnostic = patchDiagnostic(error) ?? filesystemDiagnostic(error, prepared.operation.path)
                      if (!diagnostic) throw error
                      throw patchRejection('move-source-not-deleted', 'The destination was created, but the source was not deleted.', prepared.operation.path)
                    }
                    changes.push(Object.freeze({ kind: 'deleted', path: prepared.operation.path }))
                  }
                } else {
                  await filesystem.rename(temporary, prepared.target)
                  changes.push(Object.freeze({ kind: 'updated', path: prepared.operation.path }))
                }
              }
              next++
            }
            return result(cancelled ? 'cancelled' : 'applied', changes, operations.slice(next))
          }

          const exited = queue.then(async () => {
            try { resolveResult(await work()) }
            catch (error) {
              if (error === cancellation) resolveResult(result('cancelled', changes, operations.slice(next)))
              else {
                const baseDiagnostic = patchDiagnostic(error) ?? filesystemDiagnostic(error, diagnosticPath)
                const diagnostic = baseDiagnostic && baseDiagnostic.path === undefined && diagnosticPath !== undefined
                  ? Object.freeze({ ...baseDiagnostic, path: diagnosticPath }) : baseDiagnostic
                if (diagnostic) resolveResult(result(cancelled ? 'cancelled' : changes.length ? 'partial' : 'rejected', changes, operations.slice(next), diagnostic))
                else rejectResult(isApplyPatchFailure(error) ? error : failure('unavailable'))
              }
            } finally { await cleanup() }
          })
          const call: OwnedCall<ApplyPatchResult> = {
            result: outcome,
            done: exited.finally(() => { active.delete(call) }),
            cancel() { cancelled = true },
          }
          active.add(call)
          queue = call.done.then(() => {}, () => {})
          void call.result.catch(() => {})
          void call.done.catch(error => { failures.add(error) })
          return call
        },
      }
      ctx.provide(applyPatchServiceKey, service)
    },
  }
}

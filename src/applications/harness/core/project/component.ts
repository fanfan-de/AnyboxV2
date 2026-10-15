import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import type { Component } from '@nya/core'
import type { OwnedCall, RuntimeInputs } from '../contracts.js'
import { createDirectoryBrowser } from './directory-browser.js'
import type { DirectoryBrowserOptions } from './directory-browser.js'
import type { DirectoryBrowseOpened, DirectoryBrowseOptions, DirectoryCreated, DirectoryPage } from './directories.js'
import { localStorageServiceKey } from '../../../../storage/port.js'
import type { LocalStoragePort, StorageMigration, StorageRow, StorageReader } from '../../../../storage/port.js'
import type { ComputerQuery, ComputerQueryResult } from '../computer/query-domain.js'
import { localAttachmentId, validateUnitId } from '../unit/domain.js'

export const projectServiceKey = 'harness.projects'
const localComputerAttachment = localAttachmentId('computer')

export interface Project {
  readonly id: string
  /** Absolute path on the bound Computer unit; pinned-local, meaningful only there. */
  readonly path: string
  readonly name: string
  readonly createdAt: string
  readonly available: boolean
  /** The Computer attachment that serves this project's tools and reads; `local:computer` for this harness server's own worker. */
  readonly computerAttachmentId: string
}
export interface OpenProjectOptions { readonly computerAttachmentId?: string }

export interface ProjectUnavailableError extends Error {
  readonly code: 'project-unavailable'
}

export function projectUnavailableError(): ProjectUnavailableError {
  return Object.assign(new Error('project directory is unavailable'), {
    name: 'ProjectUnavailableError', code: 'project-unavailable' as const,
  })
}

export function isProjectUnavailableError(error: unknown): error is ProjectUnavailableError {
  return error instanceof Error && 'code' in error && error.code === 'project-unavailable'
}

export interface ProjectPort {
  /** Stable metadata in a caller's business transaction; never checks the filesystem. */
  getIn(reader: StorageReader, id: string): Project | undefined
  readonly directoryBrowsingSupported: boolean
  readonly directoryCreationSupported: boolean
  openDirectoryBrowse(owner: string, input: DirectoryBrowseOptions, signal?: AbortSignal): OwnedCall<DirectoryBrowseOpened>
  readDirectoryPage(owner: string, browseId: string, page: number, signal?: AbortSignal): OwnedCall<DirectoryPage>
  createDirectory(owner: string, browseId: string, name: string, signal?: AbortSignal): OwnedCall<DirectoryCreated>
  closeDirectoryBrowse(owner: string, browseId: string): Promise<void>
  onDirectoryBrowseRetired(listener: (browseId: string) => void): () => void
  openProject(path: string, options?: OpenProjectOptions): Promise<Project>
  listProjects(): Promise<readonly Project[]>
  getProject(id: string): Promise<Project | undefined>
  requireAvailable(id: string): Promise<Project>
}

export interface ProjectOptions {
  /** A host supplies its own operating-system user's home, never a browser's home. */
  readonly directoryHome?: string
  /** Internal provider and clocks can be replaced for lifecycle verification. */
  readonly directoryBrowser?: Omit<DirectoryBrowserOptions, 'homePath'>
  /** Trusted host declarations, idempotently registered on each activation; always bound to the default Computer attachment. */
  readonly initialProjects?: readonly string[]
  /** Binding for projects opened without an explicit attachment: the local worker, or the remote form's configured attachment. */
  readonly defaultComputerAttachmentId?: string
  /**
   * Trusted composition-root entry to the current Computer contract's read-only query surface, resolved per call. Projects is a
   * dependency of the tools on a worker root, so it cannot inject `computer.worker` itself; without this entry remote bindings are unavailable.
   */
  readonly computerQuery?: (attachmentId: string, query: ComputerQuery) => Promise<ComputerQueryResult>
}

const migrations: readonly StorageMigration[] = [{
  version: 1,
  up(tx) {
    tx.execute(`CREATE TABLE harness_projects (
      id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL
    )`)
  },
}, {
  // v2: a project is bound to one Computer attachment; the same path may exist on different units.
  // Sessions reference harness_projects(id) and foreign keys are enforced, so the table is rebuilt under its own name with
  // deferred constraint checking: dropping it counts the referencing sessions as violations and re-inserting the same ids clears them.
  version: 2,
  up(tx) {
    tx.execute('PRAGMA defer_foreign_keys = ON')
    tx.execute('CREATE TABLE harness_projects_rebuild AS SELECT id, path, name, created_at FROM harness_projects')
    tx.execute('DROP TABLE harness_projects')
    tx.execute(`CREATE TABLE harness_projects (
      id TEXT PRIMARY KEY, path TEXT NOT NULL, computer_attachment_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(path, computer_attachment_id)
    )`)
    tx.execute(`INSERT INTO harness_projects (id, path, computer_attachment_id, name, created_at)
      SELECT id, path, '${localComputerAttachment}', name, created_at FROM harness_projects_rebuild`)
    tx.execute('DROP TABLE harness_projects_rebuild')
  },
}]

function stored(row: StorageRow): Project {
  const { id, path, name, created_at: createdAt, computer_attachment_id: computerAttachmentId } = row
  if (typeof id !== 'string' || typeof path !== 'string' || typeof name !== 'string' || typeof createdAt !== 'string' || typeof computerAttachmentId !== 'string') {
    throw new Error('invalid stored project')
  }
  return Object.freeze({ id, path, name, createdAt, available: false, computerAttachmentId })
}

type ComputerQueryEntry = NonNullable<ProjectOptions['computerQuery']>
/** Local projects are checked on this host; remote ones through the bound unit's read-only query surface. */
async function availability(project: Project, computerQuery: ComputerQueryEntry): Promise<Project> {
  try {
    if (project.computerAttachmentId === localComputerAttachment) {
      const info = await stat(project.path)
      return Object.freeze({ ...project, available: info.isDirectory() })
    }
    const result = await computerQuery(project.computerAttachmentId, { kind: 'stat', path: project.path })
    return Object.freeze({ ...project, available: result.kind === 'stat' && result.directory })
  } catch { return project }
}

/** Project identity and directory availability; conversation state belongs to the state provider. */
export function createProjectComponent(inputs: RuntimeInputs, options: ProjectOptions = {}): Component.Object<void, {
  [localStorageServiceKey]: LocalStoragePort
}> {
  const defaultBinding = validateUnitId(options.defaultComputerAttachmentId ?? localComputerAttachment)
  const computerQuery: ComputerQueryEntry = options.computerQuery ?? (() => Promise.reject(projectUnavailableError()))
  return {
    name: 'harness-projects',
    inject: [localStorageServiceKey],
    async apply(ctx, _config, deps) {
      const db = deps[localStorageServiceKey]
      await db.migrate('projects', migrations)
      const directories = createDirectoryBrowser({ ...options.directoryBrowser, homePath: options.directoryHome })
      let accepting = true
      const pending = new Set<Promise<unknown>>()
      ctx.effect(() => async () => {
        accepting = false
        const [directoryCleanup] = await Promise.allSettled([directories.close(), Promise.allSettled([...pending])])
        if (directoryCleanup.status === 'rejected') throw directoryCleanup.reason
      }, 'join project operations')
      const track = <T>(work: () => Promise<T>): Promise<T> => {
        if (!accepting) return Promise.reject(new Error('project service is closing'))
        const result = work()
        pending.add(result)
        void result.finally(() => pending.delete(result)).catch(() => {})
        return result
      }
      const get = (id: string) => db.read(reader => reader.get(
        'SELECT * FROM harness_projects WHERE id = ?', [id]))
      const service: ProjectPort = {
        getIn(reader, id) {
          if (!accepting) throw new Error('project service is closing')
          const row = reader.get('SELECT * FROM harness_projects WHERE id = ?', [id])
          return row ? stored(row) : undefined
        },
        directoryBrowsingSupported: directories.supported,
        directoryCreationSupported: directories.creationSupported,
        openDirectoryBrowse: (owner, input, signal) => directories.open(owner, input, signal),
        readDirectoryPage: (owner, browseId, page, signal) => directories.page(owner, browseId, page, signal),
        createDirectory: (owner, browseId, name, signal) => directories.create(owner, browseId, name, signal),
        closeDirectoryBrowse: (owner, browseId) => directories.release(owner, browseId),
        onDirectoryBrowseRetired: listener => directories.onRetired(listener),
        openProject(path, openOptions = {}) {
          return track(async () => {
            if (typeof path !== 'string' || !isAbsolute(path) || !path.trim()) {
              throw new TypeError('an absolute project directory is required')
            }
            const binding = openOptions.computerAttachmentId === undefined ? defaultBinding : validateUnitId(openOptions.computerAttachmentId)
            let canonical: string
            if (binding === localComputerAttachment) {
              try {
                canonical = await realpath(path)
                if (!(await stat(canonical)).isDirectory()) throw projectUnavailableError()
              } catch { throw projectUnavailableError() }
            } else {
              // The directory lives on the bound unit; its own read-only query surface resolves and checks it under the attachment ceiling.
              let result: ComputerQueryResult
              try { result = await computerQuery(binding, { kind: 'stat', path }) } catch { throw projectUnavailableError() }
              if (result.kind !== 'stat' || !result.directory || result.canonical === null) throw projectUnavailableError()
              canonical = result.canonical
            }
            const row = await db.transaction(tx => {
              const prior = tx.get('SELECT * FROM harness_projects WHERE path = ? AND computer_attachment_id = ?', [canonical, binding])
              if (prior) return prior
              const id = inputs.newId()
              tx.execute('INSERT INTO harness_projects (id, path, computer_attachment_id, name, created_at) VALUES (?, ?, ?, ?, ?)',
                [id, canonical, binding, basename(canonical) || canonical, inputs.now()])
              return tx.get('SELECT * FROM harness_projects WHERE id = ?', [id])!
            })
            return Object.freeze({ ...stored(row), available: true })
          })
        },
        listProjects() {
          return track(async () => {
            const rows = await db.read(reader => reader.all(
              'SELECT * FROM harness_projects ORDER BY created_at, id'))
            return Object.freeze(await Promise.all(rows.map(row => availability(stored(row), computerQuery))))
          })
        },
        getProject(id) {
          return track(async () => {
            const row = await get(id)
            return row ? availability(stored(row), computerQuery) : undefined
          })
        },
        requireAvailable(id) {
          return track(async () => {
            const row = await get(id)
            if (!row) throw new Error(`unknown project ${id}`)
            const project = await availability(stored(row), computerQuery)
            if (!project.available) throw projectUnavailableError()
            return project
          })
        },
      }
      for (const path of options.initialProjects ?? []) await service.openProject(path)
      ctx.provide(projectServiceKey, service)
    },
  }
}

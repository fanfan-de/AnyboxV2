import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute } from 'node:path'
import type { Component } from '@nya/core'
import type { RuntimeInputs } from '../contracts.js'
import { localStorageServiceKey } from '../storage/port.js'
import type { LocalStoragePort, StorageMigration, StorageRow } from '../storage/port.js'

export const projectServiceKey = 'harness.projects'

export interface Project {
  readonly id: string
  readonly path: string
  readonly name: string
  readonly createdAt: string
  readonly available: boolean
}

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
  openProject(path: string): Promise<Project>
  listProjects(): Promise<readonly Project[]>
  getProject(id: string): Promise<Project | undefined>
  requireAvailable(id: string): Promise<Project>
}

const migrations: readonly StorageMigration[] = [{
  version: 1,
  up(tx) {
    tx.execute(`CREATE TABLE harness_projects (
      id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL
    )`)
  },
}]

function stored(row: StorageRow): Project {
  const { id, path, name, created_at: createdAt } = row
  if (typeof id !== 'string' || typeof path !== 'string' || typeof name !== 'string' || typeof createdAt !== 'string') {
    throw new Error('invalid stored project')
  }
  return Object.freeze({ id, path, name, createdAt, available: false })
}

async function availability(project: Project): Promise<Project> {
  try {
    const info = await stat(project.path)
    return Object.freeze({ ...project, available: info.isDirectory() })
  } catch { return project }
}

/** Project identity and directory availability; conversation state belongs to the state provider. */
export function createProjectComponent(inputs: RuntimeInputs): Component.Object<void, {
  [localStorageServiceKey]: LocalStoragePort
}> {
  return {
    name: 'harness-projects',
    inject: [localStorageServiceKey],
    async apply(ctx, _config, deps) {
      const db = deps[localStorageServiceKey]
      await db.migrate('projects', migrations)
      let accepting = true
      const pending = new Set<Promise<unknown>>()
      ctx.effect(() => async () => {
        accepting = false
        await Promise.allSettled([...pending])
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
        openProject(path) {
          return track(async () => {
            if (typeof path !== 'string' || !isAbsolute(path) || !path.trim()) {
              throw new TypeError('an absolute project directory is required')
            }
            let canonical: string
            try {
              canonical = await realpath(path)
              if (!(await stat(canonical)).isDirectory()) throw projectUnavailableError()
            } catch { throw projectUnavailableError() }
            const row = await db.transaction(tx => {
              const prior = tx.get('SELECT * FROM harness_projects WHERE path = ?', [canonical])
              if (prior) return prior
              const id = inputs.newId()
              tx.execute('INSERT INTO harness_projects (id, path, name, created_at) VALUES (?, ?, ?, ?)',
                [id, canonical, basename(canonical) || canonical, inputs.now()])
              return tx.get('SELECT * FROM harness_projects WHERE id = ?', [id])!
            })
            return Object.freeze({ ...stored(row), available: true })
          })
        },
        listProjects() {
          return track(async () => {
            const rows = await db.read(reader => reader.all(
              'SELECT * FROM harness_projects ORDER BY created_at, id'))
            return Object.freeze(await Promise.all(rows.map(row => availability(stored(row)))))
          })
        },
        getProject(id) {
          return track(async () => {
            const row = await get(id)
            return row ? availability(stored(row)) : undefined
          })
        },
        requireAvailable(id) {
          return track(async () => {
            const row = await get(id)
            if (!row) throw new Error(`unknown project ${id}`)
            const project = await availability(stored(row))
            if (!project.available) throw projectUnavailableError()
            return project
          })
        },
      }
      ctx.provide(projectServiceKey, service)
    },
  }
}

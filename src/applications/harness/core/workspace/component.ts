import { randomUUID } from 'node:crypto'
import type { Component } from '@nya/core'
import { localStorageServiceKey } from '../../../../storage/port.js'
import type { LocalStoragePort, StorageMigration, StorageReader, StorageRow } from '../../../../storage/port.js'
import type { OwnedCall } from '../contracts.js'
import { localComputerProviderId } from '../computer/port.js'
import { projectServiceKey } from '../project/component.js'
import type { ProjectPort } from '../project/component.js'
import { workspacesServiceKey } from './port.js'
import type { WorkspacesOptions, WorkspacesPort } from './port.js'
import { sameWorkspaceBinding, workspaceError, workspacePath, workspacePositive, workspaceText, workspaceTimestamp } from './domain.js'
import type { PreparedWorkspaceBinding, Workspace, WorkspaceBinding, WorkspaceReservation } from './domain.js'

const migrations: readonly StorageMigration[] = [{ version: 1, up(tx) {
  tx.execute(`CREATE TABLE harness_workspaces (
    workspace_id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE, pinned_path TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode = 'pinned-local'), revision INTEGER NOT NULL CHECK(revision = 0),
    workspace_epoch INTEGER NOT NULL CHECK(workspace_epoch > 0), created_at TEXT NOT NULL
  )`)
  tx.execute(`CREATE TABLE harness_workspace_reservations (
    reservation_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES harness_workspaces(workspace_id),
    scope_id TEXT NOT NULL, created_at TEXT NOT NULL, released_at TEXT
  )`)
  tx.execute(`CREATE TABLE harness_workspace_bindings (
    binding_id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL UNIQUE REFERENCES harness_workspace_reservations(reservation_id),
    computer_id TEXT NOT NULL, computer_instance_id TEXT NOT NULL, instance_generation INTEGER NOT NULL,
    workspace_epoch INTEGER NOT NULL, revision INTEGER NOT NULL, local_path TEXT NOT NULL, prepared_at TEXT NOT NULL
  )`)
} }]

function workspace(row: StorageRow): Workspace {
  if (row.mode !== 'pinned-local' || row.revision !== 0) throw workspaceError('workspace-invalid')
  return Object.freeze({ workspaceId: workspaceText(row.workspace_id), projectId: workspaceText(row.project_id),
    mode: 'pinned-local', revision: 0, workspaceEpoch: workspacePositive(row.workspace_epoch), createdAt: workspaceTimestamp(row.created_at) })
}

function reservation(row: StorageRow): WorkspaceReservation {
  return Object.freeze({ reservationId: workspaceText(row.reservation_id), workspaceId: workspaceText(row.workspace_id),
    projectId: workspaceText(row.project_id), scopeId: workspaceText(row.scope_id), createdAt: workspaceTimestamp(row.created_at),
    ...(row.released_at === null ? {} : { releasedAt: workspaceTimestamp(row.released_at) }) })
}

function binding(row: StorageRow): WorkspaceBinding {
  if (row.revision !== 0) throw workspaceError('workspace-invalid')
  return Object.freeze({ bindingId: workspaceText(row.binding_id), reservationId: workspaceText(row.reservation_id),
    workspaceId: workspaceText(row.workspace_id), projectId: workspaceText(row.project_id), scopeId: workspaceText(row.scope_id),
    computerId: workspaceText(row.computer_id), computerInstanceId: workspaceText(row.computer_instance_id),
    instanceGeneration: workspacePositive(row.instance_generation), workspaceEpoch: workspacePositive(row.workspace_epoch),
    revision: 0, path: workspacePath(row.local_path), preparedAt: workspaceTimestamp(row.prepared_at) })
}

function reservationRow(reader: StorageReader, id: string): StorageRow | undefined {
  return reader.get(`SELECT r.*, w.project_id, w.pinned_path, w.revision, w.workspace_epoch
    FROM harness_workspace_reservations r JOIN harness_workspaces w ON w.workspace_id = r.workspace_id
    WHERE r.reservation_id = ?`, [id])
}

function bindingRow(reader: StorageReader, id: string): StorageRow | undefined {
  return reader.get(`SELECT b.*, r.workspace_id, r.scope_id, w.project_id
    FROM harness_workspace_bindings b JOIN harness_workspace_reservations r ON r.reservation_id = b.reservation_id
    JOIN harness_workspaces w ON w.workspace_id = r.workspace_id WHERE b.reservation_id = ?`, [id])
}

/** Persisted local identity and scope placement; Projects retains directory identity and availability. */
export function createWorkspacesComponent(options: WorkspacesOptions = {}): Component.Object<void, {
  [localStorageServiceKey]: LocalStoragePort
  [projectServiceKey]: ProjectPort
}> {
  const now = options.now ?? (() => new Date().toISOString()), newId = options.newId ?? randomUUID
  const providerId = workspaceText(options.localProviderId ?? localComputerProviderId)
  return { name: 'harness-workspaces', inject: [projectServiceKey, localStorageServiceKey], async apply(ctx, _config, deps) {
    const db = deps[localStorageServiceKey], projects = deps[projectServiceKey]
    await db.migrate('workspaces', migrations)
    let accepting = true
    const calls = new Set<OwnedCall<unknown>>(), pending = new Set<Promise<unknown>>()
    const preparedReceipts = new WeakSet<PreparedWorkspaceBinding>()
    const ensureOpen = () => { if (!accepting) throw workspaceError('workspace-unavailable') }
    const timestamp = () => workspaceTimestamp(now())
    const track = <T>(work: () => Promise<T>): Promise<T> => {
      ensureOpen()
      const result = work()
      pending.add(result)
      void result.finally(() => pending.delete(result)).catch(() => {})
      return result
    }
    const owned = <T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): OwnedCall<T> => {
      ensureOpen()
      const controller = new AbortController(), abort = () => controller.abort()
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      let call!: OwnedCall<T>
      const result = Promise.resolve().then(async () => {
        if (controller.signal.aborted) throw workspaceError('workspace-cancelled')
        const value = await work(controller.signal)
        if (controller.signal.aborted) throw workspaceError('workspace-cancelled')
        return value
      }).catch(error => {
        if (controller.signal.aborted) throw workspaceError('workspace-cancelled')
        throw error
      }).finally(() => { signal?.removeEventListener('abort', abort); calls.delete(call) })
      const done = result.then(() => {}, () => {})
      call = Object.freeze({ result, done, cancel: (_reason: string) => abort() })
      calls.add(call)
      void result.catch(() => {})
      return call
    }
    ctx.effect(() => async () => {
      accepting = false
      for (const call of calls) call.cancel('owner-disposed')
      await Promise.allSettled([...calls].map(call => call.done))
      await Promise.allSettled([...pending])
    }, 'join workspace operations')
    const service: WorkspacesPort = {
      get(id) { return track(async () => {
        const row = await db.read(reader => reader.get('SELECT * FROM harness_workspaces WHERE workspace_id = ?', [workspaceText(id)]))
        return row ? workspace(row) : undefined
      }) },
      getForProject(id) { return track(async () => {
        const row = await db.read(reader => reader.get('SELECT * FROM harness_workspaces WHERE project_id = ?', [workspaceText(id)]))
        return row ? workspace(row) : undefined
      }) },
      getBinding(id) { return track(async () => {
        const row = await db.read(reader => bindingRow(reader, workspaceText(id)))
        return row ? binding(row) : undefined
      }) },
      reserveIn(tx, input) {
        ensureOpen()
        const id = workspaceText(input.reservationId), scopeId = workspaceText(input.scopeId)
        const projectId = workspaceText(input.projectId), project = projects.getIn(tx, projectId)
        if (!project) throw workspaceError('workspace-missing')
        const path = workspacePath(project.path)
        const prior = reservationRow(tx, id)
        if (prior) {
          if (prior.project_id !== projectId || prior.scope_id !== scopeId || prior.pinned_path !== path) throw workspaceError('workspace-reservation-conflict')
          if (prior.released_at !== null) throw workspaceError('workspace-released')
          return reservation(prior)
        }
        const priorWorkspace = tx.get('SELECT * FROM harness_workspaces WHERE project_id = ?', [projectId])
        if (priorWorkspace && priorWorkspace.pinned_path !== path) throw workspaceError('workspace-reservation-conflict')
        const workspaceId = priorWorkspace ? workspaceText(priorWorkspace.workspace_id) : workspaceText(newId())
        const at = timestamp()
        if (!priorWorkspace) tx.execute(`INSERT INTO harness_workspaces
          (workspace_id, project_id, pinned_path, mode, revision, workspace_epoch, created_at) VALUES (?, ?, ?, 'pinned-local', 0, 1, ?)`,
        [workspaceId, projectId, path, at])
        tx.execute('INSERT INTO harness_workspace_reservations (reservation_id, workspace_id, scope_id, created_at) VALUES (?, ?, ?, ?)',
          [id, workspaceId, scopeId, at])
        return reservation(reservationRow(tx, id)!)
      },
      prepare(input, signal) { return owned(async cancel => {
        const id = workspaceText(input.reservationId), instance = input.instance
        workspaceText(instance.computerId); workspaceText(instance.computerInstanceId); workspacePositive(instance.instanceGeneration)
        if (instance.status !== 'ready' || instance.providerId !== providerId) throw workspaceError('workspace-unavailable')
        const row = await db.read(reader => reservationRow(reader, id), cancel)
        if (!row) throw workspaceError('workspace-missing')
        if (row.released_at !== null) throw workspaceError('workspace-released')
        const project = await projects.requireAvailable(workspaceText(row.project_id))
        if (project.path !== row.pinned_path) throw workspaceError('workspace-binding-conflict')
        if (cancel.aborted) throw workspaceError('workspace-cancelled')
        const prior = await db.read(reader => bindingRow(reader, id), cancel)
        if (prior && (prior.computer_instance_id !== instance.computerInstanceId || prior.instance_generation !== instance.instanceGeneration ||
          prior.computer_id !== instance.computerId)) throw workspaceError('workspace-binding-conflict')
        const preparationId = workspaceText(newId())
        const prepared: PreparedWorkspaceBinding = Object.freeze({
          ...(prior ? binding(prior) : { bindingId: workspaceText(newId()), reservationId: id, workspaceId: workspaceText(row.workspace_id),
            projectId: project.id, scopeId: workspaceText(row.scope_id), computerId: instance.computerId,
            computerInstanceId: instance.computerInstanceId, instanceGeneration: instance.instanceGeneration,
            workspaceEpoch: workspacePositive(row.workspace_epoch), revision: 0, path: project.path, preparedAt: timestamp() }),
          preparationId,
        })
        preparedReceipts.add(prepared)
        return prepared
      }, signal) },
      bindIn(tx, input) {
        ensureOpen()
        const id = workspaceText(input.reservationId), prepared = input.prepared
        const row = reservationRow(tx, id)
        if (!row) throw workspaceError('workspace-missing')
        if (row.released_at !== null) throw workspaceError('workspace-released')
        const prior = bindingRow(tx, id)
        if (prior) {
          const existing = binding(prior)
          if (!sameWorkspaceBinding(existing, prepared)) throw workspaceError('workspace-binding-conflict')
          return existing
        }
        workspaceText(prepared.preparationId)
        if (!preparedReceipts.has(prepared)) throw workspaceError('workspace-stale-preparation')
        if (prepared.reservationId !== id || prepared.workspaceId !== row.workspace_id || prepared.projectId !== row.project_id ||
          prepared.scopeId !== row.scope_id || prepared.path !== row.pinned_path || prepared.workspaceEpoch !== row.workspace_epoch ||
          prepared.revision !== row.revision) throw workspaceError('workspace-binding-conflict')
        tx.execute(`INSERT INTO harness_workspace_bindings
          (binding_id, reservation_id, computer_id, computer_instance_id, instance_generation, workspace_epoch, revision, local_path, prepared_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [prepared.bindingId, id, prepared.computerId, prepared.computerInstanceId,
          prepared.instanceGeneration, prepared.workspaceEpoch, prepared.revision, prepared.path, prepared.preparedAt])
        return binding(bindingRow(tx, id)!)
      },
      requireBindingIn(tx, input) {
        ensureOpen()
        const row = reservationRow(tx, workspaceText(input.reservationId))
        if (!row) throw workspaceError('workspace-missing')
        if (row.released_at !== null) throw workspaceError('workspace-released')
        const selected = bindingRow(tx, input.reservationId)
        if (!selected) throw workspaceError('workspace-unavailable')
        const current = binding(selected)
        if (current.scopeId !== workspaceText(input.scopeId) ||
          current.computerInstanceId !== workspaceText(input.computerInstanceId) ||
          current.instanceGeneration !== workspacePositive(input.instanceGeneration) ||
          current.workspaceEpoch !== workspacePositive(input.workspaceEpoch) || current.workspaceEpoch !== row.workspace_epoch) {
          throw workspaceError('workspace-binding-conflict')
        }
        return current
      },
      releaseIn(tx, id, scopeId) {
        ensureOpen()
        const row = reservationRow(tx, workspaceText(id))
        if (!row) throw workspaceError('workspace-missing')
        if (row.scope_id !== workspaceText(scopeId)) throw workspaceError('workspace-reservation-conflict')
        if (row.released_at === null) tx.execute('UPDATE harness_workspace_reservations SET released_at = ? WHERE reservation_id = ?', [timestamp(), id])
      },
    }
    ctx.provide(workspacesServiceKey, service)
  } }
}

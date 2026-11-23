import type { LocalStoragePort, StorageMigration, StorageReader, StorageTransaction } from '@anybox/storage-sqlite/port'
import type { RuntimeInputs } from '../contracts.js'
import type { RunUnitBinding, UnitAttachmentsPort } from '../unit/port.js'
import { maxRunWorkspaces, validateUnitId } from '../unit/domain.js'

export interface WorkspaceRef { readonly id: string; readonly revision: number }
export interface ProjectWorkspace extends WorkspaceRef {
  readonly projectId: string
  readonly name: string
  readonly primary: boolean
  readonly computerAttachmentId: string
  readonly path: string
}
export interface ProjectWorkspaces { readonly revision: number; readonly workspaces: readonly ProjectWorkspace[] }
export interface EditWorkspaces { readonly expectedRevision: number; readonly requestId: string }
export interface AddWorkspace extends EditWorkspaces { readonly name: string; readonly path: string; readonly computerAttachmentId: string }
export interface ProjectWorkspacePort {
  retainWorkspacesIn(tx: StorageTransaction, runId: string, projectId: string, refs: readonly WorkspaceRef[]): void
  releaseWorkspacesIn(tx: StorageTransaction, runId: string): void
  workspacesIn(reader: StorageReader, projectId: string): ProjectWorkspaces
  selectWorkspacesIn(reader: StorageReader, projectId: string, ids: readonly string[], expectedRevision: number): readonly ProjectWorkspace[]
  resolveWorkspacesIn(reader: StorageReader, projectId: string, refs: readonly WorkspaceRef[]): readonly ProjectWorkspace[]
  resolveWorkspaces(projectId: string, refs: readonly WorkspaceRef[]): Promise<readonly ProjectWorkspace[]>
  listProjectWorkspaces(projectId: string): Promise<ProjectWorkspaces>
  addProjectWorkspace(projectId: string, input: AddWorkspace): Promise<ProjectWorkspaces>
  renameProjectWorkspace(projectId: string, id: string, input: EditWorkspaces & { readonly name: string }): Promise<ProjectWorkspaces>
  removeProjectWorkspace(projectId: string, id: string, input: EditWorkspaces): Promise<ProjectWorkspaces>
}

export const projectMembersMigration: StorageMigration = { version: 3, up(tx) {
  tx.execute('ALTER TABLE harness_projects ADD COLUMN workspace_revision INTEGER NOT NULL DEFAULT 1')
  tx.execute(`CREATE TABLE harness_project_workspaces (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES harness_projects(id), name TEXT NOT NULL,
    is_primary INTEGER NOT NULL, attachment_id TEXT NOT NULL, path TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0
  )`)
  tx.execute('CREATE UNIQUE INDEX harness_project_workspace_attachment ON harness_project_workspaces(project_id, attachment_id) WHERE retired = 0')
  tx.execute(`INSERT INTO harness_project_workspaces(id, project_id, name, is_primary, attachment_id, path)
    SELECT id, id, name, 1, computer_attachment_id, path FROM harness_projects`)
  tx.execute(`CREATE TRIGGER harness_project_primary AFTER INSERT ON harness_projects BEGIN
    INSERT INTO harness_project_workspaces(id, project_id, name, is_primary, attachment_id, path)
    VALUES(NEW.id, NEW.id, NEW.name, 1, NEW.computer_attachment_id, NEW.path); END`)
  tx.execute(`CREATE TABLE harness_project_workspace_uses (
    workspace_id TEXT NOT NULL REFERENCES harness_project_workspaces(id), run_id TEXT NOT NULL,
    PRIMARY KEY(workspace_id, run_id)
  )`)
  tx.execute('CREATE INDEX harness_project_workspace_uses_by_run ON harness_project_workspace_uses(run_id)')
  tx.execute(`CREATE TABLE harness_project_workspace_edits (
    request_id TEXT PRIMARY KEY, intent TEXT NOT NULL, result TEXT NOT NULL
  )`)
} }

function failure(code: string, status = 409) { return Object.assign(new Error(code), { code, status }) }
function nameOf(value: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)) throw failure('project-workspace-invalid', 400)
  return value.trim()
}
function configRevision(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) throw failure('project-workspace-invalid', 400)
  return value
}
function workspacesIn(reader: StorageReader, projectId: string): ProjectWorkspaces {
  const row = reader.get('SELECT workspace_revision FROM harness_projects WHERE id = ?', [projectId])
  if (!row) throw failure('project-not-found', 404)
  return { revision: Number(row.workspace_revision), workspaces: reader.all(`SELECT id, name, path, is_primary, attachment_id
    FROM harness_project_workspaces WHERE project_id = ? AND retired = 0 ORDER BY is_primary DESC, rowid`, [projectId]).map(member => ({
      id: String(member.id), projectId, name: String(member.name), primary: member.is_primary === 1,
      computerAttachmentId: String(member.attachment_id), path: String(member.path), revision: 1,
    })) }
}
function members(snapshot: ProjectWorkspaces, ids: readonly string[], includePrimary: boolean) {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw failure('project-workspace-invalid', 400)
  const selected = snapshot.workspaces.filter(member => ids.includes(member.id))
  if (selected.length !== ids.length) throw failure('project-workspace-unavailable')
  const primary = snapshot.workspaces[0]
  if (!primary?.primary) throw failure('project-workspace-unavailable')
  if (!selected.includes(primary)) {
    if (!includePrimary) throw failure('project-workspace-unavailable')
    selected.unshift(primary)
  }
  if (selected.length > maxRunWorkspaces) throw failure('project-workspace-invalid', 400)
  return selected
}
function resolveWorkspacesIn(reader: StorageReader, projectId: string, refs: readonly WorkspaceRef[]) {
  if (!Array.isArray(refs) || refs.some(ref => !ref || !Number.isSafeInteger(ref.revision))) throw failure('project-workspace-invalid', 400)
  const selected = members(workspacesIn(reader, projectId), refs.map(ref => ref.id), false)
  if (refs.some(ref => !selected.some(member => member.id === ref.id && member.revision === ref.revision))) throw failure('project-workspace-unavailable')
  return selected
}
function replay(reader: StorageReader, requestId: string, intent: string): ProjectWorkspaces | undefined {
  const row = reader.get('SELECT intent, result FROM harness_project_workspace_edits WHERE request_id = ?', [requestId])
  if (!row) return undefined
  if (row.intent !== intent) throw failure('project-workspace-request-conflict')
  return JSON.parse(String(row.result)) as ProjectWorkspaces
}

export function createProjectMembership(db: LocalStoragePort, inputs: RuntimeInputs, units: UnitAttachmentsPort | undefined,
  canonicalPath: (path: string, attachmentId: string) => Promise<string>, track: <T>(work: () => Promise<T>) => Promise<T>): ProjectWorkspacePort {
  function update(projectId: string, input: EditWorkspaces, operation: readonly string[],
    write: (tx: StorageTransaction, state: ProjectWorkspaces) => void, prepare?: () => Promise<void>) {
    return track(async () => {
      const requestId = validateUnitId(input.requestId), revision = configRevision(input.expectedRevision)
      const intent = JSON.stringify([projectId, revision, ...operation])
      function inspect(reader: StorageReader) {
        const prior = replay(reader, requestId, intent)
        if (prior) return { prior }
        const state = workspacesIn(reader, projectId)
        if (state.revision !== revision) throw failure('project-workspace-conflict')
        return { state }
      }
      if (prepare) {
        const { prior } = await db.read(inspect)
        if (prior) return prior
        await prepare()
      }
      return db.transaction(tx => {
        const checked = inspect(tx)
        if (checked.prior) return checked.prior
        write(tx, checked.state!)
        tx.execute('UPDATE harness_projects SET workspace_revision = workspace_revision + 1 WHERE id = ?', [projectId])
        const result = workspacesIn(tx, projectId)
        tx.execute('INSERT INTO harness_project_workspace_edits VALUES(?,?,?)', [requestId, intent, JSON.stringify(result)])
        return result
      })
    })
  }
  function member(state: ProjectWorkspaces, id: string) {
    const value = state.workspaces.find(entry => entry.id === id)
    if (!value) throw failure('project-workspace-unavailable')
    return value
  }
  return {
    workspacesIn, resolveWorkspacesIn,
    retainWorkspacesIn(tx, runId, projectId, refs) {
      const selected = resolveWorkspacesIn(tx, projectId, refs)
      for (const value of selected) if (!value.primary) tx.execute(
        'INSERT INTO harness_project_workspace_uses(workspace_id, run_id) VALUES(?,?) ON CONFLICT DO NOTHING', [value.id, runId])
    },
    releaseWorkspacesIn(tx, runId) { tx.execute('DELETE FROM harness_project_workspace_uses WHERE run_id = ?', [runId]) },
    selectWorkspacesIn(reader, projectId, ids, expectedRevision) {
      const snapshot = workspacesIn(reader, projectId)
      if (snapshot.revision !== configRevision(expectedRevision)) throw failure('project-workspace-conflict')
      return members(snapshot, ids, true)
    },
    resolveWorkspaces: (projectId, refs) => track(() => db.read(reader => resolveWorkspacesIn(reader, projectId, refs))),
    listProjectWorkspaces: projectId => track(() => db.read(reader => workspacesIn(reader, projectId))),
    addProjectWorkspace(projectId, input) {
      const name = nameOf(input.name), attachment = validateUnitId(input.computerAttachmentId), path = input.path
      if (typeof path !== 'string') throw failure('project-workspace-invalid', 400)
      let binding: RunUnitBinding, canonical: string
      return update(projectId, input, ['add', attachment, path, name], (tx, state) => {
        if (state.workspaces.some(value => value.computerAttachmentId === attachment)) throw failure('project-workspace-duplicate')
        units!.requireApprovedIn(tx, binding)
        tx.execute(`INSERT INTO harness_project_workspaces(id,project_id,name,is_primary,attachment_id,path)
          VALUES(?,?,?,0,?,?)`, [inputs.newId(), projectId, name, attachment, canonical])
      }, async () => {
        if (!units) throw failure('project-workspace-attachments-unavailable', 503)
        binding = await units.binding(attachment)
        if (binding.unitKind !== 'computer') throw failure('project-workspace-invalid', 400)
        canonical = await canonicalPath(path, attachment)
      })
    },
    renameProjectWorkspace(projectId, id, input) {
      const name = nameOf(input.name)
      return update(projectId, input, ['rename', id, name], (tx, state) => {
        member(state, id)
        tx.execute('UPDATE harness_project_workspaces SET name = ? WHERE id = ?', [name, id])
      })
    },
    removeProjectWorkspace(projectId, id, input) {
      return update(projectId, input, ['remove', id], (tx, state) => {
        if (member(state, id).primary) throw failure('project-workspace-primary')
        if (tx.get('SELECT 1 FROM harness_project_workspace_uses WHERE workspace_id = ? LIMIT 1', [id])) throw failure('project-workspace-in-use')
        tx.execute('UPDATE harness_project_workspaces SET retired = 1 WHERE id = ?', [id])
      })
    },
  }
}

import { createHash, randomUUID } from 'node:crypto'
import type { Component } from '@nya/core'
import { localStorageServiceKey } from '@anybox/storage-sqlite/port'
import type { LocalStoragePort, StorageReader, StorageTransaction } from '@anybox/storage-sqlite/port'
import { checkedId, checkedTools, environmentError, environmentToolKey, exactGrantKey, validateEnvironmentGrants } from './contracts.js'
import type { AgentGrants, EnvironmentTool, EnvironmentGrant, GrantChange, SetGrantsInput } from './contracts.js'
import { assertOwner, changeState, hasUnknown, markExited, migrations, readGrants, rememberAffected, writeGrants } from './storage.js'

export * from './contracts.js'

export interface EnvironmentWork<T> {
  readonly result: Promise<T>
  /** Resolves only after all resources covered by this admission have exited. Reject on unknown exit. */
  readonly done: Promise<void>
}

export interface ExecutionEnvironmentManager {
  get(agentId: string): Promise<AgentGrants>
  readIn(reader: StorageReader, agentId: string): AgentGrants
  seedIn(tx: StorageTransaction, agentId: string, tools: readonly EnvironmentTool[]): AgentGrants
  set(input: SetGrantsInput): Promise<GrantChange>
  observe(requestId: string): Promise<GrantChange | undefined>
  pendingChanges(agentId: string): Promise<readonly GrantChange[]>
  run<T>(agentId: string, required: readonly EnvironmentGrant[], operationId: string, start: (signal: AbortSignal) => EnvironmentWork<T>, signal?: AbortSignal): Promise<T>
  /** Models' actual outbound send. The trusted adapter validates all exposed functions and hosted tools before using this entry. */
  runModel<T>(agentId: string, required: readonly EnvironmentGrant[], operationId: string, send: (signal: AbortSignal) => EnvironmentWork<T>, signal?: AbortSignal): Promise<T>
  /** The resource-owning scope of a Run. Its stable identity can later be reattached by resumeScope. */
  runScope<T>(agentId: string, required: readonly EnvironmentGrant[], operationId: string, start: (signal: AbortSignal) => EnvironmentWork<T>, signal?: AbortSignal): Promise<T>
  /** Reattach cancellation and exit observation to a previous owner's exact Run scope. Never dispatch a tool through this callback. */
  resumeScope<T>(agentId: string, required: readonly EnvironmentGrant[], operationId: string, attach: (signal: AbortSignal) => EnvironmentWork<T>, signal?: AbortSignal): Promise<T>
  /** Trusted provider reconciliation only. A missing operation or interrupted observation is not proof of exit. */
  reconcile(agentId: string, operationId: string, proveExit: (grants: readonly EnvironmentGrant[], signal: AbortSignal) => Promise<boolean>): Promise<boolean>
}

interface ActiveWork {
  agentId: string
  keys: ReadonlySet<string>
  controller: AbortController
  exit: Promise<void>
}

const owners = new WeakSet<LocalStoragePort>()

export async function openExecutionEnvironmentManager(db: LocalStoragePort): Promise<ExecutionEnvironmentManager & { close(): Promise<void> }> {
  if (owners.has(db)) throw environmentError('environment-owner-active', 409)
  owners.add(db)
  const owner = randomUUID()
  try {
    // Previous executables reject layout 2 before consuming any migrated grants.
    if (!db.requireLayout) throw environmentError('environment-layout-unsupported', 503)
    await db.requireLayout(2)
    await db.migrate('execution-environments', migrations)
    await db.transaction(tx => {
      tx.execute('INSERT INTO environment_authority VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET owner=excluded.owner', [owner])
      // "reserved" precedes our durable send point. "sent" may already have crossed the process boundary.
      tx.execute("DELETE FROM environment_admission_tools WHERE (agent_id,operation_id) IN (SELECT agent_id,operation_id FROM environment_admissions WHERE state='reserved')")
      tx.execute("UPDATE environment_admissions SET state='exited' WHERE state='reserved'")
      tx.execute("UPDATE environment_admissions SET state='unknown' WHERE state='sent'")
    })
  } catch (error) {
    owners.delete(db)
    throw error
  }

  let accepting = true
  let tail = Promise.resolve()
  let closing: Promise<void> | undefined
  const active = new Set<ActiveWork>()
  const unconfirmed = new Set<string>()
  const failedWrites = new Map<string,string>()
  const closingSignal = new AbortController()
  const proofs = new Set<Promise<boolean>>()
  let persistenceFailure: unknown
  const mustBeOpen = () => {
    if (!accepting || persistenceFailure) throw environmentError('environment-unavailable', 503)
  }
  const queue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(() => { mustBeOpen(); return work() })
    tail = result.then(() => {}, () => {})
    return result
  }
  const get = (agent: string) => {
    mustBeOpen()
    const agentId = checkedId(agent)
    return db.read(reader => { assertOwner(reader, owner); return readGrants(reader, agentId) })
  }
  const readIn = (reader: StorageReader, agent: string): AgentGrants => {
    mustBeOpen()
    assertOwner(reader, owner)
    const agentId = checkedId(agent)
    if (failedWrites.has(agentId)) throw environmentError('environment-authority-unavailable', 503)
    return readGrants(reader, agentId)
  }
  const seedIn = (tx: StorageTransaction, agentId: string, tools: readonly EnvironmentTool[]): AgentGrants => {
    const previous = readIn(tx, agentId)
    if (previous.revision) return previous
    const seeded = { agentId, revision: 1, grants: checkedTools(tools).map(tool => ({ tool, generation: 1, source: 'trusted-configuration' as const })) }
    writeGrants(tx, seeded)
    return seeded
  }
  const observe = (request: string): Promise<GrantChange | undefined> => {
    mustBeOpen()
    const requestId = checkedId(request)
    return db.read(reader => { assertOwner(reader, owner); return changeState(reader, requestId) })
  }
  const pendingChanges = (agent: string): Promise<readonly GrantChange[]> => {
    mustBeOpen()
    const agentId = checkedId(agent)
    return db.read(reader => {
      assertOwner(reader, owner)
      const rows = reader.all(`SELECT DISTINCT c.request_id,c.revision FROM environment_grant_changes c
        JOIN environment_change_operations affected ON affected.request_id=c.request_id
        LEFT JOIN environment_admissions a ON a.agent_id=c.agent_id AND a.operation_id=affected.operation_id
        WHERE c.agent_id=? AND (a.state IS NULL OR a.state<>'exited') ORDER BY c.revision`, [agentId])
      return rows.map(row => changeState(reader, String(row.request_id))!)
    })
  }
  const abortGrants = (agentId: string, keys?: ReadonlySet<string>) => {
    for (const work of active) {
      if (work.agentId === agentId && (!keys || [...work.keys].some(key => keys.has(key)))) {
        work.controller.abort(environmentError('environment-authorization-changed', 409))
      }
    }
  }
  const set = async (input: SetGrantsInput): Promise<GrantChange> => {
    const agentId = checkedId(input.agentId), requestId = checkedId(input.requestId)
    const expectedRevision = input.expectedRevision
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) throw environmentError('invalid-environment-input', 400)
    const tools = checkedTools(input.tools)
    const digest = createHash('sha256').update(JSON.stringify([agentId,expectedRevision,tools])).digest('hex')
    return queue(async () => {
      const retry = JSON.stringify([requestId, digest])
      const failed = failedWrites.get(agentId)
      if (failed && failed !== retry) throw environmentError('environment-authority-unavailable', 503)
      let removed: Set<string> | undefined
      try {
        const status = await db.transaction(tx => {
          assertOwner(tx, owner)
          const prior = tx.get('SELECT digest FROM environment_grant_changes WHERE request_id=?', [requestId])
          if (prior) {
            if (prior.digest !== digest) throw environmentError('environment-request-conflict', 409)
            return changeState(tx, requestId)!
          }
          const previous = readGrants(tx, agentId)
          if (previous.revision !== expectedRevision) throw environmentError('environment-revision-conflict', 409)
          const revision = expectedRevision + 1
          const known = new Map(previous.grants.map(grant => [environmentToolKey(grant.tool),grant]))
          const grants = tools.map(tool => {
            const key = environmentToolKey(tool)
            const existing = known.get(key)
            known.delete(key)
            if (existing) return existing
            if (tx.get('SELECT 1 FROM environment_admission_tools WHERE agent_id=? AND tool_key=? LIMIT 1', [agentId,key])) throw environmentError('environment-cleanup-pending', 409)
            return { tool, generation: revision, source: 'operator' as const }
          })
          removed = new Set(known.keys())
          writeGrants(tx, { agentId, revision, grants })
          tx.execute('INSERT INTO environment_grant_changes VALUES(?,?,?,?)', [requestId, agentId, digest, revision])
          for (const grant of known.values()) rememberAffected(tx, requestId, agentId, grant)
          return changeState(tx, requestId)!
        })
        if (removed?.size) abortGrants(agentId, removed)
        failedWrites.delete(agentId)
        return status
      } catch (error) {
        // Validation and CAS errors occur before any authority write. A failed write cannot reopen admission.
        if (removed?.size || (error as {name?:string}).name === 'LocalStorageError') {
          failedWrites.set(agentId, retry)
          abortGrants(agentId)
        }
        throw error
      }
    })
  }

  const admit = async <T>(kind: 'provider' | 'model' | 'scope' | 'resume-scope', agent: string, required: readonly EnvironmentGrant[], operation: string,
    start: (signal: AbortSignal) => EnvironmentWork<T>, signal?: AbortSignal): Promise<T> => {
    const agentId = checkedId(agent), operationId = checkedId(operation, 1024)
    const resuming = kind === 'resume-scope'
    if (resuming || kind === 'scope') {
      let identity: unknown
      try { identity = JSON.parse(operationId) } catch { /* rejected below */ }
      if (!Array.isArray(identity) || identity.length !== 2 || typeof identity[0] !== 'string' ||
        !identity[0].length || identity[1] !== 'scope' || JSON.stringify(identity) !== operationId) throw environmentError('environment-invalid-scope', 409)
    }
    const grants = validateEnvironmentGrants(required)
    const launched = await queue(async () => {
      signal?.throwIfAborted()
      await db.transaction(tx => {
        const view = readIn(tx, agentId)
        const allowed = new Set(view.grants.map(exactGrantKey))
        if (grants.some(grant => !allowed.has(exactGrantKey(grant)))) throw environmentError('environment-authorization-changed', 409)
        const prior = tx.get('SELECT owner,state,resource_kind FROM environment_admissions WHERE agent_id=? AND operation_id=?', [agentId,operationId])
        if (resuming) {
          if (!prior) throw environmentError('environment-no-original-scope', 409)
          if (prior.resource_kind !== 'run-scope' || prior.state !== 'unknown' || prior.owner === owner) throw environmentError('environment-scope-unavailable', 409)
          const original = tx.all('SELECT tool_key,generation FROM environment_admission_tools WHERE agent_id=? AND operation_id=?', [agentId,operationId])
          const pinned = new Set(grants.map(grant => JSON.stringify([environmentToolKey(grant.tool),grant.generation])))
          if (original.length !== grants.length || original.some(row => !pinned.has(JSON.stringify([row.tool_key,row.generation])))) throw environmentError('environment-authorization-changed', 409)
          // Original work can already exist. Even a crash before reattachment must preserve that uncertainty.
          tx.execute("UPDATE environment_admissions SET state='sent', owner=? WHERE agent_id=? AND operation_id=?", [owner,agentId,operationId])
          return
        }
        if (prior) throw environmentError('environment-operation-already-admitted', 409)
        for (const grant of grants) {
          if (hasUnknown(tx, agentId, environmentToolKey(grant.tool))) throw environmentError('environment-exit-unknown', 409)
        }
        const transport = kind === 'model' && !grants.some(grant => grant.tool.environmentId === 'model-search')
        const resource = kind === 'scope' ? 'run-scope' : transport ? 'model-transport' : 'provider'
        tx.execute(`INSERT INTO environment_admissions(agent_id,operation_id,owner,state,resource_kind)
          VALUES(?,?,?,'reserved',?)`, [agentId,operationId,owner,resource])
        for (const grant of grants) tx.execute('INSERT INTO environment_admission_tools VALUES(?,?,?,?)',
          [agentId,operationId,environmentToolKey(grant.tool),grant.generation])
      })
      let entered = false
      const controller = new AbortController()
      const signals = [controller.signal,closingSignal.signal]
      if (signal) signals.push(signal)
      const combined = AbortSignal.any(signals)
      try {
        mustBeOpen()
        combined.throwIfAborted()
        if (!resuming) await db.transaction(tx => {
          assertOwner(tx, owner)
          const { changes } = tx.execute("UPDATE environment_admissions SET state='sent' WHERE agent_id=? AND operation_id=? AND owner=? AND state='reserved'", [agentId,operationId,owner])
          if (changes !== 1) throw environmentError('environment-owner-changed', 503)
        })
        mustBeOpen()
        combined.throwIfAborted()
        // No suspension between the last fence check and obtaining the actual provider handle.
        entered = true
        const handle = start(combined)
        const item: ActiveWork = { agentId, controller, keys: new Set(grants.map(grant => environmentToolKey(grant.tool))), exit: Promise.resolve() }
        active.add(item)
        const finalize = (exited: boolean) => {
          if (!exited) unconfirmed.add(JSON.stringify([agentId,operationId]))
          return db.transaction(tx => markExited(tx, agentId, operationId, owner, exited))
            .catch(error => { persistenceFailure = error; for (const pending of active) pending.controller.abort(error); throw error })
        }
        item.exit = Promise.resolve(handle.done).then(() => finalize(true), async cause => { await finalize(false); throw cause })
          .finally(() => active.delete(item))
        // Keep a delayed result separate from the proof that this admission no longer owns resources.
        const business = Promise.resolve(handle.result)
        void business.catch(() => {})
        // A failed exit is definitive even if the provider will never publish a business result.
        const result = item.exit.then(() => business)
        void result.catch(() => {})
        return { result }
      } catch (error) {
        if (entered || resuming) unconfirmed.add(JSON.stringify([agentId,operationId]))
        await db.transaction(tx => markExited(tx, agentId, operationId, owner, !entered && !resuming))
        throw error
      }
    })
    return launched.result
  }
  const run: ExecutionEnvironmentManager['run'] = (...args) => admit('provider', ...args)
  const runModel: ExecutionEnvironmentManager['runModel'] = (...args) => admit('model', ...args)
  const runScope: ExecutionEnvironmentManager['runScope'] = (...args) => admit('scope', ...args)
  const resumeScope: ExecutionEnvironmentManager['resumeScope'] = (...args) => admit('resume-scope', ...args)

  const reconcileOriginal = async (agent: string, operation: string, proveExit: (grants: readonly EnvironmentGrant[], signal: AbortSignal) => Promise<boolean>): Promise<boolean> => {
    const agentId = checkedId(agent), operationId = checkedId(operation, 1024)
    const original = await db.read(reader => {
      mustBeOpen()
      assertOwner(reader, owner)
      const row = reader.get('SELECT state,owner FROM environment_admissions WHERE agent_id=? AND operation_id=?', [agentId,operationId])
      if (row?.state === 'exited') return true
      if (row?.state !== 'unknown') return false
      const rows = reader.all(`SELECT u.tool_key,u.generation,
        EXISTS(SELECT 1 FROM environment_grant_changes c WHERE c.agent_id=u.agent_id AND c.revision=u.generation) AS issued
        FROM environment_admission_tools u WHERE u.agent_id=? AND u.operation_id=? ORDER BY u.tool_key`, [agentId,operationId])
      const grants = validateEnvironmentGrants(rows.map(row => {
        const [environmentId,targetId,toolId,version] = JSON.parse(String(row.tool_key))
        return { tool: { environmentId,targetId,toolId,version }, generation: Number(row.generation), source: row.issued ? 'operator' : 'trusted-configuration' }
      }))
      return { owner: row.owner, grants }
    })
    if (typeof original === 'boolean') return original
    closingSignal.signal.throwIfAborted()
    if (!await proveExit(original.grants, closingSignal.signal)) return false
    return queue(async () => {
      const exited = await db.transaction(tx => {
        assertOwner(tx, owner)
        const row = tx.get('SELECT state,owner FROM environment_admissions WHERE agent_id=? AND operation_id=?', [agentId,operationId])
        if (row?.state === 'exited') return true
        if (row?.state !== 'unknown' || row.owner !== original.owner) return false
        markExited(tx, agentId, operationId, owner, true)
        return true
      })
      if (exited) unconfirmed.delete(JSON.stringify([agentId,operationId]))
      return exited
    })
  }

  const reconcile: ExecutionEnvironmentManager['reconcile'] = (agent, operation, proveExit) => {
    const proof = reconcileOriginal(agent, operation, proveExit)
    proofs.add(proof)
    void proof.finally(() => proofs.delete(proof)).catch(() => {})
    return proof
  }

  const close = () => {
    if (closing) return closing
    accepting = false
    closingSignal.abort()
    for (const item of active) item.controller.abort(environmentError('environment-unavailable', 503))
    closing = (async () => {
      await tail
      await Promise.allSettled([...proofs])
      const exits = await Promise.allSettled([...active].map(item => item.exit))
      owners.delete(db)
      if (persistenceFailure) throw persistenceFailure
      const failed = exits.find(exit => exit.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      if (unconfirmed.size) throw environmentError('environment-exit-unknown', 503)
    })()
    return closing
  }
  return { get, readIn, seedIn, set, observe, pendingChanges, run, runModel, runScope, resumeScope, reconcile, close }
}

export function createExecutionEnvironmentComponent(options: {serviceKey: string}): Component.Object<void, { [localStorageServiceKey]: LocalStoragePort }> {
  const key = checkedId(options.serviceKey)
  return { name: key, inject: [localStorageServiceKey], async apply(ctx, _config, deps) {
    const service = await openExecutionEnvironmentManager(deps[localStorageServiceKey])
    ctx.effect(() => () => service.close(), 'cancel and join environment admissions')
    ctx.provide(key, service)
  } }
}

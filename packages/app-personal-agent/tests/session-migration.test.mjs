import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite/sqlite'
import { openSqliteSessionRecords } from '../dist/core/session/sqlite-records.js'

const localV15 = { version: 15, up(tx) {
  tx.execute(`CREATE INDEX harness_runs_head_attempts ON harness_runs(session_id, parent_node_id)
    WHERE project_id IS NOT NULL AND status != 'completed'`)
} }

const localV20 = { version: 20, up(tx) {
  tx.execute(`CREATE INDEX IF NOT EXISTS harness_runs_head_attempts ON harness_runs(session_id, parent_node_id)
    WHERE project_id IS NOT NULL AND status != 'completed'`)
  tx.execute(`CREATE TABLE harness_history_subchains (
    seq INTEGER PRIMARY KEY REFERENCES harness_nodes(seq), session_id TEXT NOT NULL REFERENCES harness_sessions(id),
    id TEXT NOT NULL, anchor_node_id TEXT REFERENCES harness_nodes(id)
  )`)
  tx.execute('CREATE INDEX harness_history_subchains_session ON harness_history_subchains(session_id, seq)')
  const recordBoundaries = `INSERT INTO harness_history_subchains(seq, session_id, id, anchor_node_id)
    SELECT n.seq, n.session_id, COALESCE(current.root_id, n.id), n.parent_id
    FROM harness_nodes n JOIN harness_sessions s ON s.id = n.session_id AND s.continuous = 1
    JOIN harness_runs r ON r.id = n.source_run_id
    LEFT JOIN harness_continuous_run_contexts current ON current.run_id = n.source_run_id
    LEFT JOIN harness_nodes p ON p.id = n.parent_id
    LEFT JOIN harness_continuous_run_contexts previous ON previous.run_id = p.source_run_id
    WHERE (n.parent_id IS NULL OR current.root_id IS NOT previous.root_id OR r.application_prefix = 1)`
  tx.execute(recordBoundaries)
  tx.execute(`CREATE TRIGGER harness_nodes_history_subchain AFTER INSERT ON harness_nodes
    BEGIN ${recordBoundaries} AND n.seq = NEW.seq; END`)
} }

const protocolId = 'chat-completions'
const initialization = JSON.stringify({ schemaVersion: 1, prompts: [], tools: [], toolContractVersion: 'known-tools-v1' })
const binding = JSON.stringify({ protocolId, generationId: 'driver', driverVersion: '1', loopVersion: '1', recordFormatVersion: 2, viewSchemaVersion: 2 })
const model = JSON.stringify({ schemaVersion: 3, modelId: 'model', providerId: 'provider', modelRevision: 1, providerRevision: 1,
  modelDefinitionId: 'definition', providerDefinitionId: 'provider-definition', modelDefinitionVersionId: 'definition-v1',
  modelVersionId: 'model-v1', providerVersionId: 'provider-v1', remoteModelId: 'remote', protocolId, protocolVersion: '1',
  registrationGenerationId: 'driver', historyScopeEpoch: 'epoch', parameters: { protocolId, formatVersion: 1, value: {} } })

function seedHistory(tx, version, local) {
  tx.execute('CREATE TABLE harness_projects (id TEXT PRIMARY KEY)')
  tx.execute("INSERT INTO harness_projects VALUES ('project')")
  tx.execute(`INSERT INTO harness_sessions(id, project_id, agent_id, created_at, history_mode, protocol_id, continuous)
    VALUES ('session', 'project', 'agent', '0', 'native-local-v1', ?, 1)`, [protocolId])
  tx.execute(`INSERT INTO harness_native_initializations(id, session_id, protocol_id, payload_json)
    VALUES ('initial', 'session', ?, ?)`, [protocolId, initialization])
  if (version === 15) tx.execute(`INSERT INTO harness_continuous_roots(id, session_id, cutoff_seq, evicted_node_ids_json)
    VALUES ('root', 'session', 0, '[]')`)
  for (const index of [1, 2]) {
    const run = 'run-' + index, node = 'node-' + index, context = 'context-' + index
    const parent = index === 1 ? null : 'node-1'
    const parentContext = index === 1 || local ? null : 'context-1'
    const input = 'Question ' + index, output = 'Answer ' + index
    // Before v17 initialization was stored on each legacy context. The local v15 trigger
    // also required continuous Runs to omit parent_context_ref even when extending a node.
    const extraColumns = version >= 17 ? ', continuous_initialization_json' : ''
    const prefixColumn = version === 20 ? ', application_prefix' : ''
    tx.execute(`INSERT INTO harness_runs(id, session_id, project_id, idempotency_key, history_kind, context_version,
      initialization_id, parent_context_ref, parent_node_id, created_at, updated_at, prompts_json, model_id,
      model_snapshot_json, binding_json, native_input_json, input, output, status${extraColumns}${prefixColumn})
      VALUES (?, 'session', 'project', ?, 'tree', 'native-local-v1', 'initial', ?, ?, '0', '0', '[]', 'model',
        ?, ?, ?, ?, ?, 'completed'${version >= 17 ? ', ?' : ''}${version === 20 ? ', ?' : ''})`, [run, run, parentContext, parent, model, binding,
      JSON.stringify({ schemaVersion: 1, text: input, raw: input, template: null }), input, output,
      ...(version >= 17 ? [initialization] : []), ...(version === 20 ? [index === 2 ? 1 : 0] : [])])
    if (version === 15) {
      const rollover = local && parent !== null
      const rootId = rollover ? 'next-root' : 'root'
      if (rollover) tx.execute(`INSERT INTO harness_continuous_roots(id, session_id, parent_id, anchor_node_id, cutoff_seq, evicted_node_ids_json)
        SELECT ?, session_id, 'root', id, seq, ? FROM harness_nodes WHERE id = ?`, [rootId, JSON.stringify([parent]), parent])
      tx.execute(`INSERT INTO harness_continuous_run_contexts(run_id, root_id, initialization_json, selection_json)
        VALUES (?, ?, ?, ?)`, [run, rootId, initialization, JSON.stringify({ rootId, recentNodeIds: parent && !rollover ? [parent] : [], memoryNodeIds: [] })])
    }
    tx.execute(`INSERT INTO harness_native_contexts(id, session_id, run_id, protocol_id, parent_ref, initialization_id, checkpoint_json)
      VALUES (?, 'session', ?, ?, ?, 'initial', '{}')`, [context, run, protocolId, parentContext])
    tx.execute(`INSERT INTO harness_nodes(id, session_id, parent_id, source_run_id, input, output, context_ref)
      VALUES (?, 'session', ?, ?, ?, ?, ?)`, [node, parent, run, input, output, context])
    tx.execute('UPDATE harness_runs SET result_node_id = ? WHERE id = ?', [node, run])
  }
}

const agentPreferences = { environmentIds: ['computer', 'mcp'], toolIdsByEnvironment: { computer: ['read'] } }
const sessionEnvironments = { environmentIds: ['mcp'], toolIdsByTarget: { '["mcp","fixture"]': ['lookup'] } }
const runAccess = { agentId: 'agent', functions: [{ name: 'lookup', grant: {
  tool: { environmentId: 'mcp', targetId: 'fixture-target', toolId: 'lookup', version: '1' }, generation: 5, source: 'operator',
} }] }

const cases = [['local', 15], ['upstream', 15], ['upstream', 17], ['upstream', 18], ['local', 20], ['upstream', 20]]
for (const [source, version] of cases) {
  test(`Personal Agent opens historical ${source} v${version} and pages through its original turns`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'anybox-session-upgrade-'))
    const root = new Context()
    t.after(async () => { try { await root.fiber.dispose() } finally { await rm(directory, { recursive: true, force: true }) } })
    await root.installComponent(createLocalSqliteComponent(join(directory, 'db.sqlite')))
    const db = root.get('local-storage'), local = source === 'local'
    // Use the actual migrations through that release. The local v15 release shipped
    // an index in place of the upstream v15 trigger change.
    const openHistoricalRecords = maximum => openSqliteSessionRecords({ ...db, migrate(domain, migrations) {
      return db.migrate(domain, migrations.filter(item => item.version <= maximum).map(item => {
        if (local && item.version === 15) return localV15
        if (local && item.version === 20) return localV20
        return item
      }))
    } })
    // The local database carried two context roots forward when it first materialized subchains.
    const seedVersion = local ? 15 : version
    await openHistoricalRecords(seedVersion)
    await db.transaction(tx => seedHistory(tx, seedVersion, local))
    if (local && version === 20) {
      await openHistoricalRecords(version)
      assert.equal(await db.read(tx => tx.get("SELECT 1 FROM sqlite_schema WHERE name = 'harness_environment_preferences'")), undefined)
      const boundaries = await db.read(tx => tx.all('SELECT id FROM harness_history_subchains ORDER BY seq'))
      assert.deepEqual(boundaries.map(row => row.id), ['root', 'next-root'])
    }
    if (!local && version === 20) {
      assert.equal(await db.read(tx => tx.get("SELECT 1 FROM sqlite_schema WHERE name = 'harness_history_subchains'")), undefined)
      await db.transaction(tx => {
        tx.execute('INSERT INTO harness_environment_preferences VALUES (?, ?, ?)', ['agent', 4, JSON.stringify(agentPreferences)])
        tx.execute('INSERT INTO harness_session_environments VALUES (?, ?, ?)', ['session', 2, JSON.stringify(sessionEnvironments)])
        tx.execute('INSERT INTO harness_run_environment_access VALUES (?, ?, 1, 2, 7)', ['run-2', JSON.stringify(runAccess)])
      })
    }
    assert.equal((await db.read(tx => tx.get("SELECT version FROM schema_migrations WHERE domain = 'run-state'"))).version, version)
    const records = await openSqliteSessionRecords(db)
    assert.equal((await db.read(tx => tx.get("SELECT version FROM schema_migrations WHERE domain = 'run-state'"))).version, 21)
    const newest = await records.getContinuousHistory('session', undefined, 1)
    const earlier = await records.getContinuousHistory('session', newest.nextCursor, 1)
    const chain = seedVersion === 15 ? 'root' : 'node-1'
    const nextChain = local ? 'next-root' : version === 20 ? 'node-2' : chain
    assert.equal(newest.headNodeId, 'node-2')
    assert.deepEqual([earlier.nodes[0].id, newest.nodes[0].id], ['node-1', 'node-2'])
    assert.equal(earlier.nextCursor, undefined)
    const firstChain = { id: chain, parentId: null, anchorNodeId: null }
    assert.deepEqual(earlier.subchains, [firstChain])
    assert.equal(earlier.nodes[0].subchainId, chain)
    assert.deepEqual(newest.subchains, [nextChain === chain ? firstChain : { id: nextChain, parentId: chain, anchorNodeId: 'node-1' }])
    assert.equal(newest.nodes[0].subchainId, nextChain)
    for (const page of [earlier, newest]) {
      assert.equal(page.runs[0].resultNodeId, page.nodes[0].id)
      assert.equal(page.runs[0].estimatedInputTokens, undefined)
    }
    assert.equal((await records.getRunByKey('session', 'run-2')).output, 'Answer 2')
    assert.ok(await db.read(tx => tx.get("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'harness_runs_head_attempts'")))
    if (version === 20 && local) {
      assert.deepEqual(await records.getAgentEnvironmentSelection('agent', ['computer']), { version: 0, environmentIds: ['computer'] })
      assert.deepEqual(await records.readSessionEnvironments('session'), { version: 0, environmentIds: ['computer'] })
      assert.equal(await records.getRunEnvironmentAccess('run-2'), undefined)
    }
    if (version === 20 && !local) {
      assert.deepEqual(await records.getAgentEnvironmentSelection('agent', []), { ...agentPreferences, version: 4 })
      assert.deepEqual(await records.readSessionEnvironments('session'), { ...sessionEnvironments, version: 2 })
      assert.deepEqual(await records.getRunEnvironmentAccess('run-2'), runAccess)
      const access = await db.read(tx => tx.get("SELECT format_version, selection_version, grant_revision FROM harness_run_environment_access WHERE run_id = 'run-2'"))
      assert.deepEqual({ ...access }, { format_version: 1, selection_version: 2, grant_revision: 7 })
    }
  })
}

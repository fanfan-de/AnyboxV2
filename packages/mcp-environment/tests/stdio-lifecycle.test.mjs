import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { processRuntimeAvailable } from '@anybox/computer-tools/platform/process-runtime'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite/sqlite'
import { normalizeTools } from '../dist/contracts.js'
import { createMcpEnvironmentComponent } from '../dist/index.js'
import { migrations } from '../dist/storage.js'

const search = { name: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }
const server = `
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const [log] = process.argv.slice(2)
appendFileSync(log, 'spawn\\n')
const tools = [${JSON.stringify(search)}]
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  if (!request.id) continue
  const result = request.method === 'initialize'
    ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } }
    : request.method === 'tools/list' ? { tools } : { content: [{ type: 'text', text: request.params.arguments.query }] }
  appendFileSync(log, request.method + '\\n')
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n')
}
`

async function open(path, { installMcp = true, fetch } = {}) {
  const root = new Context()
  try {
    await root.installComponent(createLocalSqliteComponent(path))
    const storage = root.get('local-storage')
    const serviceKey = 'test.mcp-environment'
    if (installMcp) await root.installComponent(createMcpEnvironmentComponent({ serviceKey, timeoutMs: 5000, fetch }))
    return { storage, mcp: root.get(serviceKey), close: () => root.fiber.dispose() }
  } catch (error) { await root.fiber.dispose(); throw error }
}

test('an unacknowledged stdio process lease survives owner restart and connection replacement without blocking other launches', {
  skip: !processRuntimeAvailable(),
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-mcp-stdio-owner-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const path = join(directory, 'execution.sqlite'), script = join(directory, 'mcp.mjs')
  const lostLog = join(directory, 'lost.log'), otherLog = join(directory, 'other.log')
  const config = log => ({ name: 'Local docs', transport: 'stdio', command: process.execPath, args: [script, log], cwd: directory })
  await writeFile(script, server)

  let lost
  const first = await open(path)
  const launchId = randomUUID()
  try {
    lost = await first.mcp.createConnection(config(lostLog))
    // Emulate a dead owner after it registered a launch, with no trustworthy exit receipt.
    await first.storage.transaction(tx => {
      const key = tx.get('SELECT endpoint FROM mcp_connections WHERE id=?', [lost.id]).endpoint
      tx.execute("INSERT INTO mcp_stdio_processes VALUES (?,?,'owned')", [launchId, key])
    })
  } finally { await first.close() }

  const restarted = await open(path)
  const { mcp } = restarted
  try {
    await restarted.storage.read(reader => {
      assert.equal(reader.get('SELECT state FROM mcp_stdio_processes WHERE launch_id=?', [launchId]).state, 'unknown')
    })
    let result = await mcp.refreshConnection(lost.id)
    assert.equal(result.status, 'unavailable')
    assert.equal(result.error, 'mcp-exit-unknown')
    assert.deepEqual(mcp.targets(), [])
    await mcp.disableConnection(lost.id)
    const substitute = await mcp.createConnection({ ...config(lostLog), name: 'Recreated local docs' })
    assert.notEqual(substitute.targetId, lost.targetId)
    result = await mcp.refreshConnection(substitute.id)
    assert.equal(result.status, 'unavailable')
    assert.equal(result.error, 'mcp-exit-unknown')
    await assert.rejects(readFile(lostLog), { code: 'ENOENT' })

    const other = await mcp.createConnection(config(otherLog))
    assert.equal((await mcp.refreshConnection(other.id)).status, 'ready')
    const [target] = mcp.targets()
    assert.deepEqual(mcp.targets().map(value => value.targetId), [other.targetId])
    const [tool] = target.tools
    const scope = mcp.openTargetScope(target.targetId, { scopeId: 'other-run', ownerEpoch: 1, signal: new AbortController().signal })
    const call = scope.execute({ operationId: 'search-other', toolId: tool.toolId, version: tool.version,
      arguments: { query: 'other docs' }, resuming: false })
    assert.deepEqual((await call.result).result, { content: [{ type: 'text', text: 'other docs' }] })
    await call.done
    await scope.close().done
    assert.match(await readFile(otherLog, 'utf8'), /tools\/call/)
    await restarted.storage.read(reader => {
      assert.deepEqual(reader.all('SELECT launch_id, state FROM mcp_stdio_processes').map(row => [row.launch_id, row.state]),
        [[launchId, 'unknown']])
    })
  } finally { await restarted.close() }
})

test('v1 HTTP connection identity and declarations are readable and usable after the stdio storage migration', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-mcp-v1-connection-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const path = join(directory, 'execution.sqlite')
  const old = { id: randomUUID(), name: 'Saved HTTP', endpoint: 'https://fixture.invalid/mcp' }
  const tools = normalizeTools(old, [search])
  const first = await open(path, { installMcp: false })
  try {
    await first.storage.migrate('mcp-environment', migrations.slice(0, 1))
    await first.storage.transaction(tx => {
      tx.execute("INSERT INTO mcp_connections VALUES (?,?,?,1,'ready',?,NULL)", [old.id, old.name, old.endpoint, JSON.stringify(tools)])
    })
  } finally { await first.close() }

  const requests = []
  const upgraded = await open(path, {
    async fetch(endpoint, options) {
      assert.equal(endpoint, old.endpoint)
      const request = JSON.parse(options.body)
      requests.push(request.method)
      if (request.method === 'notifications/initialized') return new Response(null, { status: 202 })
      const result = request.method === 'initialize'
        ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : { tools: [search] }
      return Response.json({ jsonrpc: '2.0', id: request.id, result })
    },
  })
  try {
    const [connection] = upgraded.mcp.connections()
    assert.deepEqual(connection, { ...old, transport: 'http', targetId: `${old.id}@1`, status: 'unverified', toolCount: 1 })
    assert.deepEqual(requests, [])
    const refreshed = await upgraded.mcp.refreshConnection(old.id)
    assert.equal(refreshed.targetId, connection.targetId)
    assert.equal(refreshed.status, 'ready')
    const [target] = upgraded.mcp.targets()
    const { nativeName, ...descriptor } = tools[0]
    assert.equal(nativeName, 'search')
    assert.deepEqual(target.tools, [descriptor])
    assert.deepEqual(requests, ['initialize', 'notifications/initialized', 'tools/list'])
  } finally { await upgraded.close() }
})

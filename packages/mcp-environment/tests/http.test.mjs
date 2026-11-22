import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite/sqlite'
import { createMcpEnvironmentComponent } from '../dist/index.js'

async function fixture(t, label, { stream = false, interrupt = false, held = false } = {}) {
  const received = [], errors = []
  let description = 'Search documents'
  const session = `fixture-${label}`
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'DELETE') { response.writeHead(200).end(); return }
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      received.push(message)
      if (message.method !== 'initialize') {
        assert.equal(request.headers['mcp-session-id'], session)
        assert.equal(request.headers['mcp-protocol-version'], '2025-11-25')
      }
      if (message.method.startsWith('notifications/')) { response.writeHead(202).end(); return }
      let result
      if (message.method === 'initialize') {
        response.setHeader('mcp-session-id', session)
        result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: label, version: '1' } }
      } else if (message.method === 'tools/list') {
        result = message.params.cursor ? { tools: [{ name: 'search', description,
          inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } }] }
          : { tools: [], nextCursor: 'second' }
      } else if (message.method === 'tools/call') {
        assert.equal(message.params.name, 'search')
        server.emit('tool-request', message)
        if (held) return
        if (interrupt) { response.destroy(); return }
        result = { content: [{ type: 'text', text: `${label} found ${message.params.arguments.query}` }] }
      } else assert.fail(`Unexpected ${message.method}`)
      const reply = JSON.stringify({ jsonrpc: '2.0', id: message.id, result })
      if (stream && message.method !== 'initialize') {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('data: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\n')
        response.write('data: ')
        response.end(`${reply}\r\n\r\n`)
      } else response.writeHead(200, { 'content-type': 'application/json' }).end(reply)
    } catch (error) {
      errors.push(error)
      response.writeHead(500).end()
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    assert.deepEqual(errors, [])
  })
  return { endpoint: `http://127.0.0.1:${server.address().port}/mcp`, received,
    nextCall: () => once(server, 'tool-request').then(([message]) => message),
    toolCalls: () => received.filter(item => item.method === 'tools/call'),
    setDescription(value) { description = value } }
}

async function dbPath(t) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-mcp-environment-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  return join(directory, 'execution.sqlite')
}

async function open(path) {
  const root = new Context()
  try {
    await root.installComponent(createLocalSqliteComponent(path))
    const serviceKey = 'test.mcp-environment'
    await root.installComponent(createMcpEnvironmentComponent({ serviceKey, timeoutMs: 5000 }))
    const mcp = root.get(serviceKey)
    assert.ok(mcp)
    return { mcp, close: () => root.fiber.dispose() }
  } catch (error) { await root.fiber.dispose(); throw error }
}

function openScope(mcp, target, scopeId) {
  return mcp.openTargetScope(target.targetId, { scopeId, ownerEpoch: 1, signal: new AbortController().signal })
}

function execute(scope, tool, operationId) {
  return scope.execute({ operationId, toolId: tool.toolId, version: tool.version, arguments: { query: 'plan' }, resuming: false })
}

test('two Streamable HTTP targets keep identical native tool names distinct across JSON and SSE responses', async t => {
  const [left, right, path] = await Promise.all([fixture(t, 'left'), fixture(t, 'right', { stream: true }), dbPath(t)])
  const { mcp, close } = await open(path)
  try {
    const a = await mcp.createConnection({ name: 'Left docs', endpoint: left.endpoint })
    const b = await mcp.createConnection({ name: 'Right docs', endpoint: right.endpoint })
    assert.equal(a.status, 'unverified')
    assert.equal(b.status, 'unverified')
    assert.deepEqual(mcp.targets(), [])
    assert.deepEqual([...left.received, ...right.received], [])
    const refreshed = await Promise.all([mcp.refreshConnection(a.id), mcp.refreshConnection(b.id)])
    assert.deepEqual(refreshed.map(connection => connection.status), ['ready', 'ready'])
    const [aTarget, bTarget] = mcp.targets()
    const aTool = aTarget.tools[0], bTool = bTarget.tools[0]
    assert.notEqual(aTool.toolId, bTool.toolId)
    assert.notEqual(aTool.definition.name, bTool.definition.name)
    const leftScope = openScope(mcp, aTarget, 'left-run')
    const rightScope = openScope(mcp, bTarget, 'right-run')
    const wrong = execute(leftScope, bTool, 'wrong-tool')
    await assert.rejects(wrong.result, { code: 'mcp-tool-unavailable' })
    await wrong.done
    assert.equal(left.toolCalls().length, 0)
    const leftCall = execute(leftScope, aTool, 'left-search')
    const rightCall = execute(rightScope, bTool, 'right-search')
    const [aResult, bResult] = await Promise.all([leftCall.result, rightCall.result])
    await Promise.all([leftCall.done, rightCall.done])
    assert.equal(aResult.result.content[0].text, 'left found plan')
    assert.equal(bResult.result.content[0].text, 'right found plan')
    assert.equal(left.toolCalls().length, 1)
    assert.equal(right.toolCalls().length, 1)
    const duplicate = execute(leftScope, aTool, 'left-search')
    await assert.rejects(duplicate.result, { code: 'mcp-operation-already-admitted' })
    await duplicate.done
    left.setDescription('Revised search contract')
    await mcp.refreshConnection(a.id)
    assert.equal(left.received.filter(message => message.method === 'initialize').length, 1)
    assert.notEqual(mcp.targets()[0].tools[0].version, aTool.version)
    assert.equal(mcp.targets()[1].tools[0].version, bTool.version)
    const stale = execute(leftScope, aTool, 'stale-tool')
    await assert.rejects(stale.result, { code: 'mcp-tool-unavailable' })
    await stale.done
    assert.equal(left.toolCalls().length, 1)
    await Promise.all([leftScope.close().done, rightScope.close().done])
  } finally { await close() }
})

test('a lost response blocks the same endpoint and native tool across rediscovery, new identity and restart', async t => {
  const [server, path] = await Promise.all([fixture(t, 'interrupted', { interrupt: true }), dbPath(t)])
  let host = await open(path)
  let replacement
  try {
    const connection = await host.mcp.createConnection({ name: 'Old', endpoint: server.endpoint })
    await host.mcp.refreshConnection(connection.id)
    const target = host.mcp.targets()[0], tool = target.tools[0]
    const scope = openScope(host.mcp, target, 'interrupted-run')
    const call = execute(scope, tool, 'accepted-send')
    await assert.rejects(call.result, { code: 'mcp-unavailable' })
    await assert.rejects(call.done, { code: 'mcp-exit-unknown' })
    await assert.rejects(scope.close().done, { code: 'mcp-exit-unknown' })
    assert.equal(server.toolCalls().length, 1)
    server.setDescription('Changed after loss')
    await host.mcp.refreshConnection(connection.id)
    assert.deepEqual(host.mcp.targets()[0].tools, [])
    await host.mcp.disableConnection(connection.id)
    replacement = await host.mcp.createConnection({ name: 'New', endpoint: server.endpoint })
    assert.notEqual(replacement.targetId, connection.targetId)
    await host.mcp.refreshConnection(replacement.id)
    assert.deepEqual(host.mcp.targets()[0].tools, [])
  } finally { await host.close() }
  host = await open(path)
  try {
    assert.equal(host.mcp.connections().find(connection => connection.id === replacement.id).status, 'unverified')
    await host.mcp.refreshConnection(replacement.id)
    assert.deepEqual(host.mcp.targets()[0].tools, [])
    assert.equal(server.toolCalls().length, 1)
  } finally { await host.close() }
})

test('an admitted cancellation sends a scoped notification and retains unconfirmed remote exit', async t => {
  const [server, path] = await Promise.all([fixture(t, 'held', { held: true }), dbPath(t)])
  const { mcp, close } = await open(path)
  try {
    const connection = await mcp.createConnection({ name: 'Held', endpoint: server.endpoint })
    await mcp.refreshConnection(connection.id)
    const target = mcp.targets()[0]
    const scope = openScope(mcp, target, 'held-run')
    const observed = server.nextCall()
    const call = execute(scope, target.tools[0], 'cancelled-send')
    const request = await observed
    call.cancel('run-cancelled')
    await assert.rejects(call.result, { code: 'mcp-cancelled' })
    await assert.rejects(call.done, { code: 'mcp-exit-unknown' })
    assert.deepEqual(server.received.filter(message => message.method === 'notifications/cancelled').map(message => message.params),
      [{ requestId: request.id }])
    assert.equal(server.toolCalls().length, 1)
    assert.deepEqual(mcp.targets()[0].tools, [])
    assert.equal(mcp.connections()[0].error, 'mcp-exit-unknown')
  } finally { await close() }
})

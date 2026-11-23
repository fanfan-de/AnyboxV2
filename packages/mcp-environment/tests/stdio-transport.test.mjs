import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { processRuntimeAvailable } from '@anybox/computer-tools/platform/process-runtime'
import { createMcpStdioClient } from '../dist/stdio.js'

const server = `
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const [state, mode] = process.argv.slice(2)
const send = body => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...body }) + '\\n')
let initialize, worker
const input = createInterface({ input: process.stdin })
if (mode === 'hang') {
  process.on('SIGTERM', () => setTimeout(() => process.exit(0), 150))
}
input.on('line', line => {
  const request = JSON.parse(line)
  switch (request.method) {
    case 'initialize':
      initialize = request.id
      send({ id: 123, method: 'ping' })
      break
    case undefined:
      if (request.id !== 123 || Object.keys(request.result).length) process.exit(2)
      send({ id: initialize, result: { protocolVersion: '2025-11-25', serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} } } })
      break
    case 'notifications/initialized':
      break
    case 'tools/list':
      send({ id: request.id, result: request.params.cursor ? { tools: [{ name: 'second' }] } : { tools: [{ name: 'first' }], nextCursor: 'next' } })
      break
    case 'tools/call':
      if (mode === 'hang') {
        worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
        writeFileSync(state, JSON.stringify({ parent: process.pid, worker: worker.pid, id: request.id }))
      } else if (mode === 'oversize') {
        process.stdout.write(Buffer.alloc(1_048_577, 0x61))
      } else {
        process.stderr.write('private diagnostics')
        const text = request.params.arguments.value
        setTimeout(() => send({ id: request.id, result: { text } }), text === 'slow' ? 100 : 0)
      }
      break
    case 'notifications/cancelled':
      const started = JSON.parse(readFileSync(state, 'utf8'))
      writeFileSync(state, JSON.stringify({ ...started, cancelled: request.params.requestId }))
      break
  }
})
input.on('close', () => {
  if (mode === 'hang') setInterval(() => {}, 1000)
})
`

async function fixture(t, mode) {
  const cwd = await mkdtemp(join(tmpdir(), 'anybox-mcp-stdio-wire-'))
  const script = join(cwd, 'server.mjs'), state = join(cwd, 'state.json')
  await writeFile(script, server)
  let client
  t.after(async () => {
    try { await client?.close() }
    finally { await rm(cwd, { recursive: true, force: true }) }
  })
  client = createMcpStdioClient({ command: process.execPath, args: [script, state, mode], cwd }, 4_000)
  return { client, state }
}

async function readState(path, condition = () => true) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const value = JSON.parse(await readFile(path, 'utf8'))
      if (condition(value)) return value
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
    await delay(10)
  }
  assert.fail('The stdio fixture did not reach the expected state')
}

function assertExited(pid) {
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
}

test('stdio negotiates, answers ping, discovers paginated tools and correlates independent replies', { skip: !processRuntimeAvailable() }, async t => {
  const { client } = await fixture(t, 'normal')
  const signal = new AbortController().signal
  assert.deepEqual(await client.discover(signal), [{ name: 'first' }, { name: 'second' }])
  const [slow, fast] = await Promise.all([client.call('slow', 'first', { value: 'slow' }, signal),
    client.call('fast', 'first', { value: 'fast' }, signal)])
  assert.deepEqual([slow, fast], [{ failed: false, value: { text: 'slow' } }, { failed: false, value: { text: 'fast' } }])
  await client.close()
})

test('stdio cancellation sends the original ID and closing waits for the child and its owned descendant', { skip: !processRuntimeAvailable() }, async t => {
  const { client, state } = await fixture(t, 'hang')
  await client.discover(new AbortController().signal)
  const controller = new AbortController()
  const call = client.call('original', 'first', {}, controller.signal)
  const { parent, worker } = await readState(state)
  assert.equal(process.kill(parent, 0), true)
  assert.equal(process.kill(worker, 0), true)
  controller.abort()
  await assert.rejects(call, { name: 'AbortError' })
  assert.equal((await readState(state, value => value.cancelled)).cancelled, 'original')
  let exited = false
  const closing = client.close().then(() => { exited = true })
  await delay(25)
  assert.equal(exited, false)
  await closing
  assertExited(parent)
  assertExited(worker)
})

test('stdio rejects oversized stdout before framing and still waits for cleanup', { skip: !processRuntimeAvailable() }, async t => {
  const { client } = await fixture(t, 'oversize')
  const signal = new AbortController().signal
  await client.discover(signal)
  await assert.rejects(client.call('original', 'first', {}, signal), { code: 'mcp-response-too-large' })
  await client.close()
})

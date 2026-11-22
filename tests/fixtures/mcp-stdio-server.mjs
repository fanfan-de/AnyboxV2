import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const [label, eventsPath] = process.argv.slice(2)
const record = (event, data) => appendFileSync(eventsPath, JSON.stringify({ event, pid: process.pid, ...data }) + '\n')
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
const search = { name: 'search', description: 'Search this fixture.', inputSchema: {
  type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false,
} }
let initialized = false

record('start')
const input = createInterface({ input: process.stdin })
input.on('line', line => {
  const request = JSON.parse(line)
  assert.equal(request.jsonrpc, '2.0')
  switch (request.method) {
    case 'initialize':
      assert.equal(initialized, false)
      reply(request.id, { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: label, version: '1' } })
      break
    case 'notifications/initialized':
      initialized = true
      break
    case 'tools/list':
      assert.equal(initialized, true)
      reply(request.id, { tools: [search] })
      break
    case 'tools/call': {
      assert.equal(initialized, true)
      assert.equal(request.params.name, 'search')
      const { query } = request.params.arguments
      record('call', { name: request.params.name, query })
      if (query !== 'hold') {
        reply(request.id, { content: [{ type: 'text', text: `${label}:${query}` }] })
        break
      }
      // Resist graceful shutdown so tests can verify that the supervisor joins a complete tree.
      process.on('SIGTERM', () => {})
      const child = spawn(process.execPath, ['-e',
        'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'],
      { stdio: ['ignore', 'pipe', 'ignore'] })
      child.stdout.once('data', () => record('holding', { childPid: child.pid }))
      break
    }
    case 'notifications/cancelled':
      record('cancel')
      break
    default:
      assert.fail(`unexpected method ${request.method}`)
  }
})
input.on('close', () => record('stdin-closed'))

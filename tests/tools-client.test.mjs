import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createToolsSettingsClient } from '../dist/applications/harness/web/tools-client.js'
import { mapResourceIds } from '../dist/applications/harness/web/harness-client.js'
import { allowedProxyPath } from '../dist/applications/harness/client/gateway.js'

const settle = () => new Promise(resolve => setImmediate(resolve))
const catalog = [{ toolId: 'codex.update_plan', name: 'update_plan', selectable: true, dependencies: [], definition: { name: 'codex_update_plan' }, source: { harnessId: 'codex' } },
  { toolId: 'claude-code.Read', name: 'Read', selectable: true, dependencies: [], definition: { name: 'claude_code_Read' }, source: { harnessId: 'claude-code' } }]
function fixture() {
  const requests = []
  const client = createToolsSettingsClient((path, body, signal) => path === '/tools' ? Promise.resolve(catalog) :
    new Promise((resolve, reject) => requests.push({ path, body, signal, resolve, reject })), error => error.message)
  return { client, requests }
}

test('tools settings isolate drafts by Agent and capture the target before a save completes', async () => {
  const { client, requests } = fixture()
  client.selectAgent('first'); client.selectAgent('second'); await settle()
  requests[1].resolve({ agentId: 'second', toolIds: [], revision: 0 }); requests[0].resolve({ agentId: 'first', toolIds: [], revision: 0 }); await settle()
  client.toggle('claude-code.Read', true)
  const saving = client.save(); client.selectAgent('first'); await settle()
  assert.deepEqual(requests[2].body, { toolIds: ['claude-code.Read'], expectedRevision: 0 })
  assert.equal(requests[2].path, '/agents/second/tools')
  requests[2].resolve({ agentId: 'second', toolIds: ['claude-code.Read'], revision: 1 }); await saving
  assert.deepEqual(client.snapshot().toolIds, [])
  client.selectAgent('second'); assert.deepEqual(client.snapshot().toolIds, ['claude-code.Read'])
  assert.equal(client.snapshot().dirty, false)
  await client.dispose()
})

test('tools CAS conflicts preserve mixed selections until an explicit reload and disposal joins accepted saves', async () => {
  const { client, requests } = fixture()
  client.selectAgent('agent'); await settle(); requests[0].resolve({ agentId: 'agent', toolIds: [], revision: 0 }); await settle()
  client.toggle('codex.update_plan', true); client.toggle('claude-code.Read', true)
  const saving = client.save(); await settle()
  requests[1].reject(Object.assign(new Error('conflict'), { code: 'agent-tools-conflict' })); await saving
  assert.deepEqual(client.snapshot().toolIds, ['codex.update_plan', 'claude-code.Read'])
  assert.equal(client.snapshot().conflict, true); assert.equal(client.canLeave(), false)
  await client.save(); assert.equal(requests.length, 2)
  const reload = client.reload(); await settle(); requests[2].resolve({ agentId: 'agent', toolIds: ['codex.update_plan'], revision: 2 }); await reload
  client.toggle('codex.update_plan', false)
  const clearing = client.save(); await settle()
  let disposed = false; const closing = client.dispose().then(() => { disposed = true }); await settle()
  assert.equal(disposed, false); assert.equal(requests[3].signal.aborted, false)
  requests[3].resolve({ agentId: 'agent', toolIds: [], revision: 3 }); await clearing; await closing
})

test('tool identities remain unscoped and remote proxy admits only the exact catalog and Agent settings routes', () => {
  const data = { agentId: 'assistant', toolIds: ['codex.update_plan'], toolSelection: { schemaVersion: 1, tools: [{ toolId: 'claude-code.Read', version: '1.0.0', definition: { name: 'claude_code_Read', parameters: {} } }] } }
  const scoped = mapResourceIds(data, value => `instance:${value}`)
  assert.equal(scoped.agentId, 'instance:assistant')
  assert.deepEqual(scoped.toolIds, data.toolIds); assert.deepEqual(scoped.toolSelection, data.toolSelection)
  assert.equal(allowedProxyPath('GET', '/tools'), true)
  assert.equal(allowedProxyPath('POST', '/tools'), false)
  for (const method of ['GET', 'POST']) assert.equal(allowedProxyPath(method, '/agents/assistant/tools'), true)
  for (const path of ['/tools/extra', '/agents/assistant/tools/extra', '/agents/a%2fb/tools']) assert.equal(allowedProxyPath('GET', path), false)
})

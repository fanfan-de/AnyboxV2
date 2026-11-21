import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEnvironmentManagement, grantUpdate, preferenceUpdate, targetKey } from '../dist/management.js'

const computer = { environmentId: 'computer', targetId: 'device-a:1', toolId: 'read', version: '1' }
const replaced = { ...computer, targetId: 'device-a:2' }
const remote = { ...computer, targetId: 'device-b:1' }
const hosted = { environmentId: 'model-search', targetId: 'provider:responses:1', toolId: 'web_search', version: 'responses' }

test('management resolves exact targets, never grants through preferences, and allows revoking stale bindings', async () => {
  let support = [replaced, hosted], savedPreference = { environmentIds: ['computer'], version: 1 }
  let current = { agentId: 'writer', revision: 7, grants: [{ tool: computer, generation: 6 }] }
  const changes = new Map(), writes = []
  const manager = createEnvironmentManagement({
    agents: () => [{ id: 'writer', name: 'Writer' }],
    grants: () => ({
      get: async () => current,
      pendingChanges: async id => [...changes.values()].filter(change => change.agentId === id && change.state !== 'completed'),
      observe: async requestId => changes.get(requestId),
      set: async input => {
        const prior = changes.get(input.requestId)
        if (prior) return prior
        writes.push(input)
        current = { agentId: input.agentId, revision: current.revision + 1,
          grants: input.tools.map(tool => ({ tool, generation: current.revision + 1 })) }
        const change = { agentId: input.agentId, revision: current.revision, requestId: input.requestId,
          state: 'draining', affectedCount: 2, pendingCount: 2, unknownCount: 0 }
        changes.set(input.requestId, change)
        return change
      },
    }),
    tools: async () => support,
    names: async () => new Map([[targetKey('model-search', hosted.targetId), 'Provider A · Responses']]),
    preference: async () => savedPreference,
    setPreference: async (_id, input) => (savedPreference = { ...input, version: savedPreference.version + 1 }),
  })
  const before = await manager.view('writer')
  assert.equal(before.targets[1].name, 'Provider A · Responses')
  assert.deepEqual(before.authorization.grants.map(grant => grant.tool), [computer])
  await manager.setPreference('writer', preferenceUpdate({ environmentIds: ['model-search'], expectedVersion: 1,
    toolIdsByEnvironment: { 'model-search': [] } }))
  assert.equal(current.revision, 7)
  assert.equal(writes.length, 0)
  await assert.rejects(manager.setGrants('writer', { expectedRevision: 7, requestId: 'forge', tools: [remote] }), { status: 403 })
  await assert.rejects(manager.setGrants('writer', { expectedRevision: 6, requestId: 'stale', tools: [] }), { status: 409 })
  const input = grantUpdate({ expectedRevision: 7, requestId: 'replace', tools: [hosted] })
  const operation = await manager.setGrants('writer', input)
  assert.deepEqual((await manager.targets())[1].agents, [{ id: 'writer', name: 'Writer', toolIds: ['web_search'] }])
  support = []
  assert.equal(await manager.setGrants('writer', input), operation)
  assert.equal(writes.length, 1)
  assert.equal((await manager.observe('writer', 'replace')).pendingCount, 2)
  await assert.rejects(manager.observe('other-agent', 'replace'), { status: 404 })
  assert.deepEqual((await manager.view('writer')).targets, [])
})

test('preference filters preserve absent, all and explicit empty selections', () => {
  const base = { environmentIds: ['notes'], expectedVersion: 0 }
  assert.deepEqual(preferenceUpdate(base), base)
  assert.deepEqual(preferenceUpdate({ ...base, toolIdsByEnvironment: {} }).toolIdsByEnvironment, {})
  assert.deepEqual(preferenceUpdate({ ...base, toolIdsByEnvironment: { notes: [] } }).toolIdsByEnvironment, { notes: [] })
  for (const value of [[], null, 'notes', { computer: [] }, { notes: ['read','read'] }, { notes: [null] }]) {
    assert.throws(() => preferenceUpdate({ ...base, toolIdsByEnvironment: value }), { status: 400 })
  }
  assert.throws(() => grantUpdate({ requestId: 'same', expectedRevision: 0, tools: [hosted, hosted] }), { status: 400 })
})

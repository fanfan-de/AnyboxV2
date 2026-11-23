import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEnvironmentManagement, createTargetedToolManagement, environmentTargets, grantUpdate, preferenceUpdate, selectionUpdate, targetKey } from '../dist/management.js'
import { createToolEnvironmentCatalog } from '../dist/catalog.js'
import { checkedTargetToolPreferences, functionKey } from '../dist/bindings.js'

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

test('targeted preferences keep same-name tools attached to independent stable connection identities', () => {
  const work = { environmentId: 'mcp', targetId: 'work:2', toolId: 'search', version: '2' }
  const personal = { ...work, targetId: 'personal:1' }
  const workKey = targetKey('mcp', 'work'), personalKey = targetKey('mcp', 'personal')
  const labels = new Map([[targetKey('mcp', work.targetId), 'Work'], [targetKey('mcp', personal.targetId), 'Personal']])
  const selectionIds = new Map([[targetKey('mcp', work.targetId), 'work'], [targetKey('mcp', personal.targetId), 'personal']])
  assert.deepEqual(environmentTargets([work, personal], labels, selectionIds).map(target => [target.name, target.targetId, target.selectionId]), [
    ['Work', 'work:2', 'work'], ['Personal', 'personal:1', 'personal'],
  ])
  const input = { environmentIds: ['mcp'], expectedVersion: 1, toolIdsByTarget: { [workKey]: ['search'], [personalKey]: [] } }
  assert.deepEqual(selectionUpdate(input), input)
  assert.deepEqual(preferenceUpdate(input), input)
  for (const invalid of [null, { work: ['search'] }, { '["mcp", "work"]': ['search'] }, { [workKey]: ['search', 'search'] }]) {
    assert.throws(() => preferenceUpdate({ ...input, toolIdsByTarget: invalid }), { status: 400 })
  }
})

test('editing preferences can preserve a previously selected tool after its connection becomes unavailable', () => {
  const workKey = targetKey('mcp', 'work'), personalKey = targetKey('mcp', 'personal')
  const catalog = { environments: [{ environmentId: 'mcp' }], targets: () => [{ selectionId: 'personal', tools: [{ toolId: 'search' }] }] }
  const saved = { [workKey]: ['read'] }
  const modified = { ...saved, [personalKey]: ['search'] }
  assert.deepEqual(checkedTargetToolPreferences(modified, catalog, undefined, saved), modified)
  assert.deepEqual(checkedTargetToolPreferences({ [personalKey]: ['search'] }, catalog, undefined, saved), { [personalKey]: ['search'] })
  assert.throws(() => checkedTargetToolPreferences(modified, catalog), { status: 400 })
  assert.throws(() => checkedTargetToolPreferences({ [workKey]: ['read', 'search'] }, catalog, undefined, saved), { status: 400 })
})

test('targeted provider choices and new grants use the registered directory, including an empty transaction view', async () => {
  const descriptor = { environmentId: 'library', version: '1', tools: [] }
  const tool = { toolId: 'library.read', version: '1', definition: { name: 'library_read', parameters: { type: 'object' } } }
  const target = { targetId: 'docs:1', selectionId: 'docs', name: 'Documents', tools: [tool] }
  let live = [target]
  const catalog = createToolEnvironmentCatalog([{ descriptor, targets: reader => reader?.targets ?? live }])
  const management = createTargetedToolManagement(catalog)
  assert.deepEqual(management.choices().get(targetKey('library', 'docs:1')), { selectionId: 'docs', name: 'Documents' })
  const offered = functionKey(descriptor, target.targetId, tool)
  management.validateNewGrants({ targets: [target] }, [offered, hosted])
  assert.throws(() => management.validateNewGrants({ targets: [] }, [offered]),
    { status: 403, code: 'environment-tool-unavailable' })
  assert.throws(() => management.validateNewGrants({ targets: [{ ...target, tools: [{ ...tool, version: '2' }] }] }, [offered]),
    { status: 403, code: 'environment-tool-unavailable' })
  const inventory = createEnvironmentManagement({
    agents: () => [], tools: async () => [offered], targetedTools: management,
    async names() { live = []; return new Map() },
  })
  assert.deepEqual(await inventory.targets(), [])
})

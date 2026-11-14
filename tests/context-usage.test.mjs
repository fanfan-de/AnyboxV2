import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contextUsage } from '../packages/app-harness/dist/web/context-usage.js'

const model = { id: 'model', modelDefinitionVersionId: 'definition-v1', limits: { context: 100_000 } }
const run = (id, extra = {}) => ({ id, status: 'completed', modelId: 'model', history: { kind: 'tree', parentNodeId: null },
  modelSnapshot: { schemaVersion: 3, modelDefinitionVersionId: 'definition-v1', limits: { context: 100_000 } }, ...extra })
const view = (...usages) => ({ exchanges: usages.map(usage => ({ id: crypto.randomUUID(), blocks: [], ...(usage ? { usage } : {}) })) })
const state = (extra = {}) => ({ session: { modelId: 'model', historyMode: 'native-local-v1' }, loading: false,
  position: { viewNodeId: 'node' }, path: [{ id: 'node', sourceRunId: 'parent' }], runs: [run('parent')],
  views: new Map([['parent', view({ inputTokens: 35_000, outputTokens: 5000 })]]), ...extra })

test('context usage uses the latest measured exchange of the selected branch, without summing requests or sibling runs', () => {
  const s = state({ runs: [run('parent'), run('sibling')], views: new Map([
    ['parent', view({ inputTokens: 20_000, outputTokens: 1000 }, { inputTokens: 35_000, outputTokens: 5000 })],
    ['sibling', view({ inputTokens: 95_000, outputTokens: 1000 })],
  ]) })
  assert.equal(contextUsage(s, [model]).used, 40_000)
  assert.equal(contextUsage(s, [model]).percent, 40)
  assert.equal(contextUsage(s, [model]).tone, 'normal')
  s.path = [{ id: 'sibling-node', sourceRunId: 'sibling' }]
  s.position = { viewNodeId: 'sibling-node' }
  assert.equal(contextUsage(s, [model]).used, 96_000)
  assert.equal(contextUsage(s, [model]).tone, 'danger')
})

test('active and followed runs use only statistics belonging to this pane position', () => {
  const s = state({ runs: [run('parent'), run('current', { status: 'running', history: { kind: 'tree', parentNodeId: 'node' } }),
    run('elsewhere', { status: 'running', history: { kind: 'tree', parentNodeId: 'another-node' } })] })
  assert.equal(contextUsage(s, [model]).used, undefined)
  assert.match(contextUsage(s, [model]).detail, /本次运行尚未返回/)
  s.views.set('current', view({ inputTokens: 80_000, outputTokens: 1000 }, undefined))
  assert.equal(contextUsage(s, [model]).used, undefined, 'a new unmeasured request does not reuse old statistics')
  s.views.set('current', view({ inputTokens: 80_000, outputTokens: 1000 }))
  assert.equal(contextUsage(s, [model]).used, 81_000)
  assert.equal(contextUsage(s, [model]).tone, 'warning')
  s.runs[1] = { ...s.runs[1], status: 'completed' }
  s.position.follow = { runId: 'current', parentNodeId: 'node' }
  assert.equal(contextUsage(s, [model]).used, 81_000)
})

test('ambiguous parallel runs require an explicit followed or focused run', () => {
  const s = state({ runs: ['a', 'b'].map(id => run(id, { status: 'running', history: { kind: 'tree', parentNodeId: 'node' } })) })
  s.views.set('a', view({ inputTokens: 1000, outputTokens: 200 }))
  s.views.set('b', view({ inputTokens: 5000, outputTokens: 200 }))
  assert.equal(contextUsage(s, [model]).percent, undefined)
  assert.match(contextUsage(s, [model]).detail, /多个运行/)
  s.position.focusedRunId = 'b'
  assert.equal(contextUsage(s, [model]).used, 5200)
  s.position.follow = { runId: 'a', parentNodeId: 'node' }
  assert.equal(contextUsage(s, [model]).used, 1200)
})

test('missing input/output or limits remains unknown while reported zero is valid', () => {
  const s = state()
  for (const usage of [{ outputTokens: 12 }, { inputTokens: 123 }, { inputTokens: -1, outputTokens: 12 }, { inputTokens: NaN, outputTokens: 12 }]) {
    s.views.set('parent', view(usage))
    assert.equal(contextUsage(s, [model]).percent, undefined)
    assert.equal(contextUsage(s, [model]).used, undefined)
  }
  s.views.set('parent', view({ inputTokens: 0, outputTokens: 0 }))
  assert.equal(contextUsage(s, [model]).percent, 0)
  s.runs[0].modelSnapshot.limits = {}
  assert.equal(contextUsage(s, [{ ...model, limits: { input: 1000 } }]).percent, undefined)
  assert.equal(contextUsage(s, [{ ...model, limits: { input: 1000 } }]).used, 0)
})

test('run-pinned limit wins and old snapshots borrow only the exact definition version', () => {
  const s = state()
  assert.equal(contextUsage(s, [{ ...model, limits: { context: 200_000 } }]).limit, 100_000)
  delete s.runs[0].modelSnapshot.limits
  assert.equal(contextUsage(s, [model]).limit, 100_000)
  assert.equal(contextUsage(s, [{ ...model, modelDefinitionVersionId: 'new', limits: { context: 200_000 } }]).limit, undefined)
  s.session.modelId = 'other'
  assert.equal(contextUsage(s, [{ ...model, id: 'other' }]).used, undefined)
  assert.match(contextUsage(s, [{ ...model, id: 'other' }]).detail, /模型已切换/)
})

test('new roots, loading, legacy histories and invalid sums do not manufacture an empty context', () => {
  assert.equal(contextUsage(state({ path: [], position: { viewNodeId: null } }), [model]).used, undefined)
  assert.equal(contextUsage(state({ loading: true }), [model]).used, undefined)
  assert.equal(contextUsage(state({ session: { modelId: 'model', historyMode: 'dialogue-v1' } }), [model]).used, undefined)
  assert.equal(contextUsage(state({ views: new Map([['parent', view({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 })]]) }), [model]).used, undefined)
})

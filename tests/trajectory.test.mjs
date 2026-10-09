import assert from 'node:assert/strict'
import { test } from 'node:test'
import { protocolToolContext, findProtocolToolFact } from '../dist/applications/harness/web/tool-call-view.js'
import { filterTrajectory, sessionTrajectory, trajectoryTimeline } from '../dist/applications/harness/web/trajectory.js'

const at = seconds => new Date(Date.UTC(2026, 9, 2, 1, 0, seconds)).toISOString()
const run = (id = 'run', extra = {}) => ({ id, sessionId: 'session', input: 'Find the project', status: 'completed',
  history: { kind: 'tree', parentNodeId: null }, revision: 1, modelId: 'model', requestedModelId: null,
  createdAt: at(0), updatedAt: at(10), modelSnapshot: { remoteModelId: 'deepseek-chat', protocolId: 'chat-completions' },
  protocolBinding: { protocolId: 'chat-completions', viewSchemaVersion: 2 }, ...extra })
const model = (id, time) => ({ kind: 'operation-started', operationId: id, operationKind: 'model', at: at(time) })
const observed = (id, time) => ({ kind: 'operation-observed', operationId: id, at: at(time) })
const bash = (id, time, command = 'pwd') => ({ kind: 'tool-started', id, requestId: id, name: 'bash', command, at: at(time) })
const bashResult = (id, time, extra = {}) => ({ kind: 'tool-observed', requestId: id, name: 'bash', at: at(time),
  exitCode: 0, signal: null, stdout: '/project', stderr: '', truncated: false, ...extra })
const text = (value, id = 'text') => ({ id, type: 'chat.content', text: value })
const request = (id = 'bash-id', command = 'pwd') => ({ id: 'tool-' + id, type: 'chat.tool_call', name: 'bash',
  requestId: id, arguments: JSON.stringify({ command }) })
const view = (exchanges, extra = {}) => ({ envelopeVersion: 1, viewSchemaVersion: 2, protocolId: 'chat-completions',
  sessionId: 'session', runId: 'run', viewRevision: 1, status: 'committed', exchanges, ...extra })
const project = (value, events = [], snapshot) => sessionTrajectory([value], new Map([[value.id, events]]),
  snapshot ? new Map([[value.id, snapshot]]) : new Map())

test('one continuous ledger orders safe input, model response and real tool facts without duplicate request results', () => {
  const value = run('run', { images: [{ assetId: 'image' }], files: [{ snapshotId: 'file' }] })
  const events = [model('exchange-1', 0), observed('exchange-1', 2), bash('bash-id', 2), bashResult('bash-id', 3),
    model('exchange-2', 4), observed('exchange-2', 9)]
  const snapshot = view([
    { id: 'exchange-1', inputs: [{ id: 'system', role: 'system', text: 'Be helpful' },
      { id: 'context', role: 'context', text: 'Workspace details' }, { id: 'user', role: 'user', text: 'Task template: Find the project' }],
    blocks: [{ id: 'thought', type: 'chat.reasoning_content', text: 'Inspect the workspace' }, text('I will inspect this project'), request()] },
    { id: 'exchange-2', blocks: [text('This is Anybox')] },
  ])
  const before = structuredClone({ value, events, snapshot }), rows = project(value, events, snapshot)
  assert.deepEqual(rows.map(row => row.role), ['system', 'context', 'user', 'assistant', 'tool', 'assistant'])
  assert.equal(rows[2].preview, 'Find the project\n1 张图片\n1 个文件')
  assert.match(rows[2].input, /实际模型输入\nTask template: Find the project/)
  assert.equal(rows.filter(row => row.role === 'user').length, 1)
  assert.equal(rows[3].label, 'deepseek-chat'); assert.equal(rows[3].elapsedMs, 2000)
  assert.match(rows[3].output, /推理摘要\nInspect the workspace/)
  assert.match(rows[3].output, /工具请求 bash/)
  assert.deepEqual(rows[3].protocolView.exchanges, [snapshot.exchanges[0]])
  assert.equal(rows[3].protocolView.exchanges[0].blocks[0].type, 'chat.reasoning_content')
  assert.match(rows[4].output, /stdout\n\/project/); assert.equal(rows[4].elapsedMs, 1000)
  assert.equal(rows[5].output, 'This is Anybox'); assert.equal(rows[5].elapsedMs, 5000)
  assert.deepEqual({ value, events, snapshot }, before)
})

test('an unsupported stored protocol does not consume the current Chat view', () => {
  const value = run('run', { protocolBinding: { protocolId: 'retired-protocol', viewSchemaVersion: 2 },
    modelSnapshot: { remoteModelId: 'historical-model', protocolId: 'retired-protocol' } })
  const snapshot = view([{ id: 'exchange', inputs: [{ id: 'system', role: 'system', text: 'Original instructions' }],
    blocks: [text('Original answer')] }])
  const before = structuredClone(value), rows = project(value, [model('exchange', 0), observed('exchange', 1)], snapshot)
  assert.equal(rows.find(row => row.role === 'system'), undefined)
  assert.equal(rows.find(row => row.role === 'assistant').output, '')
  assert.deepEqual(value, before)
})

test('an obsolete display schema is not reinterpreted as native content', () => {
  const snapshot = { ...view([{ id: 'exchange', blocks: [{ id: 'text', kind: 'text', text: 'Old display' }] }]), viewSchemaVersion: 1 }
  const rows = project(run(), [model('exchange', 0), observed('exchange', 1)], snapshot)
  assert.equal(rows.find(row => row.role === 'assistant').protocolView, undefined)
  assert.equal(rows.find(row => row.role === 'assistant').output, '')
})

test('scope-qualified exchange IDs match only their current device, run, session and protocol', () => {
  const instance = '11111111-1111-1111-1111-111111111111', other = '22222222-2222-2222-2222-222222222222'
  const value = run(`h:${instance}:run`, { sessionId: `h:${instance}:session` })
  const events = [model('exchange', 0), observed('exchange', 1)]
  const snapshot = view([{ id: `h:${other}:exchange`, blocks: [text('wrong device')] },
    { id: `h:${instance}:exchange`, blocks: [text('right device')] }], { runId: value.id, sessionId: value.sessionId })
  assert.equal(project(value, events, snapshot).find(row => row.role === 'assistant').output, 'right device')
  for (const wrong of [{ runId: `h:${other}:run` }, { sessionId: `h:${other}:session` }, { protocolId: 'responses' }])
    assert.equal(project(value, events, { ...snapshot, ...wrong }).find(row => row.role === 'assistant').output, '')
})

test('reused request and operation IDs stay separate by their original event position', () => {
  const events = [model('reused-model', 0), observed('reused-model', 1), bash('reused', 1), bashResult('reused', 2),
    model('reused-model', 3), observed('reused-model', 4), bash('reused', 4), bashResult('reused', 7, { exitCode: 1, stderr: 'second failed' })]
  const rows = project(run(), events), calls = rows.filter(row => row.role === 'tool')
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length)
  assert.deepEqual(calls.map(row => [row.startedAt, row.finishedAt, row.elapsedMs]), [[at(1), at(2), 1000], [at(4), at(7), 3000]])
  assert.match(calls[1].output, /second failed/)
  assert.equal(calls[0].state, 'completed'); assert.equal(calls[1].state, 'failed')
})

test('queued native tool requests keep their row identity when durable execution is observed', () => {
  const events = [model('exchange', 0), observed('exchange', 1)]
  const snapshot = view([{ id: 'exchange', blocks: [request('next', 'ls')] }])
  const queued = project(run('run', { status: 'running' }), events, { ...snapshot, status: 'provisional' })
  const queuedTool = queued.find(row => row.role === 'tool')
  assert.equal(queuedTool.state, 'queued'); assert.equal(queuedTool.input, 'ls')
  assert.equal(queuedTool.startedAt, undefined); assert.equal(queuedTool.finishedAt, undefined); assert.equal(queuedTool.elapsedMs, undefined)
  assert.equal(queuedTool.provisional, true)
  assert.equal(queuedTool.requestOnly, true)
  assert.equal(queuedTool.output, '执行结果未记录')
  for (const mode of ['sequence', 'duration']) assert.equal(trajectoryTimeline(queued, mode).spans.some(span => span.rowId === queuedTool.id), false)
  const finished = project(run(), [...events, bash('next', 2, 'ls'), bashResult('next', 4)], snapshot)
  assert.equal(finished.filter(row => row.role === 'tool').length, 1)
  assert.equal(finished.find(row => row.role === 'tool').id, queuedTool.id)
  assert.equal(finished.find(row => row.role === 'tool').elapsedMs, 2000)
})

test('tool joins use the originating exchange and occurrence and reject another device', () => {
  const instance = '11111111-1111-1111-1111-111111111111', foreign = '22222222-2222-2222-2222-222222222222'
  const value = run(`h:${instance}:run`)
  const events = [model('first', 0), observed('first', 1), bash('shared', 1, 'pwd'), bashResult('shared', 2),
    model('second', 3), observed('second', 4), bash('shared', 4, 'ls'), bashResult('shared', 5, { stdout: 'second' })]
  const before = structuredClone(events), context = protocolToolContext(value, events, 'ready')
  assert.equal(findProtocolToolFact(context, `h:${instance}:first`, 'shared', 'bash').command, 'pwd')
  assert.equal(findProtocolToolFact(context, `h:${instance}:second`, 'shared', 'bash').stdout, 'second')
  assert.equal(findProtocolToolFact(context, `h:${foreign}:first`, 'shared', 'bash'), undefined)
  assert.equal(findProtocolToolFact(context, 'first', 'shared', 'apply_patch'), undefined)
  assert.equal(context.facts[1].modelEventIndex, 4)
  assert.deepEqual(events, before)
})

test('an unread or failed tool ledger never fabricates an unexecuted result', () => {
  const value = run('run', { status: 'cancelled' }), events = [model('exchange', 0), observed('exchange', 1)]
  const snapshot = view([{ id: 'exchange', blocks: [request('pending')] }])
  for (const [state, message] of [['loading', '正在读取执行结果'], ['failed', '执行结果读取失败']]) {
    const rows = sessionTrajectory([value], new Map([[value.id, events]]), new Map([[value.id, snapshot]]), new Map([[value.id, state]]))
    const call = rows.find(row => row.role === 'tool')
    assert.equal(call.output, message); assert.equal(call.requestOnly, true)
    assert.equal(call.startedAt, undefined); assert.equal(call.finishedAt, undefined)
    assert.ok(!call.output.includes('未开始执行'))
  }
})

test('legacy queued batches are visible requests without claiming execution or a duration', () => {
  const events = [model('exchange', 0), observed('exchange', 1), { kind: 'model-tool-calls', at: at(1),
    calls: [{ id: 'queued', name: 'bash', command: 'ls' }, { id: 'started', name: 'bash', command: 'pwd' }] },
    bash('started', 2), bashResult('started', 3)]
  const rows = project(run('run', { status: 'cancelled' }), events)
  const queued = rows.find(row => row.tool?.id === 'queued'), started = rows.find(row => row.tool?.id === 'started')
  assert.equal(queued.state, 'cancelled'); assert.equal(queued.elapsedMs, undefined); assert.equal(queued.step, undefined)
  assert.equal(started.state, 'completed'); assert.equal(started.elapsedMs, 1000)
  assert.equal(trajectoryTimeline(rows).spans.some(span => span.rowId === queued.id), false)
})

test('unstarted built-in tool requests remain assistant display rather than fabricated local tool executions', () => {
  const rows = project(run(), [model('exchange', 0), observed('exchange', 2)], view([{ id: 'exchange', blocks: [
    { id: 'web', type: 'responses.web_search_call', status: 'completed', query: 'Anybox architecture' },
  ] }]))
  assert.equal(rows.filter(row => row.role === 'tool').length, 0)
  assert.match(rows.find(row => row.role === 'assistant').output, /Web search · completed/)
})

test('rejected duplicate provider request IDs retain distinct display rows without inventing execution', () => {
  const first = request('duplicate', 'pwd'), second = { ...request('duplicate', 'ls'), id: 'different-block' }
  const rows = project(run('run', { status: 'failed' }), [model('exchange', 0), observed('exchange', 1)],
    view([{ id: 'exchange', blocks: [first, second] }]))
  const requests = rows.filter(row => row.role === 'tool')
  assert.equal(requests.length, 2); assert.equal(new Set(requests.map(row => row.id)).size, 2)
  assert.deepEqual(requests.map(row => row.input), ['pwd', 'ls'])
  assert.ok(requests.every(row => row.state === 'skipped' && !row.step && row.elapsedMs === undefined))
  assert.ok(requests.every(row => !trajectoryTimeline(rows).spans.some(span => span.rowId === row.id)))
})

test('cancellation and cleanup failures retain actual patch changes and leave unobserved exits untimed', () => {
  const result = { status: 'partial', changes: [{ kind: 'added', path: '/project/created.txt' }],
    pending: [{ kind: 'update', path: '/project/pending.txt' }], diagnostic: { code: 'conflict', message: 'File changed' } }
  const rows = project(run('run', { status: 'cancelled', errorCategory: 'tool-cleanup-failure' }), [
    model('finished', 0), observed('finished', 1), { kind: 'tool-started', id: 'patch', requestId: 'patch', name: 'apply_patch',
      patch: '*** Begin Patch\n*** End Patch', patchTruncated: true, at: at(1) },
    { kind: 'tool-observed', name: 'apply_patch', requestId: 'patch', result, at: at(2) },
    { kind: 'tool-failed', name: 'apply_patch', requestId: 'patch', category: 'tool-cleanup-failure', at: at(3) }, model('unobserved', 4),
  ])
  const patch = rows.find(row => row.role === 'tool'), incomplete = rows.find(row => row.step?.id === 'unobserved')
  assert.match(patch.output, /created.txt/); assert.match(patch.output, /pending.txt/); assert.match(patch.output, /tool-cleanup-failure/)
  assert.match(patch.output, /补丁预览已截断/); assert.equal(patch.tool.result, result)
  assert.equal(incomplete.state, 'cancelled'); assert.equal(incomplete.finishedAt, undefined); assert.equal(incomplete.elapsedMs, undefined)
})

test('legacy and absent event ledgers expose only known input, saved output and Run state', () => {
  for (const extra of [{}, { history: { kind: 'legacy-unknown' } }]) {
    const value = run('run', { output: 'Saved answer', ...extra })
    const rows = project(value, extra.history ? [model('cannot-identify', 0)] : [], view([{ id: 'cannot-identify', blocks: [text('Do not infer this')] }]))
    assert.deepEqual(rows.map(row => row.role), ['user', 'assistant', 'status'])
    assert.equal(rows[1].output, 'Saved answer')
    assert.equal(rows[2].output, extra.history ? '旧版记录未保存完整执行步骤与耗时。' : '此记录未保存执行步骤。')
    assert.ok(rows.every(row => row.finishedAt === undefined && row.elapsedMs === undefined))
    assert.equal(trajectoryTimeline(rows, 'duration').hasTiming, false)
  }
  assert.deepEqual(project(run()).map(row => row.role), ['user', 'status'])
})

test('an unread ledger and an active empty ledger never claim that execution facts were not saved', () => {
  const unread = sessionTrajectory([run()], new Map(), new Map())
  assert.equal(unread.find(row => row.role === 'status').output, '')
  for (const status of ['running', 'cancelling'])
    assert.equal(project(run('run', { status })).find(row => row.role === 'status').output, '')
  const legacyEvents = project(run('run', { output: 'Saved' }), [{ kind: 'model-started', at: at(0) }])
  assert.equal(legacyEvents.find(row => row.role === 'status').output, '旧版记录未保存完整执行步骤与耗时。')
})

test('available safe live output is a provisional fallback while its event ledger is still unloaded', () => {
  const snapshot = view([{ id: 'exchange', blocks: [text('Current safe output'), request('pending')] }], { status: 'provisional' })
  const rows = project(run('run', { status: 'running' }), [], snapshot)
  assert.deepEqual(rows.map(row => row.role), ['user', 'assistant', 'status'])
  assert.match(rows[1].output, /Current safe output/); assert.equal(rows[1].provisional, true)
  assert.equal(rows[1].step, undefined); assert.equal(rows[1].elapsedMs, undefined)
  assert.equal(rows.filter(row => row.role === 'tool').length, 0)
  assert.equal(trajectoryTimeline(rows, 'duration').hasTiming, false)
  assert.deepEqual(project(run('run', { history: { kind: 'legacy-unknown' } }), [], snapshot).map(row => row.role), ['user', 'status'])
})

test('native requests that never started preserve cancellation, interruption and skipped states without execution bars', () => {
  const snapshot = view([{ id: 'exchange', blocks: [request('unstarted')] }])
  for (const [status, expected] of [['cancelled', 'cancelled'], ['interrupted', 'interrupted'], ['failed', 'skipped'], ['completed', 'skipped']]) {
    const rows = project(run('run', { status }), [model('exchange', 0), observed('exchange', 1)], snapshot)
    const pending = rows.find(row => row.role === 'tool')
    assert.equal(pending.state, expected); assert.equal(pending.step, undefined)
    assert.equal(pending.startedAt, undefined); assert.equal(pending.finishedAt, undefined); assert.equal(pending.elapsedMs, undefined)
    for (const mode of ['sequence', 'duration']) assert.equal(trajectoryTimeline(rows, mode).spans.some(span => span.rowId === pending.id), false)
  }
})

test('stored final answers remain available when a bounded model display contains only reasoning or tool requests', () => {
  const rows = project(run('run', { output: 'Saved final answer' }), [model('last', 0), observed('last', 2)],
    view([{ id: 'last', blocks: [{ id: 'reasoning', type: 'chat.reasoning_content', text: 'Safe summary' }] },
      { id: 'display-limit', blocks: [{ id: 'display-limit', type: 'harness.display_limit', text: 'Earlier display content is truncated' }] }]))
  assert.match(rows.find(row => row.role === 'assistant').output, /Safe summary[\s\S]*Saved final answer/)
  assert.equal(rows.find(row => row.label === '展示范围').output, 'Earlier display content is truncated')
})

test('Runs have stable chronological turns and retain the initialization sent for each Run', () => {
  const values = [run('b', { createdAt: at(2) }), run('a', { createdAt: at(0) }), run('c', { createdAt: at(2) })]
  const events = new Map(values.map(value => [value.id, [model('exchange', 0), observed('exchange', 1)]]))
  const snapshots = new Map(values.map(value => [value.id, view([{ id: 'exchange', inputs: [
    { id: 'system', role: 'system', text: value.id === 'c' ? 'Different branch initialization' : 'Common initialization' },
    { id: 'user', role: 'user', text: value.input },
  ], blocks: [text(value.id)] }], { runId: value.id })]))
  const rows = sessionTrajectory(values, events, snapshots)
  assert.deepEqual(rows.filter(row => row.role === 'user').map(row => [row.runId, row.turn]), [['a', 1], ['b', 2], ['c', 3]])
  assert.deepEqual(rows.filter(row => row.role === 'system').map(row => row.input), ['Common initialization', 'Common initialization', 'Different branch initialization'])
  assert.deepEqual(values.map(value => value.id), ['b', 'a', 'c'])
})

test('loading earlier history does not move or remove a later Run initialization row', () => {
  const first = run('first'), later = run('later', { createdAt: at(5) })
  const events = new Map([['first', [model('exchange', 0), observed('exchange', 1)]], ['later', [model('exchange', 5), observed('exchange', 6)]]])
  const snapshot = value => view([{ id: 'exchange', inputs: [{ id: 'system', role: 'system', text: 'Shared initialization' },
    { id: 'context', role: 'context', text: 'Shared context' }], blocks: [text(value.id)] }], { runId: value.id })
  const views = new Map([['later', snapshot(later)]])
  const before = sessionTrajectory([first, later], events, views).filter(row => row.runId === later.id)
  views.set(first.id, snapshot(first))
  const after = sessionTrajectory([first, later], events, views).filter(row => row.runId === later.id)
  assert.deepEqual(after, before)
  assert.equal(after.filter(row => row.role === 'system').length, 1)
  assert.equal(after.filter(row => row.role === 'context').length, 1)
})

test('repeated initialization inside one Run is deduplicated while changed text stays visible', () => {
  const inputs = [{ id: 'system', role: 'system', text: 'Same initialization' }, { id: 'context', role: 'context', text: 'Same context' }]
  const rows = project(run(), [model('first', 0), observed('first', 1), model('second', 2), observed('second', 3), model('third', 4), observed('third', 5)],
    view([{ id: 'first', inputs, blocks: [text('First')] }, { id: 'second', inputs, blocks: [text('Second')] },
      { id: 'third', inputs: [{ id: 'system', role: 'system', text: 'Changed input' }], blocks: [text('Third')] }]))
  assert.deepEqual(rows.filter(row => row.role === 'system').map(row => row.input), ['Same initialization', 'Changed input'])
  assert.equal(rows.filter(row => row.role === 'context').length, 1)
})

test('a partial safe display retains the complete saved final reply in derived summaries and search', () => {
  const saved = `Original beginning with NEEDLE\n${'x'.repeat(500)}\nDisplayed tail`
  const rows = project(run('run', { output: saved }), [model('last', 0), observed('last', 2)],
    view([{ id: 'last', blocks: [text('Displayed tail')] }]))
  const assistant = rows.find(row => row.role === 'assistant')
  assert.equal(assistant.preview, saved)
  assert.match(assistant.output, /Displayed tail[\s\S]*已保存最终回复\nOriginal beginning with NEEDLE/)
  assert.equal(filterTrajectory(rows, 'needle tail')[0].id, assistant.id)
  const exact = project(run('run', { output: 'Exact reply' }), [model('last', 0), observed('last', 2)],
    view([{ id: 'last', blocks: [text('Exact reply')] }])).find(row => row.role === 'assistant')
  assert.equal(exact.output, 'Exact reply')
})

test('search applies case-insensitive AND terms to complete loaded input, output and real tool results', () => {
  const rows = project(run(), [model('exchange', 0), observed('exchange', 1), bash('bash', 2, 'cat LONG-NAME.txt'),
    bashResult('bash', 3, { stdout: 'x'.repeat(300) + ' needle', stderr: 'IMPORTANT warning', truncated: true })])
  assert.equal(filterTrajectory(rows, '  ').length, rows.length)
  assert.equal(filterTrajectory(rows, 'NEEDLE warning')[0].tool.id, 'bash')
  assert.equal(filterTrajectory(rows, 'long-name NEEDLE').length, 1)
  assert.equal(filterTrajectory(rows, 'needle impossible').length, 0)
  assert.equal(filterTrajectory(rows, 'find PROJECT')[0].role, 'user')
})

test('sequence uses shared row IDs in stable lane order while duration compresses global idle and preserves concurrency', () => {
  const row = (id, role, start, end, extra = {}) => ({ id, runId: 'run', turn: 1, role, label: id,
    input: '', output: '', state: 'completed', ...(start === undefined ? {} : { startedAt: at(start) }),
    ...(end === undefined ? {} : { finishedAt: at(end) }), ...extra })
  const rows = [row('user', 'user', 0), row('model', 'assistant', 0, 10), row('tool-overlap', 'tool', 5, 15),
    row('tool-next', 'tool', 20, 25), row('missing-exit', 'assistant', 26), row('queued', 'tool', undefined, undefined, { state: 'queued' })]
  const sequence = trajectoryTimeline(rows)
  assert.deepEqual(sequence.spans.map(span => [span.rowId, span.lane]), [['user', 0], ['model', 1], ['tool-overlap', 2], ['tool-next', 2], ['missing-exit', 1]])
  assert.deepEqual(sequence.spans.map(span => [span.left, span.width]), [[0, .2], [.2, .2], [.4, .2], [.6, .2], [.8, .2]])
  const timed = trajectoryTimeline(rows, 'duration')
  assert.equal(timed.hasTiming, true)
  assert.deepEqual(timed.spans.map(span => [span.rowId, span.left, span.width]), [['model', 0, .5], ['tool-overlap', .25, .5], ['tool-next', .75, .25]])
  assert.equal(timed.spans.some(span => span.rowId === 'missing-exit'), false)
  assert.deepEqual(trajectoryTimeline([row('backwards', 'assistant', 5, 2), row('invalid', 'assistant', 0, 2, { startedAt: 'invalid' })], 'duration'),
    { mode: 'duration', hasTiming: false, spans: [] })
  const instantaneous = trajectoryTimeline([row('zero', 'assistant', 0, 0)], 'duration')
  assert.equal(instantaneous.hasTiming, true); assert.equal(instantaneous.spans[0].width, 0)
  assert.deepEqual(trajectoryTimeline([], 'sequence'), { mode: 'sequence', hasTiming: false, spans: [] })
})

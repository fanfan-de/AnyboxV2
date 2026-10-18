import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../packages/storage-sqlite/dist/sqlite.js'
import { localStorageServiceKey } from '../packages/storage-sqlite/dist/port.js'
import { createRunsFixture, fakeSdk, sampleResult, tick, waitFor } from './helpers/claude-agent.mjs'

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-claude-agent-')), fixtures = []
  t.after(async () => { for (const f of fixtures.reverse()) await f.close(); await rm(directory, { recursive: true, force: true }) })
  const open = async (overrides = {}) => { const f = await createRunsFixture(join(directory, 'claude-agent.sqlite'), { ...options, ...overrides }); fixtures.push(f); return f }
  return { directory, open }
}
const permission = (toolUseId = 't1', extra = {}) => ({ toolUseId, toolName: 'Bash', input: { command: 'ls' }, title: 'Run ls', description: null, reason: null, defaultToNo: false, allowSessionAvailable: true, reusablePermissions: { allow: [{ tool: 'Bash', pattern: 'ls:*' }], directories: [] }, questions: null, signal: new AbortController().signal, ...extra })

test('threads require an existing absolute directory and runs are admitted one per thread with idempotent keys', async t => {
  const { open } = await fixture(t, { directoryExists: async path => path === '/projects/a' || path === '/projects/b' })
  const f = await open()
  await assert.rejects(f.runs.createThread({ projectPath: 'projects/a' }), { code: 'project-path-invalid', status: 400 })
  await assert.rejects(f.runs.createThread({ projectPath: '/projects/missing' }), { code: 'project-path-missing', status: 404 })
  const a = await f.runs.createThread({ projectPath: '/projects/a' }), b = await f.runs.createThread({ projectPath: '/projects/b', title: 'Second' })
  assert.equal(a.title, 'a'); assert.equal(b.title, 'Second'); assert.equal(a.nativeSessionId, null)
  assert.deepEqual((await f.runs.listThreads()).map(thread => thread.id), [b.id, a.id])
  const run = await f.runs.startRun(a.id, { prompt: 'first', idempotencyKey: 'k1' })
  assert.equal(run.status, 'running'); assert.equal(f.sdk.runs.length, 1); assert.equal(f.sdk.runs[0].request.cwd, '/projects/a'); assert.equal(f.sdk.runs[0].request.resume, null)
  assert.equal((await f.runs.startRun(a.id, { prompt: 'first', idempotencyKey: 'k1' })).id, run.id, 'the same key returns the accepted run')
  await assert.rejects(f.runs.startRun(a.id, { prompt: 'other', idempotencyKey: 'k1' }), { code: 'idempotency-conflict', status: 409 })
  await assert.rejects(f.runs.startRun(a.id, { prompt: 'second', idempotencyKey: 'k2' }), { code: 'run-active', status: 409 })
  const parallel = await f.runs.startRun(b.id, { prompt: 'parallel', idempotencyKey: 'k1' })
  assert.notEqual(parallel.id, run.id); assert.equal(f.sdk.runs.length, 2)
  assert.equal(f.admission.busy(), true); assert.equal(f.admission.pauseIfIdle(), undefined)
  assert.equal((await f.runs.getThread(a.id)).lastRun.status, 'running')
  for (const active of f.sdk.runs) { active.finish({ kind: 'result', result: sampleResult() }); active.exit() }
  assert.equal((await f.runs.waitRun(run.id)).status, 'completed'); assert.equal((await f.runs.waitRun(parallel.id)).status, 'completed')
  assert.equal(f.admission.busy(), false)
  const release = f.admission.pauseIfIdle(); assert.equal(typeof release, 'function')
  await assert.rejects(f.runs.startRun(a.id, { prompt: 'paused', idempotencyKey: 'k3' }), { code: 'service-unavailable' })
  release(); release()
  const next = await f.runs.startRun(a.id, { prompt: 'after pause', idempotencyKey: 'k3' })
  assert.equal(f.sdk.runs.length, 3)
  f.sdk.runs[2].finish({ kind: 'result', result: sampleResult({ isError: true, text: 'Not logged in' }) }); f.sdk.runs[2].exit()
  const failed = await f.runs.waitRun(next.id)
  assert.equal(failed.status, 'failed'); assert.deepEqual(failed.error, { code: 'agent-error', message: 'Not logged in' })
  assert.deepEqual((await f.runs.listRuns(a.id)).map(item => item.status), ['completed', 'failed'])
})
test('a missing executable rejects runs with the resolution error without touching the index', async t => {
  const { open } = await fixture(t)
  const sdk = fakeSdk({ environment: { schemaVersion: 1, platform: 'linux', executable: { path: null, source: null, error: { code: 'claude-binary-missing', message: '未找到 `claude` 命令。' } } } })
  const f = await open({ sdk })
  const thread = await f.runs.createThread({ projectPath: '/p' })
  await assert.rejects(f.runs.startRun(thread.id, { prompt: 'x', idempotencyKey: 'k' }), error => error.code === 'claude-binary-missing' && error.status === 503 && error.message === '未找到 `claude` 命令。')
  assert.deepEqual(await f.runs.listRuns(thread.id), []); assert.equal(sdk.runs.length, 0)
})
test('events project into a bounded live view, the init session id is persisted and the result precedes actual exit', async t => {
  const { open } = await fixture(t)
  const f = await open()
  const frames = [], changes = []
  f.root.on('claude-agent.run.event', frame => frames.push(frame)); f.root.on('claude-agent.run.changed', change => changes.push(change))
  const thread = await f.runs.createThread({ projectPath: '/p' })
  const run = await f.runs.startRun(thread.id, { prompt: 'hello', idempotencyKey: 'k', model: 'claude-sonnet-5', effort: 'low' })
  const active = f.sdk.runs[0]
  assert.equal(active.request.model, 'claude-sonnet-5'); assert.equal(active.request.effort, 'low')
  active.hooks.onEvent({ type: 'init', init: { nativeSessionId: 'session-1', model: 'claude-sonnet-5', cwd: '/p', permissionMode: 'default', claudeCodeVersion: '2.1.278', toolCount: 3 } })
  active.hooks.onEvent({ type: 'message-start', messageId: 'm' }); active.hooks.onEvent({ type: 'block-start', messageId: 'm', index: 0, block: 'text' })
  active.hooks.onEvent({ type: 'text-delta', messageId: 'm', index: 0, text: 'Hi' })
  await waitFor(() => frames.length === 4)
  assert.deepEqual(frames.map(frame => frame.seq), [1, 2, 3, 4]); assert.equal(frames[0].runId, run.id)
  const view = f.runs.getRunView(run.id)
  assert.equal(view.seq, 4); assert.equal(view.items[0].blocks[0].block.text, 'Hi'); assert.equal(view.init.nativeSessionId, 'session-1')
  await waitFor(() => f.sdk.runs.length === 1 && changes.length >= 1)
  assert.equal((await f.runs.getRun(run.id)).nativeSessionId, 'session-1')
  await tick(); await tick()
  assert.equal((await f.runs.getThread(thread.id)).nativeSessionId, 'session-1', 'the first init pins the native session on the thread')
  active.hooks.onEvent({ type: 'result', result: sampleResult({ text: 'Hi' }) })
  active.finish({ kind: 'result', result: sampleResult({ text: 'Hi' }) })
  await tick()
  assert.equal((await f.runs.getRun(run.id)).status, 'running', 'the result is known before the process exited')
  let settled = false; const waiting = f.runs.waitRun(run.id).then(value => { settled = true; return value })
  await tick(); assert.equal(settled, false)
  active.exit()
  const finished = await waiting
  assert.equal(finished.status, 'completed'); assert.equal(finished.result.text, 'Hi'); assert.ok(finished.finishedAt)
  assert.deepEqual(changes.map(change => change.status), ['running', 'completed'])
  assert.equal(f.runs.getRunView(run.id).result.text, 'Hi', 'the finished view stays readable in memory')
  const second = await f.runs.startRun(thread.id, { prompt: 'again', idempotencyKey: 'k2' })
  assert.equal(f.sdk.runs[1].request.resume, 'session-1', 'later runs resume the pinned native session')
  f.sdk.runs[1].finish({ kind: 'failed', error: { code: 'agent-exited', message: 'exited early' } }); f.sdk.runs[1].exit()
  const failed = await f.runs.waitRun(second.id)
  assert.equal(failed.status, 'failed'); assert.equal(failed.error.code, 'agent-exited')
  const controller = new AbortController(); controller.abort()
  assert.equal((await f.runs.waitRun('unknown')), undefined)
})
test('approvals block the agent until answered, persist decisions and are denied when a run is cancelled', async t => {
  const { open } = await fixture(t)
  const f = await open()
  const frames = []; f.root.on('claude-agent.run.event', frame => frames.push(frame.event))
  const thread = await f.runs.createThread({ projectPath: '/p' })
  const run = await f.runs.startRun(thread.id, { prompt: 'do things', idempotencyKey: 'k' })
  const active = f.sdk.runs[0]
  active.hooks.onEvent({ type: 'init', init: { nativeSessionId: 'session-approval', model: 'model', cwd: '/p', permissionMode: 'default', claudeCodeVersion: 'test', toolCount: 1 } })
  const first = active.hooks.canUseTool(permission('t1'))
  const question = active.hooks.canUseTool(permission('q1', { toolName: 'AskUserQuestion', input: { questions: [] }, questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }], multiSelect: true }] }))
  await waitFor(() => f.runs.listPendingApprovals(thread.id).length === 2)
  const pending = f.runs.listPendingApprovals(thread.id)
  assert.deepEqual(pending.map(approval => [approval.toolName, approval.kind, approval.allowSessionAvailable]), [['Bash', 'permission', true], ['AskUserQuestion', 'question', false]])
  assert.equal(f.runs.listPendingApprovals('other-thread').length, 0)
  await assert.rejects(f.runs.resolveApproval(pending[1].id, 'allow', undefined), { code: 'invalid-input' })
  const answered = await f.runs.resolveApproval(pending[1].id, 'allow', { 'Which?': 'A, B' })
  assert.equal(answered.decision, 'allow'); assert.deepEqual(answered.answers, { 'Which?': 'A, B' })
  assert.deepEqual(await question, { behavior: 'allow', answers: { 'Which?': 'A, B' } })
  await assert.rejects(f.runs.resolveApproval(pending[1].id, 'deny', undefined), { code: 'approval-resolved', status: 409 })
  await assert.rejects(f.runs.resolveApproval('nope', 'deny', undefined), { code: 'approval-resolved' })
  const allowed = await f.runs.resolveApproval(pending[0].id, 'allow-session', undefined)
  assert.equal(allowed.decision, 'allow-session'); assert.deepEqual(await first, { behavior: 'allow', session: true })
  const aborted = new AbortController()
  const abandoned = active.hooks.canUseTool(permission('t2', { signal: aborted.signal }))
  await waitFor(() => f.runs.listPendingApprovals(thread.id).length === 1)
  aborted.abort()
  assert.deepEqual(await abandoned, { behavior: 'deny', message: 'The request was cancelled.' })
  assert.equal(f.runs.listPendingApprovals(thread.id).length, 0)
  const third = active.hooks.canUseTool(permission('t3'))
  await waitFor(() => f.runs.listPendingApprovals(thread.id).length === 1)
  const cancelling = await f.runs.cancelRun(run.id)
  assert.equal(cancelling.status, 'cancelling')
  assert.deepEqual(await third, { behavior: 'deny', message: 'User cancelled tool execution.' })
  assert.deepEqual(await active.hooks.canUseTool(permission('t4')), { behavior: 'deny', message: 'The run is no longer accepting tool requests.' })
  await waitFor(() => active.interrupts === 1)
  assert.equal(active.closed, false, 'a graceful interrupt is given time before the process is terminated')
  active.finish({ kind: 'result', result: sampleResult({ isError: true, text: 'Interrupted' }) }); active.exit()
  const finished = await f.runs.waitRun(run.id)
  assert.equal(finished.status, 'cancelled')
  assert.equal((await f.runs.cancelRun(run.id)).status, 'cancelled', 'cancelling a finished run is idempotent')
  await tick(); await tick()
  const stored = await f.store.listApprovals(run.id)
  assert.deepEqual(stored.map(approval => [approval.toolUseId, approval.decision]), [['t1', 'allow-session'], ['q1', 'allow'], ['t2', 'cancelled'], ['t3', 'deny']])
  assert.deepEqual(frames.filter(event => event.type === 'approval-resolved').map(event => event.approval.toolUseId), ['q1', 't1', 't2', 't3'])
  assert.equal(f.runs.getRunView(run.id).approvals.filter(approval => approval.decision === null).length, 0)
})
test('a cancelled run that neither answers the interrupt nor exits in time is terminated, and the fixture restart marks leftovers interrupted', async t => {
  const { open } = await fixture(t)
  const f = await open({ cancel: { interruptTimeoutMs: 5, resultTimeoutMs: 20, exitTimeoutMs: 20 } })
  const thread = await f.runs.createThread({ projectPath: '/p' })
  const run = await f.runs.startRun(thread.id, { prompt: 'loop', idempotencyKey: 'k' })
  const active = f.sdk.runs[0]
  await f.runs.cancelRun(run.id)
  await waitFor(() => active.closed, 2000)
  active.finish({ kind: 'failed', error: { code: 'cancelled', message: 'killed' } }); active.exit()
  assert.equal((await f.runs.waitRun(run.id)).status, 'cancelled')
  const slow = await f.runs.startRun(thread.id, { prompt: 'slow exit', idempotencyKey: 'k2' })
  const second = f.sdk.runs[1]
  await f.runs.cancelRun(slow.id)
  second.finish({ kind: 'result', result: sampleResult() })
  await waitFor(() => second.closed, 2000)
  second.exit()
  assert.equal((await f.runs.waitRun(slow.id)).status, 'cancelled')
  // Simulate a process crash: a running row without a live owner is interrupted by the next store start.
  await f.store.createRun({ id: 'orphan', threadId: thread.id, idempotencyKey: 'orphan', status: 'running', prompt: 'lost', model: null, resolvedModel: null, effort: null, nativeSessionId: null, createdAt: 'now', finishedAt: null, result: null, error: null })
  await f.store.updateThread(thread.id, { lastRunId: 'orphan', lastRunStatus: 'running' }, 'now')
  await f.close()
  const reopened = await open()
  const orphan = await reopened.runs.getRun('orphan')
  assert.equal(orphan.status, 'interrupted'); assert.equal(orphan.error.code, 'interrupted')
  assert.equal((await reopened.runs.getThread(thread.id)).lastRun.status, 'interrupted')
  assert.equal(reopened.runs.getRunView('orphan'), undefined, 'live views do not survive a restart')
})
test('disposing the component cancels active runs and joins their exits', async t => {
  const { open } = await fixture(t)
  let closed = 0
  const f = await open({ cancel: { interruptTimeoutMs: 5, resultTimeoutMs: 10, exitTimeoutMs: 10 }, sdkOptions: { onClose(run) { closed++; run.finish({ kind: 'failed', error: { code: 'cancelled', message: 'terminated' } }); setTimeout(() => run.exit(), 20) } } })
  const thread = await f.runs.createThread({ projectPath: '/p' })
  const run = await f.runs.startRun(thread.id, { prompt: 'long', idempotencyKey: 'k' })
  let disposed = false
  const closing = f.close().then(() => { disposed = true })
  await tick(); assert.equal(disposed, false)
  await closing
  assert.equal(closed, 1)
  const reopened = await open()
  assert.equal((await reopened.runs.getRun(run.id)).status, 'cancelled')
  await assert.rejects(f.runs.startRun(thread.id, { prompt: 'late', idempotencyKey: 'k9' }), { code: 'service-unavailable' })
})
test('an exited run stays busy until SQLite settlement finishes and shutdown keeps its terminal thread state', async t => {
  const { open } = await fixture(t)
  const f = await open()
  const thread = await f.runs.createThread({ projectPath: '/p' })
  const run = await f.runs.startRun(thread.id, { prompt: 'finish before shutdown', idempotencyKey: 'k' })
  const db = f.root.get(localStorageServiceKey), updateRun = f.store.updateRun
  let release, entered
  const blocked = new Promise(resolve => { release = resolve }), queued = new Promise(resolve => { entered = resolve })
  // Hold a real transaction ahead of the terminal write, as another application sharing SQLite can do.
  f.store.updateRun = (id, patch) => {
    if (patch.status === 'completed') void db.transaction(async () => { entered(); await blocked })
    return updateRun(id, patch)
  }
  let waited = false, closed = false, closing
  const waiting = f.runs.waitRun(run.id).then(value => { waited = true; return value })
  f.sdk.runs[0].finish({ kind: 'result', result: sampleResult() }); f.sdk.runs[0].exit()
  try {
    await queued
    assert.equal(f.admission.busy(), true, 'settlement still owns the thread and the shutdown lease')
    assert.equal(f.admission.pauseIfIdle(), undefined)
    assert.equal(waited, false)
    closing = f.close().then(() => { closed = true })
    await tick(); await tick()
    assert.equal(closed, false, 'shutdown waits for the Run and thread index writes')
    assert.equal((await f.runs.getRun(run.id)).status, 'completed', 'shutdown does not cancel an already exited result')
    assert.equal(f.sdk.runs[0].interrupts, 0)
  } finally { release(); await closing }
  const finished = await waiting
  assert.equal(finished.status, 'completed')
  const reopened = await open()
  assert.equal((await reopened.runs.getRun(run.id)).status, 'completed')
  assert.deepEqual((await reopened.runs.getThread(thread.id)).lastRun, { id: run.id, status: 'completed' })
})
test('thread history is read through the adapter with the pinned session and project directory', async t => {
  const { open } = await fixture(t)
  const calls = []
  const f = await open({ sdkOptions: { history: async (sessionId, dir) => { calls.push([sessionId, dir]); return [{ id: 'u1', role: 'user', blocks: [{ kind: 'text', text: 'hello', truncated: false }] }] } } })
  const thread = await f.runs.createThread({ projectPath: '/p' })
  assert.deepEqual(await f.runs.readThreadMessages(thread.id), { nativeSessionId: null, messages: [] })
  assert.deepEqual(calls, [])
  await f.store.updateThread(thread.id, { nativeSessionId: 'sess-9' }, 'later')
  const history = await f.runs.readThreadMessages(thread.id)
  assert.equal(history.nativeSessionId, 'sess-9'); assert.equal(history.messages[0].blocks[0].text, 'hello')
  assert.deepEqual(calls, [['sess-9', '/p']])
  await assert.rejects(f.runs.readThreadMessages('missing'), { code: 'thread-not-found', status: 404 })
})
test('recent projects merge thread directories with the Claude environment, keep only existing directories and flag a failed environment read', async t => {
  const existing = new Set(['/projects/a', '/projects/b', '/projects/claude-only'])
  const { open } = await fixture(t, { directoryExists: async path => existing.has(path) })
  let fail = false
  const sdk = fakeSdk({ sessionProjects: async () => {
    if (fail) throw new Error('no projects directory')
    return [{ path: '/projects/claude-only', lastUsedAt: '2026-10-16T00:00:00.500Z' }, { path: '/projects/a/', lastUsedAt: '2030-01-01T00:00:00.000Z' }, { path: '/projects/gone', lastUsedAt: '2031-01-01T00:00:00.000Z' }]
  } })
  const f = await open({ sdk, recentProjectLimit: 2 })
  const a = await f.runs.createThread({ projectPath: '/projects/a' }); await f.runs.createThread({ projectPath: '/projects/b' })
  const recent = await f.runs.listRecentProjects()
  assert.equal(recent.partial, false)
  assert.deepEqual(recent.projects.map(project => [project.path, project.source]), [['/projects/a', 'both'], ['/projects/b', 'threads']], 'the newest two existing directories; the missing one is dropped')
  assert.equal(recent.projects[0].lastUsedAt, '2030-01-01T00:00:00.000Z'); assert.equal(recent.projects[0].name, 'a')
  fail = true
  const fallback = await f.runs.listRecentProjects()
  assert.equal(fallback.partial, true); assert.deepEqual(fallback.projects.map(project => project.path), ['/projects/b', '/projects/a'])
  assert.ok(a.id)
})
test('threads take the first prompt as title, then the Claude environment\'s session title; user titles, reported models and pending counts are kept', async t => {
  const { open } = await fixture(t)
  const titles = new Map([['sa', 'Claude named it']])
  const sdk = fakeSdk({ sessionInfo: async sessionId => { const title = titles.get(sessionId); if (title === 'throw') throw new Error('unreadable'); return title === undefined ? undefined : { title } } })
  const f = await open({ sdk })
  const auto = await f.runs.createThread({ projectPath: '/projects/auto' }), named = await f.runs.createThread({ projectPath: '/projects/named', title: 'Mine' })
  assert.equal(auto.titleSource, 'default'); assert.equal(named.titleSource, 'user'); assert.equal(auto.pendingApprovals, 0)
  const run = await f.runs.startRun(auto.id, { prompt: '\n  Refactor the   parser\nsecond line', idempotencyKey: 'k1' })
  assert.equal(run.resolvedModel, null)
  let thread = await f.runs.getThread(auto.id)
  assert.deepEqual([thread.title, thread.titleSource], ['Refactor the parser', 'prompt'])
  const other = await f.runs.startRun(named.id, { prompt: 'hello', idempotencyKey: 'k1', model: 'requested-model' })
  assert.equal((await f.runs.getThread(named.id)).title, 'Mine')
  const [a, b] = f.sdk.runs
  a.hooks.onEvent({ type: 'init', init: { nativeSessionId: 'sa', model: 'default-model', cwd: '/projects/auto', permissionMode: 'default', claudeCodeVersion: 'v', toolCount: 0 } })
  b.hooks.onEvent({ type: 'init', init: { nativeSessionId: 'sb', model: 'requested-model', cwd: '/projects/named', permissionMode: 'default', claudeCodeVersion: 'v', toolCount: 0 } })
  assert.equal((await f.runs.getRun(run.id)).resolvedModel, 'default-model', 'the init frame reports the model the agent actually used')
  const decision = a.hooks.canUseTool(permission('t1'))
  await waitFor(() => f.runs.listPendingApprovals(auto.id).length === 1)
  assert.equal((await f.runs.getThread(auto.id)).pendingApprovals, 1); assert.equal((await f.runs.getThread(named.id)).pendingApprovals, 0)
  for (const active of [a, b]) { active.finish({ kind: 'result', result: sampleResult() }); active.exit() }
  await f.runs.waitRun(run.id); await f.runs.waitRun(other.id)
  assert.equal((await decision).behavior, 'deny')
  thread = await f.runs.getThread(auto.id)
  assert.deepEqual([thread.title, thread.titleSource, thread.pendingApprovals], ['Claude named it', 'claude', 0], 'the environment\'s title replaces the prompt title after the run')
  assert.deepEqual([(await f.runs.getThread(named.id)).title, (await f.runs.getThread(named.id)).titleSource], ['Mine', 'user'], 'user titles are never replaced')
  assert.deepEqual((await f.runs.listRecentModels()).models, ['requested-model', 'default-model'])
  titles.set('sa', 'throw')
  const again = await f.runs.startRun(auto.id, { prompt: 'continue', idempotencyKey: 'k2' })
  f.sdk.runs[2].finish({ kind: 'result', result: sampleResult() }); f.sdk.runs[2].exit()
  await f.runs.waitRun(again.id)
  assert.equal((await f.runs.getThread(auto.id)).title, 'Claude named it', 'an unreadable session keeps the current title')
  assert.equal((await f.runs.listRuns(auto.id)).length, 2)
})
test('an index written before title sources marks user titles on upgrade and keeps the other rows readable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-claude-agent-v1-')), path = join(directory, 'claude-agent.sqlite')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = new Context()
  await root.installComponent(createLocalSqliteComponent(path))
  await root.get(localStorageServiceKey).transaction(tx => {
    tx.execute(`CREATE TABLE claude_agent_threads (id TEXT PRIMARY KEY, project_path TEXT NOT NULL, title TEXT NOT NULL, native_session_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_run_id TEXT, last_run_status TEXT)`)
    tx.execute(`CREATE TABLE claude_agent_runs (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES claude_agent_threads(id), idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL, prompt TEXT NOT NULL, model TEXT, effort TEXT, native_session_id TEXT, created_at TEXT NOT NULL, finished_at TEXT,
      result_json TEXT, error_json TEXT, UNIQUE(thread_id, idempotency_key))`)
    tx.execute(`CREATE TABLE claude_agent_approvals (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, thread_id TEXT NOT NULL, tool_use_id TEXT NOT NULL,
      tool_name TEXT NOT NULL, kind TEXT NOT NULL, request_json TEXT NOT NULL, decision TEXT, answers_json TEXT, requested_at TEXT NOT NULL, resolved_at TEXT)`)
    tx.execute("INSERT INTO claude_agent_threads VALUES ('t-user', '/projects/demo', 'My title', 's1', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:01.000Z', 'r1', 'completed')")
    tx.execute("INSERT INTO claude_agent_threads VALUES ('t-default', '/projects/demo', 'demo', NULL, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', NULL, NULL)")
    tx.execute("INSERT INTO claude_agent_runs VALUES ('r1', 't-user', 'k', 'completed', 'p', 'old-model', NULL, 's1', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:01.000Z', NULL, NULL)")
    tx.execute("INSERT INTO schema_migrations (domain, version) VALUES ('claude-agent', 1)")
  })
  await root.fiber.dispose()
  const f = await createRunsFixture(path)
  try {
    const threads = await f.runs.listThreads()
    assert.deepEqual(threads.map(thread => [thread.id, thread.title, thread.titleSource]), [['t-user', 'My title', 'user'], ['t-default', 'demo', 'default']])
    const run = await f.runs.getRun('r1')
    assert.equal(run.model, 'old-model'); assert.equal(run.resolvedModel, null); assert.equal(run.status, 'completed')
    assert.deepEqual((await f.runs.listRecentModels()).models, ['old-model'])
  } finally { await f.close() }
})

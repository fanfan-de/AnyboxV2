import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { projectServiceKey } from '../dist/applications/harness/core/project/component.js'
import { processToolsServiceKey, createProcessToolsComponent } from '../dist/applications/harness/core/tool/process-component.js'

async function fixture(options = {}, projectLookup) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-process-tools-')))
  const root = new Context()
  await root.installComponent({ name: 'process-test-projects', apply(ctx) {
    ctx.provide(projectServiceKey, { async requireAvailable(id) {
      if (projectLookup) await projectLookup()
      if (id !== 'project') throw new Error('unknown project')
      return { id, path: directory, name: 'test', createdAt: 'now', available: true }
    } })
  } })
  await root.installComponent(createProcessToolsComponent({ terminationGraceMs: 40, ...options }))
  return { directory, root, processes: root.get(processToolsServiceKey), async close() {
    try { await root.fiber.dispose() } finally { rmSync(directory, { recursive: true, force: true }) }
  } }
}
async function result(call) { try { return await call.result } finally { await call.done } }
async function untilFile(path) {
  for (let attempt = 0; attempt < 200 && !existsSync(path); attempt++) await new Promise(yes => setTimeout(yes, 10))
  assert.ok(existsSync(path))
}

test('pipe execution yields a scoped session and later observations only consume new output', async () => {
  const f = await fixture()
  try {
    const scope = f.processes.openRun({ runId: 'r', projectId: 'project' })
    const first = await result(scope.execute('codex_exec_command', { cmd: 'printf first; sleep 0.1; printf second', login: false, yield_time_ms: 20 }))
    assert.equal(typeof first.session_id, 'number')
    let output = first.output, next = first
    for (let attempt = 0; next.session_id && attempt < 30; attempt++) {
      next = await result(scope.execute('codex_write_stdin', { session_id: first.session_id, yield_time_ms: 100 }))
      output += next.output
    }
    assert.equal(output, 'firstsecond')
    assert.equal(next.exit_code, 0)
    assert.equal(next.session_id, undefined)
    const cleanup = await result(scope.close())
    assert.equal(cleanup.cleanup, 'completed')
    assert.equal(cleanup.processes[0].output, '')
  } finally { await f.close() }
})

test('stdin remains open for Codex and process session IDs cannot cross Run scopes', async () => {
  const f = await fixture()
  try {
    const a = f.processes.openRun({ runId: 'a', projectId: 'project' }), b = f.processes.openRun({ runId: 'b', projectId: 'project' })
    const first = await result(a.execute('codex_exec_command', { cmd: 'printf ready; IFS= read -r line; printf "got:%s" "$line"', login: false, yield_time_ms: 20 }))
    const foreign = await result(b.execute('codex_write_stdin', { session_id: first.session_id, chars: 'intrusion\n', yield_time_ms: 0 }))
    assert.equal(foreign.error, 'session-unavailable')
    const actual = await result(a.execute('codex_write_stdin', { session_id: first.session_id, chars: 'answer\n', yield_time_ms: 200 }))
    assert.equal(first.output + actual.output, 'readygot:answer')
    await result(a.close()); await result(b.close())
  } finally { await f.close() }
})

test('normal scope cleanup cancels live groups and waits for actual exit', async () => {
  const f = await fixture()
  try {
    const scope = f.processes.openRun({ runId: 'r', projectId: 'project' })
    await result(scope.execute('codex_exec_command', { cmd: "trap 'sleep 0.02; printf cleaned > cleaned; exit' TERM; printf ready > started; while :; do sleep 1; done", login: false, yield_time_ms: 0 }))
    await untilFile(join(f.directory, 'started'))
    const cleanup = await result(scope.close())
    assert.equal(cleanup.cleanup, 'completed')
    assert.equal(cleanup.processes[0].terminated, true)
    assert.ok(existsSync(join(f.directory, 'cleaned')))
    assert.throws(() => scope.execute('codex_exec_command', { cmd: 'touch forbidden' }))
  } finally { await f.close() }
})

test('foreground helpers honor cwd, nonzero exit, output bounds and timeout', async () => {
  const f = await fixture({ maxBufferedOutputBytes: 8, timeoutMs: 50 })
  try {
    const scope = f.processes.openRun({ runId: 'r', projectId: 'project' })
    const cwd = await result(scope.foreground({ command: 'printf correct > cwd-marker', workdir: '/tmp', timeoutMs: 500 }))
    assert.equal(cwd.exit_code, 0)
    assert.ok(existsSync('/tmp/cwd-marker'))
    rmSync('/tmp/cwd-marker')
    const bounded = await result(scope.foreground({ command: "printf '你好你好你好'; exit 7", timeoutMs: 500 }))
    assert.equal(bounded.exit_code, 7)
    assert.equal(bounded.truncated, true)
    assert.ok(Buffer.byteLength(bounded.output) <= 8)
    assert.ok(!bounded.output.includes('\ufffd'))
    const timeout = await result(scope.foreground({ command: "trap '' TERM; while :; do sleep 1; done" }))
    assert.equal(timeout.timed_out, true)
    assert.ok(['SIGTERM', 'SIGKILL'].includes(timeout.signal), 'timeout joins the process even when it occurs before the shell installs its trap')
    await result(scope.close())
  } finally { await f.close() }
})

test('cleanup escalates after an initialized process ignores TERM and waits for KILL exit', async () => {
  const f = await fixture()
  try {
    const scope = f.processes.openRun({ runId: 'ignores-term', projectId: 'project' })
    await result(scope.execute('codex_exec_command', { cmd: "trap '' TERM; printf ready > ignores-term; while :; do sleep 1; done", login: false, yield_time_ms: 0 }))
    await untilFile(join(f.directory, 'ignores-term'))
    const cleanup = await result(scope.close())
    assert.equal(cleanup.cleanup, 'completed')
    assert.equal(cleanup.processes[0].signal, 'SIGKILL')
    assert.equal(cleanup.processes[0].terminated, true)
  } finally { await f.close() }
})

test('closing while a project lookup is pending never spawns the cancelled command', async () => {
  let release, started
  const lookup = new Promise(yes => { release = yes }), entered = new Promise(yes => { started = yes })
  const f = await fixture({}, () => { started(); return lookup })
  try {
    const scope = f.processes.openRun({ runId: 'r', projectId: 'project' })
    const call = scope.execute('codex_exec_command', { cmd: 'touch forbidden', yield_time_ms: 0 })
    await entered
    const closing = scope.close()
    let exited = false
    void closing.done.then(() => { exited = true })
    await new Promise(yes => setTimeout(yes, 10))
    assert.equal(exited, false)
    release()
    await assert.rejects(call.result, error => error.category === 'cancelled')
    await call.done
    await result(closing)
    assert.equal(existsSync(join(f.directory, 'forbidden')), false)
  } finally { release(); await f.close() }
})

test('component disposal joins accepted process scopes without requiring the caller to close them', async () => {
  const f = await fixture()
  try {
    const scope = f.processes.openRun({ runId: 'r', projectId: 'project' })
    await result(scope.execute('codex_exec_command', { cmd: "trap '' TERM; printf ready > started; while :; do sleep 1; done", login: false, yield_time_ms: 0 }))
    await untilFile(join(f.directory, 'started'))
    await f.root.fiber.dispose()
    const cleanup = await result(scope.close())
    assert.equal(cleanup.processes[0].signal, 'SIGKILL')
    assert.throws(() => f.processes.openRun({ runId: 'new', projectId: 'project' }))
  } finally { await f.close() }
})

test('a shell cannot leave a redirected child running as an independent background job', async () => {
  const f = await fixture()
  try {
    const scope = f.processes.openRun({ runId: 'r', projectId: 'project' })
    const observed = await result(scope.foreground({ command: 'sleep 10 >/dev/null 2>&1 & printf "%s" "$!"' }))
    assert.equal(observed.exit_code, 0)
    const childId = Number(observed.output)
    assert.ok(Number.isSafeInteger(childId) && childId > 0)
    assert.throws(() => process.kill(childId, 0), error => error.code === 'ESRCH')
    await result(scope.close())
  } finally { await f.close() }
})

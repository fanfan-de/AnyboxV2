import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { processToolsServiceKey, createProcessToolsComponent } from '@anybox/computer-tools/processes'
import { nodeCommand } from './helpers/native-shell.mjs'

async function fixture(options = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-process-tools-')))
  const root = new Context()
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

test('concurrent accepted calls cannot exceed the per-scope process limit', async () => {
  const f = await fixture({ maxProcessesPerScope: 1 })
  try {
    const scope = f.processes.openScope({ scopeId: 'limited', workspacePath: f.directory })
    const calls = Array.from({ length: 2 }, () => scope.execute( { command: nodeCommand('setInterval(()=>{},1000)'), yieldTimeMs: 0 }))
    const outcomes = Promise.allSettled(calls.map(result))
    const settled = await outcomes
    assert.equal(settled.filter(value => value.status === 'fulfilled').length, 1)
    assert.equal(settled.find(value => value.status === 'rejected').reason.category, 'unavailable')
    const cleanup = await result(scope.close())
    assert.equal(cleanup.processes.length, 1)
    assert.equal(cleanup.cleanup, 'completed')
  } finally { await f.close() }
})

test('pipe execution yields a scoped session and later observations only consume new output', async () => {
  const f = await fixture()
  try {
    const scope = f.processes.openScope({ scopeId: 'r', workspacePath: f.directory })
    const first = await result(scope.execute( { command: nodeCommand("process.stdout.write('first');setTimeout(()=>process.stdout.write('second'),100)"), login: false, yieldTimeMs: 20 }))
    assert.equal(typeof first.session_id, 'number')
    let output = first.output, next = first
    for (let attempt = 0; next.session_id && attempt < 30; attempt++) {
      next = await result(scope.write( { sessionId: first.session_id, yieldTimeMs: 100 }))
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
    const a = f.processes.openScope({ scopeId: 'a', workspacePath: f.directory }), b = f.processes.openScope({ scopeId: 'b', workspacePath: f.directory })
    const first = await result(a.execute( { command: nodeCommand("process.stdout.write('ready');process.stdin.once('data',b=>{process.stdout.write('got:'+b.toString().trim());process.exit(0)})"), login: false, yieldTimeMs: 20 }))
    const foreign = await result(b.write( { sessionId: first.session_id, chars: 'intrusion\n', yieldTimeMs: 0 }))
    assert.equal(foreign.error, 'session-unavailable')
    let actual = await result(a.write( { sessionId: first.session_id, chars: 'answer\n', yieldTimeMs: 200 })), output = first.output + actual.output
    for (let attempt = 0; actual.session_id && attempt < 30; attempt++) { actual = await result(a.write( { sessionId: first.session_id, yieldTimeMs: 100 })); output += actual.output }
    assert.equal(output, 'readygot:answer')
    await result(a.close()); await result(b.close())
  } finally { await f.close() }
})

test('normal scope cleanup cancels live groups and waits for actual exit', async () => {
  // Leave escalation headroom; this test controls exit explicitly rather than racing
  // a 20 ms trap against the fixture's normal 40 ms forced-kill timer under suite load.
  const f = await fixture({ terminationGraceMs: 5_000 })
  try {
    const scope = f.processes.openScope({ scopeId: 'r', workspacePath: f.directory })
    await result(scope.execute( { command: process.platform === 'win32' ? nodeCommand("require('node:fs').writeFileSync('pid',String(process.pid));require('node:fs').writeFileSync('started','ready');setInterval(()=>{},1000)") : "trap 'printf cleaning > cleaning; while [ ! -e release-cleanup ]; do sleep 0.01; done; printf cleaned > cleaned; exit' TERM; printf ready > started; while :; do sleep 1; done", login: false, yieldTimeMs: 0 }))
    await untilFile(join(f.directory, 'started'))
    const closing = scope.close()
    let exited = false
    void closing.done.then(() => { exited = true })
    if (process.platform !== 'win32') {
      await untilFile(join(f.directory, 'cleaning'))
      assert.equal(exited, false)
      assert.equal(existsSync(join(f.directory, 'cleaned')), false)
      writeFileSync(join(f.directory, 'release-cleanup'), '')
    }
    const cleanup = await result(closing)
    assert.equal(cleanup.cleanup, 'completed')
    assert.equal(cleanup.processes[0].terminated, true)
    if (process.platform === 'win32') {
      assert.equal(cleanup.processes[0].exit_code, 1)
      const pid = Number(readFileSync(join(f.directory, 'pid'), 'utf8'))
      assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH')
    } else assert.ok(existsSync(join(f.directory, 'cleaned')))
    assert.throws(() => scope.execute( { command: 'touch forbidden' }))
  } finally { await f.close() }
})

test('foreground helpers honor cwd, nonzero exit, output bounds and timeout', async () => {
  const f = await fixture({ maxBufferedOutputBytes: 8, timeoutMs: 50 })
  try {
    const scope = f.processes.openScope({ scopeId: 'r', workspacePath: f.directory })
    const cwd = await result(scope.foreground({ command: 'printf correct > cwd-marker', workdir: f.directory, timeoutMs: 2000 }))
    assert.equal(cwd.exit_code, 0)
    assert.ok(existsSync(join(f.directory, 'cwd-marker')))
    rmSync(join(f.directory, 'cwd-marker'))
    const bounded = await result(scope.foreground({ command: "printf '你好你好你好'; exit 7", timeoutMs: 2000 }))
    assert.equal(bounded.exit_code, 7)
    assert.equal(bounded.truncated, true)
    assert.ok(Buffer.byteLength(bounded.output) <= 8)
    assert.ok(!bounded.output.includes('\ufffd'))
    const timeout = await result(scope.foreground({ command: "trap '' TERM; while :; do sleep 1; done" }))
    assert.equal(timeout.timed_out, true)
    if (process.platform === 'win32') assert.equal(timeout.exit_code, 1)
    else assert.ok(['SIGTERM', 'SIGKILL'].includes(timeout.signal), 'timeout joins the process even when it occurs before the shell installs its trap')
    await result(scope.close())
  } finally { await f.close() }
})

test('cleanup escalates after an initialized process ignores TERM and waits for KILL exit', async () => {
  const f = await fixture()
  try {
    const scope = f.processes.openScope({ scopeId: 'ignores-term', workspacePath: f.directory })
    await result(scope.execute( { command: "trap '' TERM; printf ready > ignores-term; while :; do sleep 1; done", shell: 'bash', login: false, yieldTimeMs: 0 }))
    await untilFile(join(f.directory, 'ignores-term'))
    const cleanup = await result(scope.close())
    assert.equal(cleanup.cleanup, 'completed')
    if (process.platform === 'win32') assert.equal(cleanup.processes[0].exit_code, 1)
    else assert.equal(cleanup.processes[0].signal, 'SIGKILL')
    assert.equal(cleanup.processes[0].terminated, true)
  } finally { await f.close() }
})

test('closing before a queued process starts prevents the cancelled command from spawning', async () => {
  const f = await fixture()
  try {
    const scope = f.processes.openScope({ scopeId: 'queued', workspacePath: f.directory })
    const call = scope.execute({ command: 'touch forbidden', yieldTimeMs: 0 })
    const closing = scope.close()
    await assert.rejects(call.result, error => error.category === 'cancelled')
    await call.done
    await result(closing)
    assert.equal(existsSync(join(f.directory, 'forbidden')), false)
  } finally { await f.close() }
})

test('component disposal joins accepted process scopes without requiring the caller to close them', async () => {
  const f = await fixture()
  try {
    const scope = f.processes.openScope({ scopeId: 'r', workspacePath: f.directory })
    await result(scope.execute( { command: "trap '' TERM; printf ready > started; while :; do sleep 1; done", shell: 'bash', login: false, yieldTimeMs: 0 }))
    await untilFile(join(f.directory, 'started'))
    await f.root.fiber.dispose()
    const cleanup = await result(scope.close())
    if (process.platform === 'win32') assert.equal(cleanup.processes[0].exit_code, 1)
    else assert.equal(cleanup.processes[0].signal, 'SIGKILL')
    assert.throws(() => f.processes.openScope({ scopeId: 'new', workspacePath: f.directory }))
  } finally { await f.close() }
})

test('a shell cannot leave a redirected child running as an independent background job', async () => {
  const f = await fixture()
  try {
    const scope = f.processes.openScope({ scopeId: 'r', workspacePath: f.directory })
    const observed = await result(scope.foreground({ command: 'sleep 10 >/dev/null 2>&1 & printf "%s" "$!"' }))
    assert.equal(observed.exit_code, 0)
    const childId = Number(observed.output)
    assert.ok(Number.isSafeInteger(childId) && childId > 0)
    assert.throws(() => process.kill(childId, 0), error => error.code === 'ESRCH')
    await result(scope.close())
  } finally { await f.close() }
})

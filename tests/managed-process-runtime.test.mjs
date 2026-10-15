import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { spawnManagedProcess, processRuntimeAvailable } from '../dist/platform/process-runtime.js'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
function live(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { return error.code === 'EPERM' }
}
async function eventually(predicate, timeout = 5000) {
  const until = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > until) assert.fail('condition did not become true')
    await pause(10)
  }
}
function launch(code, options = {}) {
  return spawnManagedProcess({ executable: process.execPath, args: ['-e', code], cwd: process.cwd(), env: process.env, terminationGraceMs: 100, ...options })
}
function capture(child) {
  let output = '', error = ''
  child.stdout.on('data', bytes => { output += bytes.toString('utf8') })
  child.stderr.on('data', bytes => { error += bytes.toString('utf8') })
  return { get output() { return output }, get error() { return error } }
}
async function cleanup(child) { child.terminate(); await child.done.catch(() => {}) }

test('the target-native process supervisor is present for every supported host', () => {
  assert.equal(['win32', 'darwin', 'linux'].includes(process.platform), true)
  assert.equal(processRuntimeAvailable(), true, 'build-process-native.mjs must be part of the normal build')
})

test('native execution preserves Unicode, argument boundaries, environment, cwd and independent output pipes', { timeout: 10000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'anybox 原生 process '))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const args = ['', 'a b', 'quote"and\\', '中文\\ends\\', '\\"', '$(echo unsafe)']
  const child = launch('console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),value:process.env.ANYBOX_PROCESS_TEST})); console.error("独立 stderr");', {
    args: ['-e', 'console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),value:process.env.ANYBOX_PROCESS_TEST})); console.error("独立 stderr");', ...args],
    cwd, env: { ...process.env, ANYBOX_PROCESS_TEST: '值 with space' }, stdin: 'ignore',
  })
  t.after(() => cleanup(child))
  const output = capture(child)
  assert.deepEqual(await child.exited, { exitCode: 0, signal: null })
  await child.done
  assert.deepEqual(JSON.parse(output.output), { args, cwd, value: '值 with space' })
  assert.equal(output.error.trim(), '独立 stderr')
  assert.ok(child.pid > 0)
})

test('stdin remains available between observations and explicit end reaches the command', { timeout: 10000 }, async t => {
  const child = launch('process.stdin.setEncoding("utf8");process.stdin.on("data",x=>process.stdout.write(x));process.stdin.on("end",()=>console.log("ended"));')
  t.after(() => cleanup(child))
  const output = capture(child)
  child.stdin.write('第一轮\n')
  await eventually(() => output.output.includes('第一轮'))
  child.stdin.write('second\n'); child.stdin.end()
  await child.done
  assert.equal(output.output, '第一轮\nsecond\nended\n')
})

test('Windows cmd receives explicitly verbatim arguments without applying CRT escaping to its command language', { skip: process.platform !== 'win32', timeout: 10000 }, async t => {
  for (const command of ['echo plain', 'echo "quoted value"', 'echo 中文 & exit /b 7']) {
    const child = spawnManagedProcess({ executable: join(process.env.SystemRoot, 'System32/cmd.exe'),
      args: ['/d', '/s', '/c', `"${command}"`], windowsVerbatimArguments: true,
      cwd: process.cwd(), env: process.env, stdin: 'ignore',
    })
    t.after(() => cleanup(child))
    const output = capture(child)
    const exit = await child.exited; await child.done
    assert.equal(exit.exitCode, command.includes('exit /b') ? 7 : 0)
    assert.equal(output.error, '')
    if (command === 'echo plain') assert.equal(output.output.trim(), 'plain')
    if (command === 'echo "quoted value"') assert.equal(output.output.trim(), '"quoted value"')
  }
})

test('cancelling one process tree does not terminate another Run process session', { timeout: 10000 }, async t => {
  const first = launch('console.log("ready");setInterval(()=>{},1000)')
  const second = launch('console.log("ready");setInterval(()=>{},1000)')
  t.after(() => cleanup(first)); t.after(() => cleanup(second))
  const one = capture(first), two = capture(second)
  await eventually(() => one.output.includes('ready') && two.output.includes('ready'))
  first.terminate(); await first.done
  assert.equal(live(first.pid), false)
  assert.equal(live(second.pid), true)
  second.terminate(); await second.done
  assert.equal(live(second.pid), false)
})

test('a successful parent exit joins redirected descendants without changing its recorded exit code', { timeout: 10000 }, async t => {
  const child = launch(`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);c.unref();process.exitCode=7;`)
  t.after(() => cleanup(child))
  const output = capture(child)
  assert.equal((await child.exited).exitCode, 7)
  await child.done
  const descendant = Number(output.output.trim())
  assert.ok(descendant > 0)
  assert.equal(live(descendant), false)
})

test('cancellation joins a resistant descendant and all output before resolving done', { timeout: 10000 }, async t => {
  const child = launch(`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});console.log("child-ready");setInterval(()=>{},1000)'],{stdio:['ignore','pipe','ignore']});c.stdout.on('data',()=>console.log(JSON.stringify({parent:process.pid,descendant:c.pid})));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`)
  t.after(() => cleanup(child))
  const output = capture(child)
  await eventually(() => output.output.includes('\n'))
  const pids = JSON.parse(output.output)
  child.terminate(); await child.done
  assert.equal(live(pids.parent), false)
  assert.equal(live(pids.descendant), false)
})

test('owner process death closes the control pipe and cleans its tree even with blocked command stdin', { timeout: 15000 }, async t => {
  const owner = fork(new URL('./helpers/managed-process-owner.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true })
  t.after(() => { if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL') })
  const [pids] = await once(owner, 'message')
  assert.equal(live(pids.parent), true)
  assert.equal(live(pids.descendant), true)
  const exited = once(owner, 'exit')
  owner.kill('SIGKILL'); await exited
  await eventually(() => !live(pids.parent) && !live(pids.descendant), 10000)
})

test('Windows supervisor death closes its unique Job handle and kills the tree without reporting cleanup success', { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
  const child = launch(`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(JSON.stringify({parent:process.pid,descendant:c.pid,supervisor:process.ppid}));setInterval(()=>{},1000);`)
  t.after(() => cleanup(child))
  const output = capture(child)
  await eventually(() => output.output.includes('\n'))
  const pids = JSON.parse(output.output)
  assert.equal(pids.parent, child.pid)
  assert.ok(pids.supervisor > 0 && pids.supervisor !== process.pid && pids.supervisor !== pids.parent)
  assert.equal(live(pids.parent), true)
  assert.equal(live(pids.descendant), true)
  process.kill(pids.supervisor, 'SIGKILL')
  await assert.rejects(child.exited, /managed process runtime/)
  await assert.rejects(child.done, /managed process runtime/, 'a dead supervisor cannot certify resource cleanup')
  await eventually(() => !live(pids.parent) && !live(pids.descendant), 10000)
})

test('unconsumed output stays bounded while native pipes continue draining', { timeout: 10000 }, async t => {
  const child = launch('process.stdout.write("x".repeat(2097152));process.stderr.write("y".repeat(2097152));', { maxBufferedOutputBytes: 1024 })
  t.after(() => cleanup(child))
  await child.done
  assert.ok(child.stdout.readableLength <= 1024)
  assert.ok(child.stderr.readableLength <= 1024)
  assert.equal(child.outputTruncated, true)
  assert.equal((await child.exited).exitCode, 0)
})

test('missing executable and invalid cwd reject execution while confirmed resource cleanup succeeds', { timeout: 10000 }, async () => {
  for (const options of [{ executable: join(tmpdir(), 'anybox-no-such-executable-726482') }, { cwd: join(tmpdir(), 'anybox-no-such-directory-726482') }]) {
    const child = launch('', options)
    await assert.rejects(child.exited)
    await child.done
    assert.equal(child.pid, undefined)
  }
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@nya/core'
import { prepareShellCommand, toolEnvironment, bashExecutable } from '@anybox/computer-tools/platform/shell'
import { toolEnvironmentPrompt } from '../packages/app-harness/dist/core/tool/environment.js'
import { createProcessToolsComponent, processToolsServiceKey } from '@anybox/computer-tools/processes'
import { createBashComponent, bashServiceKey } from '@anybox/computer-tools/bash'

function nodeCommand(script) {
  const encoded = Buffer.from(script).toString('base64')
  const code = `eval(Buffer.from('${encoded}','base64').toString())`
  const quote = value => process.platform === 'win32' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`
  return `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} -e ${quote(code)}`
}
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anybox-native-tools-中文 '))), root = new Context()
  try {
    await root.installComponent(createProcessToolsComponent({ terminationGraceMs: 100, timeoutMs: 10_000 }))
    await root.installComponent(createBashComponent({ terminationGraceMs: 100 }))
    return { directory, root, tools: root.get(processToolsServiceKey), bash: root.get(bashServiceKey), async close() { try { await root.fiber.dispose() } finally { await rm(directory, { recursive: true, force: true }) } } }
  } catch (error) { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }); throw error }
}
async function finish(call) { try { return await call.result } finally { await call.done } }
async function drain(scope, first) {
  let result = first, output = first.output
  for (let attempts = 0; result.session_id && attempts < 100; attempts++) {
    result = await finish(scope.write( { sessionId: first.session_id, yieldTimeMs: 100 }))
    output += result.output
  }
  assert.equal(result.session_id, undefined, 'process must exit within the bounded observation period')
  return { ...result, output }
}
async function untilFile(path) {
  for (let attempts = 0; attempts < 200; attempts++) {
    try { return await readFile(path, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail('process did not report readiness')
}

test('shell selection preserves Bash contracts and uses the native Windows PowerShell default', () => {
  const normal = prepareShellCommand({ command: 'test-command' }), bash = prepareShellCommand({ command: 'test-command', bash: true, login: false })
  assert.equal(bash.executable, bashExecutable())
  assert.deepEqual(bash.args, ['-c', 'test-command'])
  if (process.platform === 'win32') {
    assert.match(normal.executable, /pwsh\.exe$/i)
    assert.ok(normal.args.includes('-EncodedCommand'))
    assert.ok(!/[\\/]system32[\\/]bash\.exe$/i.test(bash.executable))
  } else assert.ok(normal.args.includes('-lc'))
})
test('shell environment excludes application secrets and retains the OS variables', () => {
  const previous = process.env.ANYBOX_NATIVE_TEST_SECRET
  try {
    process.env.ANYBOX_NATIVE_TEST_SECRET = 'must-not-inherit'
    const environment = toolEnvironment()
    assert.equal(environment.ANYBOX_NATIVE_TEST_SECRET, undefined)
    if (process.platform === 'win32') assert.ok(environment.SystemRoot)
  } finally { if (previous === undefined) delete process.env.ANYBOX_NATIVE_TEST_SECRET; else process.env.ANYBOX_NATIVE_TEST_SECRET = previous }
})
test('environment prompt states the selected Computer OS and does not infer it from the server', () => {
  assert.match(toolEnvironmentPrompt('win32', 'C:\\中文 project').content, /PowerShell 7/)
  assert.match(toolEnvironmentPrompt('linux', '/project').content, /Bash; use POSIX/)
  assert.notEqual(toolEnvironmentPrompt('linux', '/a').versionId, toolEnvironmentPrompt('linux', '/b').versionId)
})
test('native default shell executes Unicode commands in a Unicode project directory', async () => {
  const f = await fixture()
  try {
    const scope = f.tools.openScope({ scopeId: 'unicode', workspacePath: f.directory })
    const output = await drain(scope, await finish(scope.execute( {
      command: nodeCommand("process.stdout.write(JSON.stringify({text:'你好 🌏', cwd:process.cwd()})); process.stderr.write('error-stream');"), yieldTimeMs: 10,
    })))
    assert.equal(output.exit_code, 0)
    assert.ok(output.output.includes('你好 🌏'))
    assert.ok(output.output.includes('error-stream'))
    assert.ok(output.output.includes(JSON.stringify(f.directory).slice(1, -1)))
    assert.equal((await finish(scope.close())).cleanup, 'completed')
  } finally { await f.close() }
})

test('an explicitly selected shell preserves command quoting and explicit exit status', async () => {
  const f = await fixture()
  try {
    const scope = f.tools.openScope({ scopeId: 'explicit-shell', workspacePath: f.directory })
    const commands = process.platform === 'win32'
      ? [{ shell: 'cmd', command: 'echo "a b" & exit /b 7', expected: '"a b"' },
        { shell: 'pwsh', command: "Write-Output 'a b'; exit 7", expected: 'a b' }]
      : [{ shell: 'bash', command: "printf 'a b'; exit 7", expected: 'a b' }]
    for (const command of commands) {
      const output = await drain(scope, await finish(scope.execute( { shell: command.shell, command: command.command, yieldTimeMs: 10 })))
      assert.equal(output.output.trim(), command.expected)
      assert.equal(output.exit_code, 7)
    }
    assert.equal((await finish(scope.close())).cleanup, 'completed')
  } finally { await f.close() }
})
test('native pipe sessions preserve stdin and isolate cancellation between sessions', async () => {
  const f = await fixture()
  try {
    const scope = f.tools.openScope({ scopeId: 'stdin', workspacePath: f.directory })
    const script = "process.stdin.once('data', bytes=>{process.stdout.write('got:'+bytes.toString());process.exit(0)}); process.stdout.write('ready:');"
    const first = await finish(scope.execute( { command: nodeCommand(script), yieldTimeMs: 10 }))
    assert.equal(typeof first.session_id, 'number')
    const secondCall = scope.execute( { command: nodeCommand("setInterval(()=>{},1000)"), yieldTimeMs: 10 })
    const second = await finish(secondCall)
    secondCall.cancel()
    const answer = await finish(scope.write( { sessionId: first.session_id, chars: '回答\n', yieldTimeMs: 100 }))
    const observed = await drain(scope, { ...answer, session_id: answer.session_id, output: first.output + answer.output })
    assert.equal(observed.output, 'ready:got:回答\n')
    assert.equal(observed.exit_code, 0)
    assert.equal((await finish(scope.close())).cleanup, 'completed')
    assert.equal(typeof second.session_id, 'number')
  } finally { await f.close() }
})
test('Run cleanup waits for native child processes and preserves other Run scopes', async () => {
  const f = await fixture()
  try {
    const a = f.tools.openScope({ scopeId: 'a', workspacePath: f.directory }), b = f.tools.openScope({ scopeId: 'b', workspacePath: f.directory })
    const code = "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync('child.pid',String(c.pid));setInterval(()=>{},1000)"
    await finish(a.execute( { command: nodeCommand(code), yieldTimeMs: 10 }))
    const childPid = Number(await untilFile(join(f.directory, 'child.pid')))
    const other = await finish(b.execute( { command: nodeCommand("process.stdin.once('data',()=>{process.stdout.write('survived');process.exit()})"), yieldTimeMs: 10 }))
    assert.equal((await finish(a.close())).cleanup, 'completed')
    assert.throws(() => process.kill(childPid, 0), error => error.code === 'ESRCH')
    const value = await drain(b, await finish(b.write( { sessionId: other.session_id, chars: 'finish\n', yieldTimeMs: 100 })))
    assert.equal(value.output, 'survived')
    assert.equal((await finish(b.close())).cleanup, 'completed')
  } finally { await f.close() }
})
test('repeated native group exits retain ownership until both parent and child are absent', { timeout: 20000 }, async () => {
  const f = await fixture()
  try {
    // On macOS a group can transiently contain only exiting/zombie members.
    // Every iteration still requires the native cleanup receipt and actual PID
    // absence; neither a signal error nor an initial parent exit proves cleanup.
    for (let index = 0; index < 24; index++) {
      const scope = f.tools.openScope({ scopeId: `group-exit-${index}`, workspacePath: f.directory })
      const marker = `group-exit-${index}.json`
      const code = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000)`
      await finish(scope.execute({ command: nodeCommand(code), yieldTimeMs: 0 }))
      const pids = JSON.parse(await untilFile(join(f.directory, marker)))
      for (const pid of pids) process.kill(pid, 0)
      const closed = await finish(scope.close())
      assert.equal(closed.cleanup, 'completed')
      for (const pid of pids) assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH')
    }
  } finally { await f.close() }
})
test('explicit Bash remains Bash on all native platforms', async () => {
  const f = await fixture()
  try {
    const value = await finish(f.bash.execute({ workspacePath: f.directory, command: "printf '%s' \"${BASH_VERSION%%.*}\"; printf '你好'; exit 7" }))
    assert.equal(value.exitCode, 7)
    assert.match(value.stdout, /^\d+你好$/)
  } finally { await f.close() }
})

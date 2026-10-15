import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@nya/core'
import { prepareShellCommand, toolEnvironment, bashExecutable } from '../dist/platform/shell.js'
import { toolEnvironmentPrompt } from '../dist/applications/harness/core/tool/environment.js'
import { projectServiceKey } from '../dist/applications/harness/core/project/component.js'
import { createProcessToolsComponent, processToolsServiceKey } from '../dist/applications/harness/core/tool/process-component.js'
import { createBashComponent, bashServiceKey } from '../dist/applications/harness/core/tool/bash-component.js'

function nodeCommand(script) {
  const encoded = Buffer.from(script).toString('base64')
  const code = `eval(Buffer.from('${encoded}','base64').toString())`
  const quote = value => process.platform === 'win32' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`
  return `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} -e ${quote(code)}`
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-native-tools-中文 ')), root = new Context()
  try {
    await root.installComponent({ name: 'native-test-projects', apply(ctx) { ctx.provide(projectServiceKey, { async requireAvailable() { return { path: directory } } }) } })
    await root.installComponent(createProcessToolsComponent({ terminationGraceMs: 100, timeoutMs: 10_000 }))
    await root.installComponent(createBashComponent({ terminationGraceMs: 100 }))
    return { directory, root, tools: root.get(processToolsServiceKey), bash: root.get(bashServiceKey), async close() { try { await root.fiber.dispose() } finally { await rm(directory, { recursive: true, force: true }) } } }
  } catch (error) { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }); throw error }
}
async function finish(call) { try { return await call.result } finally { await call.done } }
async function drain(scope, first) {
  let result = first, output = first.output
  for (let attempts = 0; result.session_id && attempts < 100; attempts++) {
    result = await finish(scope.execute('codex_write_stdin', { session_id: first.session_id, yield_time_ms: 100 }))
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
    const scope = f.tools.openRun({ runId: 'unicode', projectId: 'project' })
    const output = await drain(scope, await finish(scope.execute('codex_exec_command', {
      cmd: nodeCommand("process.stdout.write(JSON.stringify({text:'你好 🌏', cwd:process.cwd()})); process.stderr.write('error-stream');"), yield_time_ms: 10,
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
    const scope = f.tools.openRun({ runId: 'explicit-shell', projectId: 'project' })
    const commands = process.platform === 'win32'
      ? [{ shell: 'cmd', cmd: 'echo "a b" & exit /b 7', expected: '"a b"' },
        { shell: 'pwsh', cmd: "Write-Output 'a b'; exit 7", expected: 'a b' }]
      : [{ shell: 'bash', cmd: "printf 'a b'; exit 7", expected: 'a b' }]
    for (const command of commands) {
      const output = await drain(scope, await finish(scope.execute('codex_exec_command', { shell: command.shell, cmd: command.cmd, yield_time_ms: 10 })))
      assert.equal(output.output.trim(), command.expected)
      assert.equal(output.exit_code, 7)
    }
    assert.equal((await finish(scope.close())).cleanup, 'completed')
  } finally { await f.close() }
})
test('native pipe sessions preserve stdin and isolate cancellation between sessions', async () => {
  const f = await fixture()
  try {
    const scope = f.tools.openRun({ runId: 'stdin', projectId: 'project' })
    const script = "process.stdin.once('data', bytes=>{process.stdout.write('got:'+bytes.toString());process.exit(0)}); process.stdout.write('ready:');"
    const first = await finish(scope.execute('codex_exec_command', { cmd: nodeCommand(script), yield_time_ms: 10 }))
    assert.equal(typeof first.session_id, 'number')
    const secondCall = scope.execute('codex_exec_command', { cmd: nodeCommand("setInterval(()=>{},1000)"), yield_time_ms: 10 })
    const second = await finish(secondCall)
    secondCall.cancel()
    const answer = await finish(scope.execute('codex_write_stdin', { session_id: first.session_id, chars: '回答\n', yield_time_ms: 100 }))
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
    const a = f.tools.openRun({ runId: 'a', projectId: 'project' }), b = f.tools.openRun({ runId: 'b', projectId: 'project' })
    const code = "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync('child.pid',String(c.pid));setInterval(()=>{},1000)"
    await finish(a.execute('codex_exec_command', { cmd: nodeCommand(code), yield_time_ms: 10 }))
    const childPid = Number(await untilFile(join(f.directory, 'child.pid')))
    const other = await finish(b.execute('codex_exec_command', { cmd: nodeCommand("process.stdin.once('data',()=>{process.stdout.write('survived');process.exit()})"), yield_time_ms: 10 }))
    assert.equal((await finish(a.close())).cleanup, 'completed')
    assert.throws(() => process.kill(childPid, 0), error => error.code === 'ESRCH')
    const value = await drain(b, await finish(b.execute('codex_write_stdin', { session_id: other.session_id, chars: 'finish\n', yield_time_ms: 100 })))
    assert.equal(value.output, 'survived')
    assert.equal((await finish(b.close())).cleanup, 'completed')
  } finally { await f.close() }
})
test('explicit Bash remains Bash on all native platforms', async () => {
  const f = await fixture()
  try {
    const value = await finish(f.bash.execute({ projectId: 'project', command: "printf '%s' \"${BASH_VERSION%%.*}\"; printf '你好'; exit 7" }))
    assert.equal(value.exitCode, 7)
    assert.match(value.stdout, /^\d+你好$/)
  } finally { await f.close() }
})

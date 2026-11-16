import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerApplicationClis, parseCli, runApplicationCli, cliExit, cliFailure } from '../dist/cli.js'

function fixture() {
  let loads = 0, calls = 0, stdout = '', stderr = ''
  const command = { name: 'demo', description: 'Demo app', options: [{ name: 'target', type: 'string', description: 'Target' }], commands: [
    { name: 'show', description: 'Show item', arguments: [{ name: 'id', description: 'Item', required: true }], options: [{ name: 'flag', type: 'boolean', description: 'Flag' }] },
  ] }
  const registrations = [{ contractVersion: 1, appId: 'app-demo', command, load: async () => { loads++; return { execute: async (invocation, context) => { calls++; await context.emit({ path: invocation.path, args: invocation.arguments, options: invocation.options }); } } } }]
  const io = { stdin: (async function* () {})(), stdout: async s => { stdout += s }, stderr: async s => { stderr += s }, env: {}, cwd: '/tmp', signal: new AbortController().signal }
  return { command, registrations, io, get loads() { return loads }, get calls() { return calls }, get stdout() { return stdout }, get stderr() { return stderr } }
}
test('CLI registration rejects collisions, invalid metadata and unsupported contracts', () => {
  const f = fixture(), r = f.registrations[0]
  for (const registrations of [[r, r], [{ ...r, contractVersion: 2 }], [{ ...r, command: { ...r.command, name: 'help' } }],
    [{ ...r, command: { ...r.command, options: [{ name: 'json', type: 'boolean', description: 'collision' }] } }]]) assert.throws(() => registerApplicationClis(registrations))
  assert.throws(() => registerApplicationClis([r], ['demo']))
  const captured = registerApplicationClis([r]); r.command.name = 'changed'
  assert.equal(captured[0].command.name, 'demo'); assert.ok(Object.isFrozen(captured[0].command))
})
test('help, version, completion and absent apps never load execution code', async () => {
  for (const args of [[], ['--help'], ['demo', 'show', '--help', '--json'], ['help', 'demo'], ['--version', '--json'], ['completion', 'demo', '--json'], ['missing', '--json']]) {
    const f = fixture()
    const code = await runApplicationCli(args, f.registrations, f.io, { version: 'test' })
    assert.equal(code, args[0] === 'missing' ? cliExit.usage : 0); assert.equal(f.loads, 0); assert.equal(f.calls, 0)
  }
})
test('parser supports inherited options, equals syntax, aliases and literal positional input', () => {
  const f = fixture(), root = { name: 'anybox', description: 'root', commands: [f.command] }
  const parsed = parseCli(['--json', 'demo', '--target=local', 'show', '--flag', '--', '--secret'], root)
  assert.deepEqual(parsed.invocation.path, ['demo', 'show']); assert.deepEqual(parsed.invocation.arguments, ['--secret'])
  assert.equal(parsed.invocation.options.target, 'local'); assert.equal(parsed.invocation.options.flag, true)
  assert.equal(parseCli(['demo', 'show', '-h'], root).help, true)
})
test('invalid options and arity are usage errors, do not echo raw token arguments or load modules', async () => {
  for (const args of [['demo', 'show'], ['demo', 'show', 'one', 'two'], ['demo', '--token=TOPSECRET'], ['demo', '--target'],
    ['demo', 'show', 'id', '--flag=false'], ['demo', '--target=x', '--target=y', 'show', 'id'], ['demo', 'show', 'id', '--unknown']]) {
    const f = fixture()
    assert.equal(await runApplicationCli([...args, '--json'], f.registrations, f.io, { version: 'test' }), 2)
    assert.equal(f.loads, 0); assert.equal(f.stdout, ''); assert.doesNotMatch(f.stderr, /TOPSECRET/)
    const result = JSON.parse(f.stderr); assert.equal(result.type, 'error'); assert.equal(result.error.exitCode, 2)
  }
})
test('JSON execution uses stdout NDJSON and one lazy module, error codes remain structured', async () => {
  const f = fixture()
  assert.equal(await runApplicationCli(['demo', 'show', 'id', '--json'], f.registrations, f.io, { version: 'test' }), 0)
  assert.equal(f.loads, 1); assert.equal(f.calls, 1); assert.equal(f.stderr, '')
  assert.equal(JSON.parse(f.stdout).schemaVersion, 1)
  for (const exitCode of Object.values(cliExit).filter(code => code !== 0)) {
    const g = fixture(); g.registrations[0].load = async () => ({ execute: async () => { throw cliFailure('expected', 'Safe error', exitCode) } })
    assert.equal(await runApplicationCli(['demo', 'show', 'id', '--json'], g.registrations, g.io, { version: 'test' }), exitCode)
    assert.equal(JSON.parse(g.stderr).error.exitCode, exitCode)
  }
})
test('unknown errors are sanitized and aborted execution does not load the app', async () => {
  const f = fixture(); f.registrations[0].load = async () => { throw new Error('SECRET') }
  assert.equal(await runApplicationCli(['demo', 'show', 'id', '--json'], f.registrations, f.io, { version: 'test' }), 1)
  assert.doesNotMatch(f.stderr, /SECRET/)
  const g = fixture(), controller = new AbortController(); controller.abort()
  assert.equal(await runApplicationCli(['demo', 'show', 'id'], g.registrations, { ...g.io, signal: controller.signal }, { version: 'test' }), 130)
  assert.equal(g.loads, 0)
})

test('standalone mount keeps the same execution path and inherits completion options', async () => {
  const f = fixture()
  assert.equal(await runApplicationCli(['show', 'id', '--json'], f.registrations, f.io, { name: 'demo-cli', application: 'demo', version: 'test' }), 0)
  assert.deepEqual(JSON.parse(f.stdout).data.path, ['demo', 'show'])
  const g = fixture()
  assert.equal(await runApplicationCli(['completion', 'show', '--json'], g.registrations, g.io, { application: 'demo', version: 'test' }), 0)
  assert.ok(JSON.parse(g.stdout).data.includes('--target')); assert.equal(g.loads, 0)
  const h = fixture()
  assert.equal(await runApplicationCli(['show', '--help'], h.registrations, h.io, { name: 'demo-cli', application: 'demo', version: 'test' }), 0)
  assert.match(h.stdout, /Usage: demo-cli show/); assert.doesNotMatch(h.stdout, /demo-cli demo/)
})

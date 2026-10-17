import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fork } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const preload = new URL('./helpers/client-role-process.mjs', import.meta.url).href
function launch(entry, args, directory, guard = 'client') {
  const child = fork(fileURLToPath(new URL(`../dist/entrypoints/${entry}.js`, import.meta.url)), args, {
    cwd: directory, execArgv: ['--import', preload], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, ANYBOX_TEST_ROLE_GUARD: guard, ANYBOX_WEB_PORT: '0', ANYBOX_CLIENT_DATABASE: join(directory, 'client.sqlite'),
      ANYBOX_HARNESS_DATABASE: join(directory, 'harness.sqlite'), ANYBOX_MODELS_CONFIG: join(directory, 'models.json'),
      ANYBOX_MODELS_DATABASE: join(directory, 'models.sqlite'), ANYBOX_MODELS_CATALOG_DATABASE: join(directory, 'catalog.sqlite'),
      ANYBOX_LLM_API: 'not-a-protocol-client-must-not-parse', ANYBOX_COMPUTER_UNIT: 'invalid-client-must-ignore' },
  })
  let output = ''
  child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })) })
  const ready = new Promise((resolve, reject) => {
    child.on('message', message => { if (message?.type === 'ready') resolve(message) })
    exited.then(() => reject(new Error(output || 'Exited before ready')), reject)
  })
  void ready.catch(() => {})
  return { child, exited, ready, output: () => output }
}

for (const [entry, args] of [['client-main', []], ['anybox-main', ['client']]]) {
  test(`${entry} opens only the client, including application restore, with no executor imports or subprocesses`, { timeout: 20000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'anybox-role-client-'))
    let process
    t.after(async () => { if (process?.child.exitCode === null) { process.child.kill('SIGKILL'); await process.exited } await rm(directory, { recursive: true, force: true }) })
    for (let pass = 0; pass < 2; pass++) {
      process = launch(entry, args, directory)
      const { url, role } = await process.ready
      assert.equal(role, 'client')
      const open = await fetch(`${url}/api/client/v1/products/agent/open`, { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' }, body: '{}' })
      assert.equal(open.status, 200, await open.text())
      const local = await (await fetch(`${url}/api/client/v1/local`)).json()
      assert.equal(local.instanceId, null)
      assert.deepEqual(await (await fetch(`${url}/api/client/v1/connections`)).json(), [])
      const computer = await fetch(`${url}/api/client/v1/apps/agent/computer/status`)
      assert.equal(computer.status, 200, await computer.clone().text())
      assert.deepEqual(await computer.json(), { state: 'stopped', supported: globalThis.process.platform !== 'win32', attachments: [] })
      assert.equal((await fetch(`${url}/api/client/v1/local/retry`, { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' }, body: '{}' })).status, 403)
      assert.ok((await readdir(directory)).every(name => name.startsWith('client.sqlite')), 'only the client database may exist')
      process.child.send('test-stop')
      assert.equal((await process.exited).code, 0, process.output())
      await assert.rejects(fetch(url))
    }
  })
}

test('role help and an unknown role do not load service runtimes or create files', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-role-help-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const args of [[], ['--help'], ['client', '--help'], ['harness-server', '--help'], ['computer-worker', '--help'], ['unknown']]) {
    const process = launch('anybox-main', args, directory, 'help')
    // No service owns the IPC channel in a help-only invocation.
    process.child.disconnect()
    assert.equal((await process.exited).code, args[0] === 'unknown' ? 1 : 0, process.output())
    assert.match(process.output(), /Usage: anybox/)
    assert.deepEqual(await readdir(directory), [])
  }
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fork } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

for (const local of [false, true]) test(`desktop main ${local ? '--local explicitly combines roles' : 'starts client-only and enables the server only on request'}`, { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-desktop-main-'))
  const child = fork(fileURLToPath(new URL('../packages/distribution/dist/entrypoints/desktop-main.js', import.meta.url)), local ? ['--local'] : [], {
    cwd: directory, execArgv: ['--import', new URL('./helpers/desktop-main-preload.mjs', import.meta.url).href],
    env: { ...process.env, ANYBOX_DESKTOP_USER_DATA: directory, ANYBOX_DESKTOP_SMOKE: '0', ANYBOX_TEST_FAIL_EXECUTION_FORK: local ? '0' : '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  let output = ''
  child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)) })
  const message = type => new Promise((resolve, reject) => {
    const listener = value => { if (value.type === type) { child.removeListener('message', listener); resolve(value) } }
    child.on('message', listener); exited.then(() => { child.removeListener('message', listener); reject(new Error(output || `Exited before ${type}`)) }, reject)
  })
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGKILL'); await exited } await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) })
  const ready = await message('ready')
  assert.deepEqual(ready.services.map(service => service.kind).sort(), local ? ['client', 'execution'] : ['client'])
  const client = ready.services.find(service => service.kind === 'client'), url = client.url
  const headers = { Origin: url, 'Content-Type': 'application/json', 'X-Anybox-Desktop-Transport': client.transportSecret }
  const response = await fetch(`${url}/api/client/v1/products/agent/open`, { method: 'POST', headers, body: '{}' })
  assert.equal(response.status, 200, await response.text())
  if (!local) {
    for (let i = 0; i < 3; i++) {
      const status = await (await fetch(`${url}/api/client/v1/local`, { headers })).json()
      assert.equal(status.status.state, 'disabled')
    }
    assert.ok((await readdir(join(directory, 'data'))).every(name => name.startsWith('client.sqlite')))
    const start = () => fetch(`${url}/api/client/v1/local/retry`, { method: 'POST', headers, body: '{}' }).then(response => response.json())
    assert.equal((await start()).state, 'failed', 'a native fork error must leave the client available for retry')
    assert.ok((await readdir(join(directory, 'data'))).every(name => name.startsWith('client.sqlite')))
    const results = await Promise.all([start(), start()])
    assert.ok(results.every(result => result.state === 'ready'), JSON.stringify(results))
  }
  const checking = message('snapshot'); child.send('test-snapshot')
  const state = await checking
  assert.deepEqual(state.services.map(service => service.kind).sort(), ['client', 'execution'])
  assert.equal(new Set(state.services.map(service => service.pid)).size, 2)
  assert.ok(!(await readdir(join(directory, 'data'))).some(name => name.includes('computer-worker')))
  const closing = message('closed'); child.send('test-quit')
  assert.ok((await closing).services.every(service => service.exited))
  assert.equal(await exited, 0, output)
  await assert.rejects(fetch(url))
})

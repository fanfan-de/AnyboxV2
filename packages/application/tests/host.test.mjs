import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { workspace, waitFor } from './helpers.mjs'

function launch(t, args) {
  const child = spawn(process.execPath, [join(workspace, 'examples/host.mjs'), ...args], {
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  const ready = new Promise(resolve => child.on('message', message => { if (message.type === 'ready') resolve() }))
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited
  })
  return { child, exited, ready, output: () => output }
}

test('the normal host starts its components and exits after cleanup', { timeout: 10_000 }, async t => {
  const host = launch(t, ['--once'])
  const result = await waitFor(host.exited, t.signal)
  assert.equal(result.code, 0, host.output())
  assert.match(host.output(), /application started/)
})

test('the development host closes its watchers after a host shutdown request', { timeout: 10_000 }, async t => {
  const host = launch(t, ['--dev'])
  await waitFor(Promise.race([
    host.ready,
    host.exited.then(result => { throw new Error(`host exited before ready: ${result.code}\n${host.output()}`) }),
  ]), t.signal)
  assert.match(host.output(), /application started/)
  host.child.send('close')
  const result = await waitFor(host.exited, t.signal)
  assert.equal(result.code, 0, host.output())
  assert.match(host.output(), /HMR applied/)
})

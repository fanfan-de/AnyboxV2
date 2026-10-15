import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

const run = promisify(execFile)
const helper = fileURLToPath(new URL('../dist/desktop/native/anybox-dialog-host.exe', import.meta.url))
const invoke = async args => (await run(helper, args, { windowsHide: true })).stdout.trim()

test('Windows native dialog cancellation validates its version and rejects invalid owner identities', { skip: process.platform !== 'win32' }, async () => {
  assert.equal(await invoke(['--version']), 'anybox-dialog-host 1')
  for (const args of [[], ['1'], ['0', '0'], ['1', String(process.pid)], ['abc', '1'], ['-1', '1'], ['+1', '1'], ['1', '4294967296'], ['18446744073709551616', '1']]) {
    assert.equal(await invoke(args), 'false', JSON.stringify(args))
  }
})

test('Windows native dialog cancellation closes only the standard dialog of the exact live owner process and window', { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
  const fixture = fileURLToPath(new URL('./helpers/windows-dialog-fixture.ps1', import.meta.url))
  const child = spawn(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited }
  })
  let error = ''
  child.stderr.on('data', chunk => { error += chunk })
  const lines = createInterface({ input: child.stdout }), messages = []
  lines.on('line', line => messages.push(JSON.parse(line)))
  async function until(predicate) {
    const deadline = Date.now() + 5000
    while (!predicate()) {
      assert.equal(child.exitCode, null, error)
      assert.ok(Date.now() < deadline, `Windows fixture did not reach expected state: ${error}`)
      await delay(10)
    }
  }
  await until(() => messages.some(message => message.owner))
  const identity = messages.find(message => message.owner)
  assert.equal(await invoke([identity.owner, String(process.pid)]), 'false', 'another process cannot be named as this owner')
  assert.equal(await invoke(['1', String(identity.pid)]), 'false', 'a nonexistent owner does not enumerate other windows')
  assert.equal(await invoke([identity.owner, String(identity.pid)]), 'true')
  await until(() => messages.some(message => message.closed === 'target-dialog'))
  assert.equal(await invoke([identity.owner, String(identity.pid)]), 'false', 'the remaining same-process dialog has a different owner')
  await delay(50)
  assert.deepEqual(messages.filter(message => message.closed).map(message => message.closed), ['target-dialog'], 'the owner, other owner dialog and non-dialog child never receive WM_CLOSE')
})

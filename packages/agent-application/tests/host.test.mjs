import assert from 'node:assert/strict'
import test from 'node:test'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { fixture } from './helpers.mjs'

async function host(f) {
  const child = fork(new URL('../../../examples/agent-application-host.mjs', import.meta.url), ['--data', f.path, '--port', '0'],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  f.releases.push(() => child.kill('SIGKILL'))
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`host startup timed out: ${stderr}`)), 8000)
    child.once('message', value => { clearTimeout(timer); resolve(value) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`host exited ${code}: ${stderr}`)) })
    child.once('error', reject)
  })
  return { child, url: `http://127.0.0.1:${ready.port}`, async close() {
    const exited = once(child, 'exit'); child.send('close'); const [code] = await exited
    assert.equal(code, 0, stderr)
  } }
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

test('backend remains available without stdin and restores API history across host processes', { timeout: 15000 }, async t => {
  const f = await fixture(t), first = await host(f)
  const health = await (await fetch(`${first.url}/health`)).json()
  assert.equal(health.ready, true)
  const sessionResponse = await post(`${first.url}/sessions`, {})
  assert.equal(sessionResponse.status, 201)
  const session = await sessionResponse.json()
  const input = { sessionId: session.id, expectedSessionVersion: session.version, requestKey: 'http-task', input: [{ type: 'text', text: 'hello backend' }] }
  const acceptance = await post(`${first.url}/tasks`, input)
  assert.equal(acceptance.status, 202)
  const accepted = await acceptance.json()
  // The host owns graceful cancellation/settlement; records must survive regardless of completion timing.
  const inspection = await (await fetch(`${first.url}/tasks/${accepted.runId}`)).json()
  assert.equal(inspection.run.id, accepted.runId)
  const malformed = await post(`${first.url}/tasks`, { input: [] })
  assert.equal(malformed.status, 400)
  const denied = await fetch(`${first.url}/sessions`, { method: 'POST', headers: { Origin: 'https://example.invalid', 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(denied.status, 403)
  await first.close()
  const second = await host(f)
  const current = await (await fetch(`${second.url}/health`)).json()
  assert.equal(current.agent.id, health.agent.id)
  assert.notEqual(current.agent.generation, health.agent.generation)
  const retry = await post(`${second.url}/tasks`, input)
  assert.equal(retry.status, 202)
  assert.deepEqual(await retry.json(), accepted)
  const history = await (await fetch(`${second.url}/sessions/${session.id}/messages`)).json()
  assert.equal(history.messages[0].content[0].text, 'hello backend')
  const tasks = await (await fetch(`${second.url}/tasks`)).json()
  assert.equal(tasks.length, 1)
  await second.close()
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fork, execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { copyApplicationClosure } from './helpers/isolated-application.mjs'

const execFile = promisify(execFileCallback)
async function stream(response) {
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/event-stream/)
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = ''
  return { async next() {
    for (;;) {
      const boundary = buffer.indexOf('\n\n')
      if (boundary >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
        const event = /^event: (.+)$/m.exec(frame)?.[1]
        if (event) return { event, data: JSON.parse(/^data: (.+)$/m.exec(frame)[1]) }
        continue
      }
      const chunk = await reader.read()
      if (chunk.done) throw new Error('SSE ended before a frame arrived')
      buffer += decoder.decode(chunk.value, { stream: true })
    }
  }, close: () => reader.cancel().catch(() => {}) }
}

for (const [application, packageName, binary] of [['agent', '@anybox/app-harness', 'anybox-harness-server'], ['claude-agent', '@anybox/app-claude-agent', 'anybox-claude-agent']]) {
  test(`${packageName} serves authenticated business requests and SSE and exits from only its physical dependency closure`, { timeout: 45_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), `anybox-isolated-${application}-`))
    let child, events
    t.after(async () => {
      await events?.close()
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited
      }
      await rm(directory, { recursive: true, force: true })
    })
    await copyApplicationClosure(packageName, directory)
    const manifest = JSON.parse(await readFile(join(directory, 'node_modules', packageName, 'package.json'), 'utf8'))
    assert.ok(manifest.bin[binary])
    const binaryPath = join(directory, 'node_modules', packageName, manifest.bin[binary])
    const environment = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', STANDALONE_APPLICATION: application }
    const help = await execFile(process.execPath, [binaryPath, '--help'], { cwd: directory, env: environment })
    assert.match(help.stdout, /serve/)
    // The installed entry performs authentication bootstrap without the host or other application.
    const initialized = await execFile(process.execPath, [binaryPath, 'init', 'CLI device'], { cwd: directory,
      env: { ...environment, ANYBOX_HARNESS_DATABASE: join(directory, 'cli.sqlite') } })
    assert.match(initialized.stdout, /Access token \(shown once\): [0-9a-f-]+\.[A-Za-z0-9_-]+/)
    await cp(new URL('./helpers/standalone-application-process.mjs', import.meta.url), join(directory, 'fixture.mjs'))
    child = fork(join(directory, 'fixture.mjs'), [], { cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Standalone startup timed out: ${output}`)), 20_000)
      child.on('message', message => { if (message.type === 'ready') { clearTimeout(timer); resolve(message) } })
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`Standalone startup exited: ${output}`)) })
    })
    const headers = { Authorization: `Bearer ${ready.token}`, 'X-Anybox-Instance-Id': ready.instanceId, 'Content-Type': 'application/json' }
    const request = (path, body) => fetch(ready.url + path, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) })
    const apiBase = `/api/v1/apps/${application}`
    const api = async (path, body) => { const response = await request(apiBase + path, body); const data = await response.json(); assert.equal(response.status < 300, true, JSON.stringify(data)); return data }
    assert.equal((await fetch(ready.url + '/api/v1/instance')).status, 401)
    assert.equal((await (await request('/api/v1/instance')).json()).instanceId, ready.instanceId)
    assert.equal((await fetch(ready.url + apiBase + '/missing', { headers: { Authorization: headers.Authorization } })).status, 409)
    assert.equal((await request('/api/v1/products')).status, 404)
    let session
    if (application === 'agent') {
      const project = await api('/projects', { path: ready.projectPath })
      session = await api('/sessions', { projectId: project.id, agentId: 'assistant' })
    } else session = await api('/threads', { projectPath: ready.projectPath, title: 'Isolated thread' })
    events = await stream(await request(`${apiBase}/${application === 'agent' ? 'changes?sessionId=' : 'events?threadId='}${session.id}`))
    assert.equal((await events.next()).event, 'ready')
    const start = (input, key) => api(`/${application === 'agent' ? 'sessions' : 'threads'}/${session.id}/runs`, application === 'agent'
      ? { parentNodeId: null, input, idempotencyKey: key } : { prompt: input, idempotencyKey: key })
    const completed = await start('Hello', 'first')
    const frame = await events.next(); assert.equal(frame.event, 'run-changed'); assert.equal(frame.data.runId, completed.id)
    assert.equal((await api(`/runs/${completed.id}/wait?timeoutMs=5000`)).run.status, 'completed')
    const cancelled = await start('fixture-hold', 'cancelled')
    await api(`/runs/${cancelled.id}/cancel`, {})
    assert.equal((await api(`/runs/${cancelled.id}/wait?timeoutMs=5000`)).run.status, 'cancelled')
    const active = await start('fixture-hold', 'shutdown')
    assert.equal(active.status, 'running')
    // Windows kill('SIGTERM') forcibly terminates Node rather than delivering a signal.
    // Exercise the same fixture shutdown handler over IPC and keep real signals on Unix.
    if (application === 'agent' && process.platform === 'win32') child.send('test-stop')
    else child.kill('SIGTERM')
    assert.deepEqual(await exited, { code: 0, signal: null }, output)
    await assert.rejects(fetch(ready.url + '/api/v1/instance'))
    await events.close(); events = undefined
  })
}

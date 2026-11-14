import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { listTools } from '../packages/app-harness/dist/core/tool/catalog.js'
import { computerToolExecutor, createComputerToolManifest, parseComputerToolManifest } from '../packages/app-harness/dist/core/computer/tool-support.js'
import { createWorkerExecution } from '../packages/app-harness/dist/core/computer/worker-execution.js'

test('the Computer manifest describes implemented current contracts without altering the model catalog', () => {
  const before = structuredClone(listTools()), manifest = createComputerToolManifest()
  assert.equal(manifest.tools.length, 19)
  assert.deepEqual(new Set(manifest.tools.map(tool => tool.toolId)), new Set(before.map(tool => tool.toolId)))
  for (const tool of manifest.tools) {
    const definition = before.find(candidate => candidate.toolId === tool.toolId)
    assert.equal(tool.version, definition.version)
    assert.equal(tool.definitionHash, createHash('sha256').update(JSON.stringify(definition.definition)).digest('hex'))
    assert.equal(tool.executor, computerToolExecutor(definition.definition.name))
  }
  assert.equal(manifest.tools.some(tool => /update_plan|todo/i.test(tool.toolId)), false)
  assert.deepEqual(manifest.constraints, { terminal: 'pipes', independentBackgroundJobs: false,
    filesystemSandbox: false, textEncoding: 'utf-8', imageMediaTypes: ['image/jpeg', 'image/png', 'image/webp'] })
  assert.equal(computerToolExecutor('__proto__'), undefined)
  assert.equal(computerToolExecutor('constructor'), undefined)
  assert.equal(computerToolExecutor('codex_update_plan'), undefined)
  assert.deepEqual(listTools(), before, 'reporting never rewrites definitions or selection')
  assert.ok(Object.isFrozen(manifest) && Object.isFrozen(manifest.tools) && Object.isFrozen(manifest.tools[0]))
  assert.ok(Object.isFrozen(manifest.constraints) && Object.isFrozen(manifest.constraints.imageMediaTypes))
})

test('manifest revisions identify a canonical supported set, including an explicit empty set', () => {
  const ids = ['codex.exec_command', 'codex.write_stdin', 'claude-code.Read']
  const manifest = createComputerToolManifest(ids)
  assert.deepEqual(createComputerToolManifest([...ids].reverse()), manifest)
  assert.notEqual(createComputerToolManifest(['claude-code.Read']).revision, manifest.revision)
  assert.deepEqual(parseComputerToolManifest(JSON.parse(JSON.stringify(manifest))), manifest)
  assert.deepEqual(parseComputerToolManifest(createComputerToolManifest([])).tools, [])
  assert.equal(createComputerToolManifest([]).constraints.filesystemSandbox, false)
  assert.throws(() => createComputerToolManifest(['codex.update_plan']), /unsupported/)
  assert.throws(() => createComputerToolManifest(['claude-code.Read', 'claude-code.Read']), /invalid/)
  const reordered = { constraints: structuredClone(manifest.constraints), tools: [...manifest.tools].reverse(),
    revision: manifest.revision, schemaVersion: 1 }
  assert.deepEqual(parseComputerToolManifest(reordered), manifest)
})

test('remote reports cannot add tools, replace definitions, loosen constraints or supply executable metadata', () => {
  const original = createComputerToolManifest(['claude-code.Read'])
  for (const change of [
    value => { value.schemaVersion = 2 },
    value => { value.revision = '0'.repeat(64) },
    value => { value.tools[0].toolId = 'remote.script' },
    value => { value.tools[0].version = '2.0.0' },
    value => { value.tools[0].definitionHash = '0'.repeat(64) },
    value => { value.tools[0].executor = 'processes' },
    value => { value.tools[0].definition = { name: 'remote_script', parameters: {} } },
    value => { value.tools[0].command = 'run arbitrary code' },
    value => { value.tools.push(value.tools[0]) },
    value => { value.tools = Array(257).fill(value.tools[0]) },
    value => { value.constraints.terminal = 'pty' },
    value => { value.constraints.independentBackgroundJobs = true },
    value => { value.constraints.filesystemSandbox = true },
    value => { value.constraints.imageMediaTypes.push('application/pdf') },
    value => { value.token = 'private' },
  ]) {
    const value = structuredClone(original); change(value)
    assert.equal(parseComputerToolManifest(value), undefined)
  }
  for (const value of [undefined, null, {}, 'all', [], { tools: 'all' }]) assert.equal(parseComputerToolManifest(value), undefined)
  const cyclic = structuredClone(original); cyclic.constraints.imageMediaTypes.push(cyclic)
  assert.equal(parseComputerToolManifest(cyclic), undefined)
  assert.deepEqual(parseComputerToolManifest(original), original)
})

test('the shared binding preserves worker dispatch, workspace ownership and OwnedCall exit semantics', async () => {
  const events = [], cancelled = [], done = Promise.resolve()
  const owned = (kind, input, result) => {
    events.push({ kind, input })
    return { result: Promise.resolve(result), done, cancel: reason => cancelled.push(reason) }
  }
  const execution = createWorkerExecution({ runId: 'run', sessionId: 'session', projectId: 'project', imageInput: true,
    signal: new AbortController().signal,
    bash: { execute: input => owned('bash', input, { stdout: 'bash' }) },
    patch: { execute: input => owned('apply-patch', input, { status: 'applied', changes: [], pending: [] }) },
    processes: { openScope(input) {
      events.push({ kind: 'openScope', input })
      return { execute: input => owned('execute', input, { output: 'process' }),
        write: input => owned('write', input, { output: 'process' }),
        foreground: input => owned('foreground', input, { output: 'foreground' }),
        close: () => owned('close', {}, { cleanup: 'completed', processes: [] }) }
    } },
    files: { execute: input => owned('files', input, { result: { content: 'file' } }) },
  })
  const binding = { path: '/fixed/workspace' }
  const requests = [
    { name: 'bash', arguments: { command: 'echo legacy' } },
    { name: 'apply_patch', arguments: { patch: 'legacy patch' } },
    { name: 'codex_exec_command', arguments: { cmd: 'echo process' } },
    { name: 'codex_write_stdin', arguments: { session_id: 1, chars: 'next' } },
    { name: 'claude_code_Bash', arguments: { command: 'echo foreground', timeout: 100 } },
    { name: 'deepseek_harness_bash', arguments: { description: 'run fixture', command: 'echo deepseek', timeoutMs: 200, workdir: '/other' } },
    { name: 'codex_apply_patch', arguments: { patch: 'new patch' } },
    { name: 'claude_code_Read', arguments: { file_path: 'source.ts' } },
  ]
  assert.equal(execution.hasProcesses(), false)
  for (const request of requests) {
    const call = execution.execute({ id: request.name, ...request }, binding)
    assert.equal(call.done, done)
    assert.equal((await call.result).name, request.name)
    call.cancel(request.name)
  }
  assert.deepEqual(cancelled, requests.map(request => request.name))
  assert.equal(execution.hasProcesses(), true)
  assert.equal(events.filter(event => event.kind === 'openScope').length, 1)
  assert.deepEqual(events.filter(event => event.kind !== 'openScope').map(event => event.kind),
    ['bash', 'apply-patch', 'execute', 'write', 'foreground', 'foreground', 'apply-patch', 'files'])
  for (const event of events.filter(event => ['bash', 'apply-patch', 'openScope', 'files'].includes(event.kind))) {
    assert.equal(event.input.projectId, undefined, 'resource tools do not receive Agent project identities')
    assert.equal(event.input.workspacePath, '/fixed/workspace')
  }
  assert.deepEqual(events.find(event => event.kind === 'execute').input, { command: 'echo process' })
  assert.deepEqual(events.find(event => event.kind === 'write').input, { sessionId: 1, chars: 'next' })
  assert.equal(events.find(event => event.kind === 'files').input.request.operation, 'read')
  assert.equal(events.find(event => event.kind === 'files').input.scopeId, 'session', 'image resources use the owning Session scope at the adapter only')
  assert.deepEqual(events.find(event => event.kind === 'foreground').input, { command: 'echo foreground', timeoutMs: 100 })
  assert.deepEqual(events.filter(event => event.kind === 'foreground')[1].input,
    { command: 'echo deepseek', timeoutMs: 200, workdir: '/other' })
  assert.equal(execution.close().done, done)
})

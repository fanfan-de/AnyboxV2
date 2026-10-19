import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createClaudeAgentSdkComponent } from '../packages/app-claude-agent/dist/core/sdk/adapter.js'
import { availableModelsView } from '../packages/app-claude-agent/dist/core/sdk/models.js'
import { validateRunInput } from '../packages/app-claude-agent/dist/core/domain.js'

const model = { value: 'sonnet[1m]', resolvedModel: 'provider/claude-sonnet@example', displayName: 'Environment Sonnet', description: 'From this device', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }
const exited = pid => { try { process.kill(pid, 0); return false } catch (error) { return error.code === 'ESRCH' } }
async function until(read, label) {
  const deadline = Date.now() + 10_000
  for (;;) {
    const result = await read()
    if (result) return result
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
async function fixture(t, mode = 'reply', options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-claude-models-')), executable = join(directory, 'claude.mjs'), trace = join(directory, 'trace.jsonl')
  // A real child speaking the real SDK control protocol. It never talks to a model service.
  await writeFile(executable, `import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
    const log = value => appendFileSync(${JSON.stringify(trace)}, JSON.stringify(value)+'\\n');
    log({pid:process.pid,cwd:process.cwd(),args:process.argv.slice(2)});process.on('SIGTERM',()=>{});
    setInterval(()=>{},1000);let initializeId;
    for await(const line of createInterface({input:process.stdin})) { const value=JSON.parse(line);log(value);
      if(value.type==='control_request' && value.request.subtype==='initialize') {
        initializeId=value.request_id;
        if(${JSON.stringify(mode)}==='permission') {process.stdout.write(JSON.stringify({type:'control_request',request_id:'catalog-tool',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'echo forbidden'},tool_use_id:'tool-1'}})+'\\n');continue;}
        if(${JSON.stringify(mode)}==='wait')continue;
      } else if(value.type!=='control_response')continue;
      if(initializeId) {
        process.stdout.write(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:initializeId,response:{models:${JSON.stringify(mode === 'overflow' ? [{ ...model, description: 'x'.repeat(5000) }] : [model])},commands:[],agents:[],account:{privateSecret:'never expose'}}}})+'\\n');initializeId=undefined;
      }
    }`)
  const root = new Context()
  t.after(async () => { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await root.installComponent(createClaudeAgentSdkComponent({ executableOverride: executable, modelsTimeoutMs: 10_000, ...options }))
  const lines = async () => { try { return (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) } catch { return [] } }
  const started = () => until(async () => (await lines())[0], 'the discovery child')
  return { root, sdk: root.get('claude-agent.sdk'), directory, trace, lines, started }
}

test('model discovery uses the current environment initialization without a prompt, hides SDK fields and joins its actual child exit', async t => {
  const f = await fixture(t)
  const result = await f.sdk.listAvailableModels(f.directory)
  assert.deepEqual(result, { schemaVersion: 1, models: [model] })
  const records = await f.lines(), startup = records[0]
  assert.equal(startup.cwd, await realpath(f.directory), 'project settings load from the device directory')
  assert.ok(startup.args.includes('--no-session-persistence'))
  assert.ok(startup.args.includes('--strict-mcp-config'))
  assert.ok(startup.args.includes('--tools='))
  // The requested masks suppress discretionary hooks. An administrator's policy may reject the parent mask.
  for (const flag of ['--settings', '--managed-settings']) assert.equal(JSON.parse(startup.args[startup.args.indexOf(flag) + 1]).disableAllHooks, true)
  assert.ok(records.length >= 2)
  assert.ok(records.slice(1).every(value => value.type === 'control_request'), 'no user prompt or model turn is submitted')
  assert.equal(exited(startup.pid), true, 'the promise settles after the actual process exit')
  assert.deepEqual(validateRunInput({ prompt: 'hello', idempotencyKey: 'model', model: model.value }).model, model.value, 'advertised long context aliases can be executed')
  assert.equal(validateRunInput({ prompt: 'hello', idempotencyKey: 'provider', model: model.resolvedModel }).model, model.resolvedModel)
})
test('JavaScript SDK entrypoints use the running Node interpreter when PATH contains no node launcher', async t => {
  const f = await fixture(t, 'reply', { env: { ...process.env, PATH: '', Path: '' } })
  assert.deepEqual(await f.sdk.listAvailableModels(f.directory), { schemaVersion: 1, models: [model] })
  assert.equal(exited((await f.started()).pid), true, 'the exact interpreter is joined through actual child exit')
})

test('unexpected tool permission requests during discovery are denied without asking the user', async t => {
  const f = await fixture(t, 'permission')
  assert.deepEqual(await f.sdk.listAvailableModels(f.directory), { schemaVersion: 1, models: [model] })
  const answer = (await f.lines()).find(value => value.type === 'control_response' && value.response.request_id === 'catalog-tool')
  assert.equal(answer.response.response.behavior, 'deny')
  assert.match(answer.response.response.message, /does not execute tools/)
})
test('discovery cancellation kills and joins a child stuck before initialization', async t => {
  const f = await fixture(t, 'wait'), controller = new AbortController()
  const pending = f.sdk.listAvailableModels(f.directory, controller.signal)
  const failure = assert.rejects(pending, error => error.code === 'cancelled' && error.status === 499)
  const startup = await f.started()
  controller.abort(); await failure
  assert.equal(exited(startup.pid), true)
})
test('the discovery deadline terminates the process and reports a retryable timeout', async t => {
  const f = await fixture(t, 'wait', { modelsTimeoutMs: 500 })
  const pending = f.sdk.listAvailableModels(f.directory)
  const failure = assert.rejects(pending, error => error.code === 'models-timeout' && error.status === 504)
  await failure
  // A heavily loaded test host may time out before the child executes its first line. Any child that did start has exited.
  const startup = (await f.lines())[0]
  if (startup) assert.equal(exited(startup.pid), true)
})
test('adapter shutdown cancels discovery, waits for exit and prevents new discovery admission', async t => {
  const f = await fixture(t, 'wait')
  const pending = f.sdk.listAvailableModels(f.directory), failure = assert.rejects(pending, error => error.status === 503)
  const startup = await f.started()
  await f.root.fiber.dispose(); await failure
  assert.equal(exited(startup.pid), true)
  await assert.rejects(f.sdk.listAvailableModels(f.directory), error => error.code === 'service-unavailable')
})
test('output bounds and invalid project paths fail without leaking or retaining a discovery process', async t => {
  const f = await fixture(t, 'overflow', { modelsLimitBytes: 500 })
  await assert.rejects(f.sdk.listAvailableModels(f.directory), error => error.code === 'models-too-large' && error.status === 413)
  assert.equal(exited((await f.started()).pid), true)
  await assert.rejects(f.sdk.listAvailableModels('relative'), error => error.code === 'project-path-invalid')
  await assert.rejects(f.sdk.listAvailableModels(join(f.directory, 'missing')), error => error.code === 'project-path-missing')
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(f.sdk.listAvailableModels(f.directory, cancelled.signal), error => error.code === 'cancelled')
  assert.equal((await f.lines()).filter(value => value.pid).length, 1, 'invalid or pre-cancelled calls do not spawn')
})
test('model projection deduplicates identities, bounds returned data and omits unsupported SDK metadata', () => {
  assert.deepEqual(availableModelsView([{ ...model, account: 'private' }, { ...model, displayName: 'duplicate' }]), { schemaVersion: 1, models: [model] })
  assert.deepEqual(availableModelsView([]), { schemaVersion: 1, models: [] }, 'an empty environment list is not replaced with guessed models')
  assert.throws(() => availableModelsView(Array.from({ length: 201 }, () => model)), error => error.code === 'models-too-large')
  for (const entry of [{ ...model, displayName: 'x'.repeat(201) }, { ...model, description: 'x'.repeat(4001) }, { ...model, value: 'invalid model' }, { ...model, supportedEffortLevels: ['unknown'] }]) {
    assert.throws(() => availableModelsView([entry]), error => error.code === 'models-unavailable')
  }
})

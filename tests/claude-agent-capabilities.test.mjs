import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createClaudeAgentSdkComponent } from '../packages/app-claude-agent/dist/core/sdk/adapter.js'
import { capabilitiesView } from '../packages/app-claude-agent/dist/core/sdk/capabilities.js'
import { createMessageTranslator, permissionRequest, permissionResult } from '../packages/app-claude-agent/dist/core/sdk/translate.js'
import { validateRunControl, validateRunInput } from '../packages/app-claude-agent/dist/core/domain.js'
import { emptyRunView, applyRunEvent } from '../packages/app-claude-agent/dist/core/events.js'
import { createCapabilitiesPanel } from '../packages/app-claude-agent/dist/web/capabilities.js'
import { createPermissionPicker } from '../packages/app-claude-agent/dist/web/permissions.js'
import { renderApproval } from '../packages/app-claude-agent/dist/web/view.js'
import { createRunsFixture, fakeSdk, sampleResult, waitFor } from './helpers/claude-agent.mjs'
import { installClaudeAgentDOM } from './helpers/claude-agent-dom.mjs'

const catalog = { schemaVersion: 1, source: 'run', permissionMode: 'default', skills: [{ name: 'review', description: 'Review changes', argumentHint: '<target>', builtin: false }],
  agents: [{ name: 'Explore', description: 'Find relevant code', model: null }], mcp: [{ name: 'files', status: 'failed', source: 'project', tools: ['read_file'] }] }
const settle = async (f, index, id) => { f.sdk.runs[index].finish({ kind: 'result', result: sampleResult() }); f.sdk.runs[index].exit(); await f.runs.waitRun(id) }

test('mode choices persist per thread, go to the actual run, and live controls are bounded by run/task identity and acknowledgement', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-controls-'))
  const sdk = fakeSdk({ onClose(run) { run.finish({ kind: 'failed', error: { code: 'cancelled', message: 'closed' } }); run.exit() } })
  const original = sdk.port.openRun, controls = []
  let release, fail = false
  sdk.port.listCapabilities = async () => ({ ...catalog, source: 'project' })
  sdk.port.openRun = (...args) => {
    const handle = original(...args)
    handle.capabilities = async () => catalog
    handle.control = async input => { controls.push(input); if (release) await new Promise(done => { release = done }); if (fail) throw new Error('rejected by CLI') }
    return handle
  }
  let f = await createRunsFixture(join(directory, 'index.sqlite'), { sdk, cancel: { interruptTimeoutMs: 1, resultTimeoutMs: 1, exitTimeoutMs: 1 } })
  t.after(async () => { await f.close(); await rm(directory, { recursive: true, force: true }) })
  const a = await f.runs.createThread({ projectPath: '/a' }), b = await f.runs.createThread({ projectPath: '/b' })
  const run = await f.runs.startRun(a.id, { prompt: 'plan', idempotencyKey: 'first', permissionMode: 'plan' })
  assert.equal(sdk.runs[0].request.permissionMode, 'plan')
  assert.equal((await f.runs.capabilities(a.id)).source, 'run')
  await assert.rejects(f.runs.controlRun(run.id, { action: 'stop-task', taskId: 'foreign-task' }), { code: 'task-not-active' })
  sdk.runs[0].hooks.onEvent({ type: 'task', task: { id: 'owned-task', toolUseId: 'agent-tool', status: 'running' } })
  await f.runs.controlRun(run.id, { action: 'stop-task', taskId: 'owned-task' })
  await assert.rejects(f.runs.controlRun(run.id, { action: 'mcp-toggle', name: 'unknown', enabled: true }), { code: 'mcp-not-found' })
  await f.runs.controlRun(run.id, { action: 'mcp-toggle', name: 'files', enabled: false })
  fail = true
  await assert.rejects(f.runs.controlRun(run.id, { action: 'permission-mode', mode: 'acceptEdits' }))
  assert.equal((await f.runs.getThread(a.id)).permissionMode, 'plan', 'a rejected mode must not become a saved preference')
  fail = false; release = true
  const changing = f.runs.controlRun(run.id, { action: 'permission-mode', mode: 'acceptEdits' })
  await waitFor(() => typeof release === 'function')
  assert.equal((await f.runs.getThread(a.id)).permissionMode, 'plan', 'preferences change only after acknowledgement')
  await assert.rejects(f.runs.controlRun(run.id, { action: 'reload-skills' }), { code: 'control-busy' })
  release(); release = undefined; await changing
  assert.equal((await f.runs.getThread(a.id)).permissionMode, 'acceptEdits')
  assert.equal((await f.runs.getThread(b.id)).permissionMode, 'default')
  await settle(f, 0, run.id)
  await assert.rejects(f.runs.controlRun(run.id, { action: 'reload-skills' }), { code: 'run-ended' })
  assert.equal((await f.runs.capabilities(a.id)).source, 'project')
  await f.close()
  f = await createRunsFixture(join(directory, 'index.sqlite'), { sdk, cancel: { interruptTimeoutMs: 1, resultTimeoutMs: 1, exitTimeoutMs: 1 } })
  assert.equal((await f.runs.getThread(a.id)).permissionMode, 'acceptEdits', 'thread preferences survive process restart')
  const next = await f.runs.startRun(a.id, { prompt: 'next', idempotencyKey: 'next' })
  assert.equal(sdk.runs[1].request.permissionMode, 'acceptEdits')
  await settle(f, 1, next.id)
  assert.deepEqual(controls.slice(0, 2), [{ action: 'stop-task', taskId: 'owned-task' }, { action: 'mcp-toggle', name: 'files', enabled: false }])
})

test('capability inspection and controls use the real SDK control protocol and join spawned processes without sending discovery prompts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-capabilities-sdk-')), executable = join(directory, 'claude.mjs'), trace = join(directory, 'trace.jsonl')
  await writeFile(executable, `import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
    const send=v=>process.stdout.write(JSON.stringify(v)+'\\n'); const log=v=>appendFileSync(${JSON.stringify(trace)},JSON.stringify(v)+'\\n');
    log({pid:process.pid,args:process.argv.slice(2)});setInterval(()=>{},1000);
    for await(const line of createInterface({input:process.stdin})){const v=JSON.parse(line);log(v);
      if(v.type==='control_request'){const k=v.request.subtype;let response={};
        if(k==='initialize')response={commands:[{name:'review',description:'Review changes',argumentHint:'<target>'}],agents:[{name:'Explore',description:'Find code'}],models:[]};
        if(k==='mcp_status')response={mcpServers:[{name:'files',status:'connected',config:{type:'http',url:'https://secret.invalid',headers:{Authorization:'SECRET'}},tools:[{name:'read_file'}]}]};
        if(k==='reload_skills')response={skills:[{name:'fresh-skill',description:'Newly discovered',argumentHint:''}]};
        send({type:'control_response',response:{subtype:'success',request_id:v.request_id,response}});
      }
    }`)
  const root = new Context()
  t.after(async () => { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await root.installComponent(createClaudeAgentSdkComponent({ executableOverride: executable }))
  const sdk = root.get('claude-agent.sdk')
  const found = await sdk.listCapabilities(directory)
  assert.equal(found.skills[0].name, 'review'); assert.equal(found.agents[0].name, 'Explore'); assert.deepEqual(found.mcp[0].tools, ['read_file'])
  assert.doesNotMatch(JSON.stringify(found), /SECRET|secret.invalid|Authorization/)
  const lines = () => readFile(trace, 'utf8').then(value => value.trim().split('\n').map(JSON.parse))
  let entries = await lines(), firstPid = entries[0].pid
  assert.throws(() => process.kill(firstPid, 0), { code: 'ESRCH' })
  assert.ok(entries.slice(1).every(value => value.type === 'control_request'), 'discovery sends no user prompt')
  assert.ok(!entries[0].args.includes('--strict-mcp-config'), 'the MCP catalog includes the real environment configuration')
  const events = [], handle = sdk.openRun({ cwd: directory, prompt: 'controlled test', resume: null, permissionMode: 'acceptEdits' }, { onEvent: event => events.push(event), canUseTool: async () => ({ behavior: 'deny', message: 'test' }) })
  assert.equal((await handle.capabilities()).source, 'run')
  for (const input of [{ action: 'permission-mode', mode: 'plan' }, { action: 'reload-skills' }, { action: 'mcp-toggle', name: 'files', enabled: false }, { action: 'mcp-reconnect', name: 'files' }, { action: 'stop-task', taskId: 'task' }]) await handle.control(input)
  assert.equal((await handle.capabilities()).skills[0].name, 'fresh-skill', 'reload uses the acknowledged new skill list rather than stale initialization metadata');
  assert.equal((await handle.capabilities()).permissionMode, 'plan'); assert.ok(events.some(event => event.type === 'permission-mode'))
  handle.close(); await handle.done
  entries = await lines()
  const requests = entries.filter(value => value.type === 'control_request').map(value => value.request.subtype)
  for (const name of ['set_permission_mode', 'reload_skills', 'mcp_toggle', 'mcp_reconnect', 'stop_task']) assert.ok(requests.includes(name), name)
  for (const entry of entries.filter(value => value.pid)) assert.throws(() => process.kill(entry.pid, 0), { code: 'ESRCH' })
  await assert.rejects(handle.control({ action: 'reload-skills' }), { code: 'run-ended' })
})

test('permissions stay scoped and visible, MCP secrets are excluded, and child tasks never corrupt main-thread streaming', () => {
  for (const input of [{ action: 'permission-mode', mode: 'bypassPermissions' }, { action: 'mcp-toggle', name: 'a', enabled: 'true' }, { action: 'stop-task', taskId: '' }, { action: 'reload-skills', url: 'x' }]) assert.throws(() => validateRunControl(input), { code: 'invalid-input' })
  assert.throws(() => validateRunInput({ prompt: 'x', idempotencyKey: 'k', permissionMode: 'unknown' }), { code: 'invalid-input' })
  const signal = new AbortController().signal, args = { toolUseID: 'tool', requestId: 'req', signal, decisionReason: 'Contains brace with quote character (expansion obfuscation)', suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'projectSettings' }] }
  const permission = permissionRequest('Bash', { command: 'npm test' }, args)
  assert.deepEqual(permission.rememberRules, ['addRules · allow · Bash(npm test:*)'])
  assert.equal(permissionResult({ behavior: 'allow', session: true }, 'Bash', {}, { ...args, suppressAlwaysAllowRule: true }).behavior, 'deny')
  assert.equal(permissionResult({ behavior: 'allow', session: true }, 'Bash', {}, { ...args, suggestions: [] }).behavior, 'deny')
  const translated = createMessageTranslator()
  const event = value => ({ type: 'stream_event', parent_tool_use_id: null, event: value })
  let view = applyRunEvent(emptyRunView('r', 't'), translated(event({ type: 'message_start', message: { id: 'main' } }))[0])
  assert.deepEqual(translated({ ...event({ type: 'message_start', message: { id: 'child-stream' } }), parent_tool_use_id: 'spawn' }), [])
  for (const frame of [{ type: 'system', subtype: 'task_started', task_id: 'child', run_id: '002', tool_use_id: 'spawn', description: 'Search', subagent_type: 'Explore', task_type: 'local_agent' }, { type: 'system', subtype: 'task_progress', task_id: 'child', run_id: '002', description: 'Searching', usage: { total_tokens: 25, tool_uses: 2, duration_ms: 50 } }, { type: 'assistant', parent_tool_use_id: 'spawn', message: { id: 'child-result', content: [{ type: 'text', text: 'Found it' }] } }]) for (const item of translated(frame)) view = applyRunEvent(view, item)
  assert.equal(view.tasks[0].status, 'running'); assert.equal(view.tasks[0].toolUseId, 'spawn'); assert.equal(view.agentMessages[0].message.blocks[0].text, 'Found it')
  view = applyRunEvent(view, { type: 'task', task: { id: 'child', generation: '001', status: 'completed' } })
  assert.equal(view.tasks[0].status, 'running', 'late frames from an older task generation cannot finish the current task')
  const delta = translated(event({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }))[0]
  assert.equal(delta.messageId, 'main')
  const projected = capabilitiesView([], [], [{ name: 's', status: 'failed', config: { env: { SECRET: 'value' } }, error: 'token=SECRET' }], 'run', 'default')
  assert.doesNotMatch(JSON.stringify(projected), /SECRET|token|config|error/)
})

test('the contextual panel inserts skills, routes MCP/task controls to the selected run and aborts stale reads', async t => {
  const dom = installClaudeAgentDOM(t), requests = [], inserted = []
  let target = { key: 'device:thread', path: '/apps/claude-agent/threads/thread/capabilities', runId: 'run', live: { tasks: [{ id: 'child', status: 'running', agentType: 'Explore' }], agentMessages: [] } }, hold
  const panel = createCapabilitiesPanel(id => id, { target: () => target, request: async (path, body, signal) => { requests.push({ path, body, signal }); if (hold && !body) await new Promise(resolve => { hold = resolve }); return body ? { ok: true } : catalog }, insert: text => inserted.push(text), report: () => {} })
  dom.container.append(panel.element)
  t.after(() => panel.dispose())
  panel.open('skills'); await dom.flush()
  assert.match(dom.find('.ca-capability-content').textContent, /Review changes/)
  dom.fire(dom.find('.ca-capability-use'), 'click')
  assert.deepEqual(inserted, ['/review ']); assert.equal(panel.element.open, false); assert.ok(!requests.some(request => request.body), 'choosing a skill never executes a turn')
  panel.open('mcp'); await dom.flush()
  dom.fire(dom.find('.ca-capability-action'), 'click'); await dom.flush()
  assert.deepEqual(requests.find(request => request.body).body, { action: 'mcp-toggle', name: 'files', enabled: false })
  assert.equal(requests.find(request => request.body).path, '/apps/claude-agent/runs/run/control')
  panel.open('agents'); await dom.flush()
  dom.fire(dom.all('.ca-capability-action').find(button => button.textContent === '停止此任务'), 'click'); await dom.flush()
  assert.ok(requests.some(request => request.body?.taskId === 'child'))
  panel.close(); hold = true; panel.open('skills'); await dom.flush()
  const last = requests.at(-1), release = hold
  panel.close(); target = { key: 'other', path: '/other' }; release(); await dom.flush()
  assert.equal(last.signal.aborted, true); assert.equal(panel.element.open, false, 'late discovery never reopens or populates another thread')
})

test('approval copy explains actual rule lifetime and mode picker remains usable after acknowledgement', async t => {
  const dom = installClaudeAgentDOM(t), decisions = [], changes = []
  const approval = { id: 'a', kind: 'permission', toolName: 'Bash', input: {}, title: null, description: null, reason: 'expansion obfuscation', rememberRules: ['Bash(npm test:*)'], allowSessionAvailable: true, defaultToNo: true }
  dom.container.append(renderApproval(approval, { decide: (_view, decision) => decisions.push(decision) }, id => id))
  assert.match(dom.container.textContent, /后续消息和重新打开此会话/); assert.match(dom.container.textContent, /复杂的引号/)
  assert.doesNotMatch(dom.container.textContent, /本轮记住以上规则/)
  dom.fire(dom.all('button').find(button => button.textContent === '本次会话始终允许'), 'click')
  assert.deepEqual(decisions, ['allow-session'])
  const picker = createPermissionPicker(async mode => { changes.push(mode); picker.update(mode, true, true) }); dom.container.append(picker.element)
  picker.update('default', true, true)
  dom.fire(dom.find('[data-permission-mode="plan"]'), 'click'); await dom.flush()
  assert.equal(changes[0], 'plan'); assert.equal(dom.find('[data-permission-mode="acceptEdits"]').disabled, false)
})

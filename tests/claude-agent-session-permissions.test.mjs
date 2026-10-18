import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../packages/storage-sqlite/dist/sqlite.js'
import { createClaudeAgentStoreComponent } from '../packages/app-claude-agent/dist/core/store/component.js'
import { createClaudeAgentSdkComponent } from '../packages/app-claude-agent/dist/core/sdk/adapter.js'
import { createClaudeAgentRunsComponent } from '../packages/app-claude-agent/dist/core/runs/component.js'
import { nativeSessionPermissions, reusablePermissions } from '../packages/app-claude-agent/dist/core/sdk/permissions.js'
import { mergeSessionPermissions } from '../packages/app-claude-agent/dist/core/permissions.js'
import { createSessionPermissionsPanel } from '../packages/app-claude-agent/dist/web/session-permissions.js'
import { createRunsFixture, fakeSdk, sampleResult, waitFor, tick } from './helpers/claude-agent.mjs'
import { installClaudeAgentDOM } from './helpers/claude-agent-dom.mjs'

const spec = { allow: [{ tool: 'Bash', pattern: 'npm test:*' }], directories: [] }
const init = (nativeSessionId = 'session-one', cwd = '/project') => ({ type: 'init', init: { nativeSessionId, model: 'model', cwd, permissionMode: 'default', claudeCodeVersion: 'test', toolCount: 1 } })
const permission = (extra = {}) => ({ toolUseId: 'tool', toolName: 'Bash', input: { command: 'npm test' }, title: null, description: null, reason: null, defaultToNo: false, allowSessionAvailable: true, reusablePermissions: spec, rememberRules: ['Bash(npm test:*)'], questions: null, signal: new AbortController().signal, ...extra })
const finish = async (f, index, runId) => { f.sdk.runs[index].finish({ kind: 'result', result: sampleResult() }); f.sdk.runs[index].exit(); await f.runs.waitRun(runId) }
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'claude-session-grants-')), sdk = fakeSdk({ onClose(run) { run.finish({ kind: 'failed', error: { code: 'cancelled', message: 'closed' } }); run.exit() } }), opened = []
  t.after(async () => { for (const f of opened.reverse()) await f.close(); await rm(directory, { recursive: true, force: true }) })
  const open = async () => { const f = await createRunsFixture(join(directory, 'data.sqlite'), { sdk, cancel: { interruptTimeoutMs: 1, resultTimeoutMs: 1, exitTimeoutMs: 1 } }); opened.push(f); return f }
  return { directory, sdk, open }
}
async function grant(f, threadId, index = 0, key = 'first') {
  const run = await f.runs.startRun(threadId, { prompt: 'run checks', idempotencyKey: key }), active = f.sdk.runs[index]
  active.hooks.onEvent(init())
  const waiting = active.hooks.canUseTool(permission())
  const pending = f.runs.listPendingApprovals(threadId)[0]
  await f.runs.resolveApproval(pending.id, 'allow-session', undefined)
  assert.deepEqual(await waiting, { behavior: 'allow', session: true })
  return { run, approvalId: pending.id }
}

test('a remembered permission is durable for the same native conversation across messages and restart; other threads never inherit it', async t => {
  const { open } = await fixture(t); let f = await open()
  const a = await f.runs.createThread({ projectPath: '/project' }), b = await f.runs.createThread({ projectPath: '/project' })
  const first = await grant(f, a.id)
  assert.equal((await f.runs.sessionPermissions(a.id)).grants.length, 1)
  await assert.rejects(f.runs.revokeSessionPermission(a.id, first.approvalId), { code: 'permissions-active' })
  await finish(f, 0, first.run.id)
  const second = await f.runs.startRun(a.id, { prompt: 'check again', idempotencyKey: 'second' })
  assert.deepEqual(f.sdk.runs[1].request.sessionPermissions, spec)
  assert.equal(f.sdk.runs[1].request.resume, 'session-one')
  await finish(f, 1, second.id)
  const other = await f.runs.startRun(b.id, { prompt: 'different conversation', idempotencyKey: 'other' })
  assert.deepEqual(f.sdk.runs[2].request.sessionPermissions, { allow: [], directories: [] })
  await finish(f, 2, other.id)
  await f.close(); f = await open()
  const resumed = await f.runs.startRun(a.id, { prompt: 'after restart', idempotencyKey: 'resumed' })
  assert.deepEqual(f.sdk.runs[3].request.sessionPermissions, spec)
  await finish(f, 3, resumed.id)
  await assert.rejects(f.runs.revokeSessionPermission(b.id, first.approvalId), { code: 'permission-not-found' })
  await f.runs.revokeSessionPermission(a.id, first.approvalId)
  const revoked = await f.runs.startRun(a.id, { prompt: 'after revoke', idempotencyKey: 'revoked' })
  assert.deepEqual(f.sdk.runs[4].request.sessionPermissions, { allow: [], directories: [] })
  await finish(f, 4, revoked.id)
})

test('failed persistence never releases an always-allow answer; cancellation during saving rolls back the grant before a later run starts', async t => {
  const { open } = await fixture(t), f = await open(), thread = await f.runs.createThread({ projectPath: '/project' })
  const run = await f.runs.startRun(thread.id, { prompt: 'test', idempotencyKey: 'first' }), active = f.sdk.runs[0]
  active.hooks.onEvent(init())
  let released = false
  const pendingAnswer = active.hooks.canUseTool(permission()).then(value => { released = true; return value })
  const approval = f.runs.listPendingApprovals(thread.id)[0], save = f.store.saveSessionGrant
  f.store.saveSessionGrant = async () => { throw new Error('disk failure') }
  await assert.rejects(f.runs.resolveApproval(approval.id, 'allow-session', undefined), /disk failure/)
  assert.equal(released, false); assert.equal((await f.runs.sessionPermissions(thread.id)).grants.length, 0)
  let unlock, stored = false
  f.store.saveSessionGrant = async record => { await save(record); stored = true; await new Promise(resolve => { unlock = resolve }) }
  const decision = f.runs.resolveApproval(approval.id, 'allow-session', undefined), rejected = assert.rejects(decision, { code: 'approval-resolved' })
  await waitFor(() => stored)
  await assert.rejects(f.runs.resolveApproval(approval.id, 'allow-session', undefined), { code: 'permissions-changing' })
  await f.runs.cancelRun(run.id)
  assert.equal((await pendingAnswer).behavior, 'deny')
  await finish(f, 0, run.id)
  await assert.rejects(f.runs.startRun(thread.id, { prompt: 'too early', idempotencyKey: 'second' }), { code: 'permissions-changing' })
  unlock(); await rejected; f.store.saveSessionGrant = save
  assert.equal((await f.runs.sessionPermissions(thread.id)).grants.length, 0)
  const next = await f.runs.startRun(thread.id, { prompt: 'after cleanup', idempotencyKey: 'second' })
  assert.deepEqual(f.sdk.runs[1].request.sessionPermissions.allow, [])
  await finish(f, 1, next.id)
})

test('allow-once, denied or abandoned requests never become conversation grants, and changed native identity does not reuse grants', async t => {
  const { open } = await fixture(t), f = await open(), thread = await f.runs.createThread({ projectPath: '/project' })
  const run = await f.runs.startRun(thread.id, { prompt: 'test', idempotencyKey: 'first' }), active = f.sdk.runs[0]
  active.hooks.onEvent(init())
  for (const decision of ['allow', 'deny']) {
    const waiting = active.hooks.canUseTool(permission()), item = f.runs.listPendingApprovals(thread.id)[0]
    await f.runs.resolveApproval(item.id, decision, undefined); await waiting
  }
  const controller = new AbortController(), waiting = active.hooks.canUseTool(permission({ signal: controller.signal })); controller.abort(); await waiting
  assert.equal((await f.runs.sessionPermissions(thread.id)).grants.length, 0)
  await finish(f, 0, run.id)
  const remembered = await grant(f, thread.id, 1, 'remembered'); await finish(f, 1, remembered.run.id)
  await f.store.updateThread(thread.id, { nativeSessionId: 'another-native-session' }, 'later')
  assert.equal((await f.runs.sessionPermissions(thread.id)).grants.length, 0)
  const changed = await f.runs.startRun(thread.id, { prompt: 'new native session', idempotencyKey: 'changed' })
  assert.deepEqual(f.sdk.runs[2].request.sessionPermissions.allow, [])
  await finish(f, 2, changed.id)
})

test('only exact additive allow/directory suggestions are replayed through native rule syntax without application matching', () => {
  assert.equal(reusablePermissions([{ type: 'setMode', mode: 'bypassPermissions' }]), undefined)
  assert.equal(reusablePermissions([{ type: 'replaceRules', behavior: 'allow', rules: [{ toolName: 'Bash' }] }]), undefined)
  assert.equal(reusablePermissions([{ type: 'addRules', behavior: 'deny', rules: [{ toolName: 'Bash' }] }]), undefined)
  assert.equal(reusablePermissions([{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash)\nEdit(' }] }]), undefined)
  const policy = reusablePermissions([{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], destination: 'projectSettings' }, { type: 'addDirectories', directories: ['/other/project'], destination: 'userSettings' }])
  assert.deepEqual(nativeSessionPermissions(policy), { allowedTools: ['Bash(npm test:*)'], additionalDirectories: ['/other/project'] })
  assert.deepEqual(mergeSessionPermissions([policy, policy]), policy)
})

test('the authorization manager shows session-wide scope, prevents revocation during a run and rejects stale device responses', async t => {
  const dom = installClaudeAgentDOM(t), requests = []
  let target = { key: 'device:thread', threadId: 'thread' }, canRevoke = false
  const view = () => ({ schemaVersion: 1, threadId: 'thread', canRevoke, grants: [{ id: 'grant', rules: ['Bash(npm test:*)'], createdAt: 'now' }] })
  const panel = createSessionPermissionsPanel(id => id, { target: () => target, request: async (path, body, signal) => { requests.push({ path, body, signal }); return body ? { ...view(), grants: [] } : view() }, report: () => {} })
  dom.container.append(panel.element); t.after(() => panel.dispose())
  panel.open(dom.container); await tick()
  assert.match(dom.container.textContent, /后续消息/)
  assert.equal(dom.all('button').find(button => button.textContent === '撤销此授权').disabled, true)
  canRevoke = true; dom.fire(dom.all('button').find(button => button.textContent === '刷新授权'), 'click'); await tick()
  dom.fire(dom.all('button').find(button => button.textContent === '撤销此授权'), 'click'); await tick()
  assert.equal(requests.at(-1).path, '/apps/claude-agent/threads/thread/permissions/grant/revoke')
  assert.match(dom.container.textContent, /已撤销/)
  target = { key: 'another:thread', threadId: 'thread' }; panel.update()
  assert.equal(panel.element.open, false)
})

test('two real SDK processes reuse the stored allow rule while an unmatched command still produces an approval', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-native-grants-')), executable = join(directory, 'claude.mjs'), trace = join(directory, 'trace.jsonl'), root = new Context()
  await writeFile(executable, `import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
    const log=v=>appendFileSync(${JSON.stringify(trace)},JSON.stringify(v)+'\\n'); const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');
    const args=process.argv.slice(2);log({pid:process.pid,args});const timer=setInterval(()=>{},1000);const sid='11111111-1111-4111-8111-111111111111';
    const finish=()=>send({type:'result',subtype:'success',is_error:false,duration_ms:1,duration_api_ms:0,num_turns:1,total_cost_usd:0,usage:{input_tokens:0,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0},stop_reason:'end_turn',result:'done',session_id:sid});
    for await(const line of createInterface({input:process.stdin})){const v=JSON.parse(line);log(v);
      if(v.type==='control_request')send({type:'control_response',response:{subtype:'success',request_id:v.request_id,response:{commands:[],agents:[],models:[]}}});
      if(v.type==='user'){
        send({type:'system',subtype:'init',session_id:sid,model:'test',cwd:process.cwd(),permissionMode:'default',claude_code_version:'test',tools:['Bash']});
        const command=v.message.content==='unmatched'?'python task.py':'npm test';
        if(command==='npm test' && args.some(a=>a.includes('Bash(npm test:*)')))finish();
        else send({type:'control_request',request_id:'permission',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command},tool_use_id:'tool',permission_suggestions:[{type:'addRules',rules:[{toolName:'Bash',ruleContent:command==='npm test'?'npm test:*':'python:*'}],behavior:'allow',destination:'session'}]}});
      }
      if(v.type==='control_response'&&v.response.request_id==='permission')finish();
    }clearInterval(timer);`)
  t.after(async () => { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await root.installComponent(createLocalSqliteComponent(join(directory, 'data.sqlite')))
  await root.installComponent(createClaudeAgentStoreComponent())
  await root.installComponent(createClaudeAgentSdkComponent({ executableOverride: executable }))
  await root.installComponent(createClaudeAgentRunsComponent())
  const runs = root.get('claude-agent.runs'), thread = await runs.createThread({ projectPath: directory })
  const first = await runs.startRun(thread.id, { prompt: 'matched', idempotencyKey: 'first' })
  let approval
  await waitFor(() => { approval = runs.listPendingApprovals(thread.id)[0]; return approval }, 10000)
  assert.equal(approval.allowSessionAvailable, true)
  await runs.resolveApproval(approval.id, 'allow-session', undefined)
  assert.equal((await runs.waitRun(first.id)).status, 'completed')
  const second = await runs.startRun(thread.id, { prompt: 'matched', idempotencyKey: 'second' })
  assert.equal((await runs.waitRun(second.id)).status, 'completed')
  assert.equal(runs.getRunView(second.id).approvals.length, 0, 'the later process receives an allow rule and never asks the application to approve again')
  const third = await runs.startRun(thread.id, { prompt: 'unmatched', idempotencyKey: 'third' })
  await waitFor(() => { approval = runs.listPendingApprovals(thread.id)[0]; return approval }, 10000)
  assert.equal(approval.input.command, 'python task.py')
  await runs.resolveApproval(approval.id, 'allow', undefined)
  assert.equal((await runs.waitRun(third.id)).status, 'completed')
  const starts = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse).filter(entry => entry.pid)
  assert.equal(starts.length, 3); assert.ok(!starts[0].args.some(arg => arg.includes('Bash(npm test:*)')))
  assert.ok(starts.slice(1).every(entry => entry.args.some(arg => arg.includes('Bash(npm test:*)'))))
  assert.equal((await root.get('claude-agent.store').listSessionGrants(thread.id)).length, 1)
})

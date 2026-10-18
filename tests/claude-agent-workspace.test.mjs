import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createRunsFixture, fakeSdk, sampleResult, tick, waitFor } from './helpers/claude-agent.mjs'
import { createClaudeAgentSdkComponent } from '../packages/app-claude-agent/dist/core/sdk/adapter.js'
import { defaultSessionOptions, validateSessionOptions, elicitationAnswer } from '../packages/app-claude-agent/dist/core/workspace.js'
import { elicitationView, subagentMessages } from '../packages/app-claude-agent/dist/core/sdk/workspace.js'
import { createWorkspacePanel } from '../packages/app-claude-agent/dist/web/workspace.js'
import { installClaudeAgentDOM } from './helpers/claude-agent-dom.mjs'
const nativeId = '11111111-1111-4111-8111-111111111111', forkId = '22222222-2222-4222-8222-222222222222'
const context = { schemaVersion: 1, model: 'test', totalTokens: 10, maxTokens: 100, percentage: 10, estimated: true, categories: [] }
const catalog = { schemaVersion: 1, source: 'project', permissionMode: 'default', skills: [], agents: [], mcp: [] }
const finish = async (f, id, index = 0) => { f.sdk.runs[index].finish({ kind: 'result', result: sampleResult() }); f.sdk.runs[index].exit(); await f.runs.waitRun(id) }
const fixture = async (t, sdk = fakeSdk()) => { const original = sdk.port.openRun; sdk.port.openRun = (...args) => { const handle = original(...args), run = sdk.runs.at(-1), close = handle.close; handle.close = () => { close(); run.finish({ kind: 'failed', error: { code: 'cancelled', message: 'closed' } }); run.exit() }; return handle }; const dir = await mkdtemp(join(tmpdir(), 'claude-workspace-')); const f = await createRunsFixture(join(dir, 'index.sqlite'), { sdk }); t.after(async () => { await f.close(); await rm(dir, { recursive: true, force: true }) }); return { ...f, dir } }

test('budget snapshots, context and checkpoint metadata persist across restart while native transcripts stay external', async t => {
  let f = await fixture(t), thread = await f.runs.createThread({ projectPath: '/project' })
  const settings = { ...defaultSessionOptions, maxBudgetUsd: 0.5, maxTurns: 3, fallbackModel: 'sonnet' }
  await f.runs.updateOptions(thread.id, { ...settings, revision: 0 })
  await assert.rejects(f.runs.updateOptions(thread.id, { ...settings, maxTurns: 1, revision: 0 }), { code: 'settings-changed' })
  assert.equal((await f.runs.getThread(thread.id)).options.maxTurns, 3, 'a stale page cannot erase another page’s MCP or budget settings')
  const run = await f.runs.startRun(thread.id, { prompt: 'work', idempotencyKey: 'first' })
  assert.deepEqual(f.sdk.runs[0].request.options, settings)
  await assert.rejects(f.runs.updateOptions(thread.id, { ...settings, maxTurns: 1 }), { code: 'thread-busy' })
  f.sdk.runs[0].hooks.onEvent({ type: 'checkpoint', messageId: 'own-message' })
  f.sdk.runs[0].hooks.onEvent({ type: 'init', init: { nativeSessionId: nativeId, model: 'test', cwd: '/project', permissionMode: 'default', claudeCodeVersion: 'test', toolCount: 0 } })
  f.sdk.runs[0].hooks.onEvent({ type: 'context', context })
  await finish(f, run.id)
  await f.close()
  const restarted = await createRunsFixture(join(f.dir, 'index.sqlite'))
  t.after(() => restarted.close())
  assert.deepEqual((await restarted.runs.getThread(thread.id)).options, settings)
  assert.deepEqual((await restarted.runs.getRun(run.id)).contextUsage, context)
  assert.equal((await restarted.runs.checkpoints(thread.id))[0].id, 'own-message')
  assert.equal((await restarted.runs.getRun(run.id)).options.maxTurns, 3)
})

test('subagent history is paged by native identity; fork selection, grants and unknown mutation results remain isolated', async t => {
  const calls = [], sdk = fakeSdk({ history: async () => [{ id: 'message-1', role: 'user', blocks: [] }] })
  sdk.port.listSubagents = async session => { assert.equal(session, nativeId); return ['child-1'] }
  sdk.port.readSubagentMessages = async (session, dir, agent, offset) => { calls.push({ session, dir, agent, offset }); return { messages: [{ id: `child-${offset}`, role: 'assistant', blocks: [] }], hasMore: offset === 0 } }
  sdk.port.mutateSession = async (session, dir, input) => { calls.push(input); if (input.title === 'unknown') throw new Error('transport lost'); return { sessionId: forkId } }
  const f = await fixture(t, sdk), thread = await f.runs.createThread({ projectPath: '/project' })
  await f.store.updateThread(thread.id, { nativeSessionId: nativeId }, new Date().toISOString())
  assert.deepEqual(await f.runs.subagents(thread.id), ['child-1'])
  assert.equal((await f.runs.subagentMessages(thread.id, 'child-1', 100)).messages[0].id, 'child-100')
  await assert.rejects(f.runs.subagentMessages(thread.id, 'foreign', 0), { code: 'agent-not-found' })
  await assert.rejects(f.runs.manageThread(thread.id, { action: 'fork', messageId: 'foreign-message', idempotencyKey: 'bad-fork' }), { code: 'message-not-found' })
  const branch = await f.runs.manageThread(thread.id, { action: 'fork', messageId: 'message-1', idempotencyKey: 'fork' })
  assert.equal(branch.nativeSessionId, forkId); assert.equal(branch.forkedFrom, thread.id)
  assert.equal((await f.runs.sessionPermissions(branch.id)).grants.length, 0)
  assert.equal((await f.runs.manageThread(thread.id, { action: 'fork', messageId: 'message-1', idempotencyKey: 'fork' })).id, branch.id)
  assert.equal(calls.filter(call => call.action === 'fork').length, 1)
  await assert.rejects(f.runs.manageThread(thread.id, { action: 'fork', value: 'unknown', idempotencyKey: 'lost-fork' }))
  await assert.rejects(f.runs.manageThread(thread.id, { action: 'fork', value: 'unknown', idempotencyKey: 'lost-fork' }), { code: 'operation-unknown' })
  assert.equal(calls.filter(call => call.title === 'unknown').length, 1)
  assert.equal((await f.runs.manageThread(thread.id, { action: 'rename', value: 'New title', idempotencyKey: 'rename' })).titleSource, 'user')
  await f.runs.manageThread(thread.id, { action: 'archive', idempotencyKey: 'archive' })
  await assert.rejects(f.runs.startRun(thread.id, { prompt: 'x', idempotencyKey: 'x' }), { code: 'thread-archived' })
  assert.equal((await f.runs.manageThread(thread.id, { action: 'restore', idempotencyKey: 'restore' })).archived, false)
})

test('MCP authentication is thread-bound, answered once, never retained, and cancellation joins actual connection exit', async t => {
  let hooks, releaseExit, answered
  const sdk = fakeSdk()
  sdk.port.inspectSession = async (_request, _input, callbacks, signal) => {
    hooks = callbacks
    answered = await callbacks.onElicitation({ serverName: 'local', message: 'Choose account', mode: 'form', url: null, fields: [{ name: 'account', title: 'Account', type: 'string', required: true }] }, signal)
    if (!signal.aborted) return catalog
    await new Promise(resolve => { releaseExit = resolve }); return catalog
  }
  const f = await fixture(t, sdk), thread = await f.runs.createThread({ projectPath: '/project' }), other = await f.runs.createThread({ projectPath: '/other' })
  const job = await f.runs.connectMcp(thread.id)
  await waitFor(() => f.runs.interactions(thread.id).length === 1)
  const request = f.runs.interactions(thread.id)[0]
  assert.equal(f.runs.interactions(other.id).length, 0)
  assert.throws(() => f.runs.answerInteraction(other.id, request.id, { action: 'accept', content: { account: 'secret' } }), { code: 'interaction-resolved' })
  f.runs.answerInteraction(thread.id, request.id, { action: 'accept', content: { account: 'secret' } })
  await f.runs.waitConnectionJob(job.id)
  assert.equal(answered.content.account, 'secret'); assert.equal(f.runs.interactions(thread.id).length, 0)
  assert.throws(() => f.runs.answerInteraction(thread.id, request.id, { action: 'decline' }), { code: 'interaction-resolved' })
  assert.doesNotMatch(JSON.stringify(f.runs.connectionJob(thread.id, job.id)), /secret/)
  const second = await f.runs.connectMcp(thread.id)
  await waitFor(() => f.runs.interactions(thread.id).length === 1)
  f.runs.cancelConnectionJob(thread.id, second.id)
  await waitFor(() => !!releaseExit)
  assert.equal(f.admission.busy(), true)
  await assert.rejects(f.runs.startRun(thread.id, { prompt: 'x', idempotencyKey: 'while-exiting' }), { code: 'run-active' })
  releaseExit(); await f.runs.waitConnectionJob(second.id)
  assert.equal(f.admission.busy(), false)
})

test('rewind validates checkpoint ownership, previews without mutation, and never replays an uncertain write', async t => {
  const calls = [], sdk = fakeSdk()
  sdk.port.inspectSession = async (_request, input) => { calls.push(input); if (!input.dryRun) throw new Error('exit unknown'); return { canRewind: true, error: null, files: ['a.txt'], insertions: 1, deletions: 0, skippedLinks: 0 } }
  const f = await fixture(t, sdk), thread = await f.runs.createThread({ projectPath: '/project' })
  await f.store.updateThread(thread.id, { nativeSessionId: nativeId }, '2026-10-18T00:00:00Z')
  await f.store.saveCheckpoint({ id: 'cp', threadId: thread.id, nativeSessionId: nativeId, runId: 'r', createdAt: '2026-10-18T00:00:00Z' })
  await assert.rejects(f.runs.rewind(thread.id, { checkpointId: 'foreign', dryRun: false, idempotencyKey: 'bad' }), { code: 'checkpoint-unavailable' })
  assert.equal((await f.runs.rewind(thread.id, { checkpointId: 'cp', dryRun: true })).files[0], 'a.txt')
  await assert.rejects(f.runs.rewind(thread.id, { checkpointId: 'cp', dryRun: false, idempotencyKey: 'restore' }))
  await assert.rejects(f.runs.rewind(thread.id, { checkpointId: 'cp', dryRun: false, idempotencyKey: 'restore' }), { code: 'operation-unknown' })
  assert.equal(calls.filter(call => !call.dryRun).length, 1)
})

test('MCP configuration and elicitation schemas reject credential injection and unsupported fields', () => {
  for (const raw of [{ maxBudgetUsd: -1 }, { maxTurns: 1.5 }, { mcpServers: { s: { type: 'http', url: 'https://host/mcp', headers: { Authorization: 'secret' } } } }, { mcpServers: { s: { type: 'http', url: 'https://u:p@host/mcp' } } }, { mcpServers: { s: { type: 'http', url: 'https://host/mcp?token=secret' } } }]) assert.throws(() => validateSessionOptions(raw))
  assert.equal(validateSessionOptions({ mcpServers: { local: { type: 'http', url: 'http://127.0.0.1:1234/mcp' } } }).mcpServers.local.type, 'http')
  const view = elicitationView({ serverName: 's', message: 'answer', requestedSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] } })
  assert.throws(() => elicitationAnswer(view, { action: 'accept', content: { count: 1.5 } }))
  assert.throws(() => elicitationView({ serverName: 's', message: '', requestedSchema: { type: 'object', properties: { hidden: { type: 'object' } } } }))
  assert.equal(elicitationAnswer(view, { action: 'accept', content: { count: 2 } }).content.count, 2)
  const messages = subagentMessages([{ type: 'user', uuid: 'u', parent_tool_use_id: 'parent', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'result' }] } }])
  assert.equal(messages[0].blocks[0].kind, 'tool_result', 'child tool results must survive projection')
})

test('real SDK control transport receives budget flags and inspection never submits a prompt; checkpoint IDs are per task', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-workspace-sdk-')), binary = join(directory, 'claude.mjs'), trace = join(directory, 'trace.jsonl')
  await writeFile(binary, `import{createInterface}from'node:readline';import{appendFileSync}from'node:fs';const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');appendFileSync(${JSON.stringify(trace)},JSON.stringify({pid:process.pid,args:process.argv.slice(2)})+'\\n');
  for await(const line of createInterface({input:process.stdin})){const v=JSON.parse(line);appendFileSync(${JSON.stringify(trace)},line+'\\n');if(v.type==='control_request'){let response={};if(v.request.subtype==='initialize')response={commands:[],agents:[],models:[]};if(v.request.subtype==='get_context_usage')response={model:'test',totalTokens:10,maxTokens:100,percentage:10,categories:[],gridRows:[],memoryFiles:[],mcpTools:[],agents:[]};if(v.request.subtype==='read_file')response={contents:v.request.encoding==='base64'?Buffer.from('hello').toString('base64'):'hello',absPath:'/project/a.txt'};if(v.request.subtype==='rewind_files')response={canRewind:true,filesChanged:['a.txt']};send({type:'control_response',response:{subtype:'success',request_id:v.request_id,response}})}if(v.type==='user'){send({type:'system',subtype:'init',session_id:${JSON.stringify(nativeId)},model:'test',cwd:${JSON.stringify(directory)},permissionMode:'default',claude_code_version:'test',tools:[]});send({...v,uuid:'foreign-history-id'});send(v);send({type:'result',subtype:'success',is_error:false,duration_ms:1,duration_api_ms:1,num_turns:1,total_cost_usd:0,usage:{input_tokens:1,output_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0},modelUsage:{},stop_reason:'end_turn',result:'ok',session_id:${JSON.stringify(nativeId)},uuid:'result'})}}`)
  const root = new Context(); t.after(async () => { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await root.installComponent(createClaudeAgentSdkComponent({ executableOverride: binary, isFile: () => true }))
  const sdk = root.get('claude-agent.sdk'), request = { cwd: directory, prompt: 'work', resume: null, options: { ...defaultSessionOptions, maxBudgetUsd: 0.25, maxTurns: 2, fallbackModel: 'sonnet' } }
  assert.equal((await sdk.inspectSession(request, { action: 'context' }, {})).percentage, 10)
  assert.equal((await sdk.inspectSession(request, { action: 'file', path: 'a.txt' }, {})).contents, 'hello')
  assert.equal((await sdk.inspectSession(request, { action: 'rewind', messageId: 'checkpoint', dryRun: true }, {})).canRewind, true)
  let entries = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(entries.some(entry => entry.type === 'user'), false)
  const events = [], handle = sdk.openRun(request, { onEvent: event => events.push(event), canUseTool: async () => ({ behavior: 'deny', message: 'test' }) })
  await handle.result; handle.close(); await handle.done
  entries = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse)
  const args = entries.findLast(entry => entry.args).args
  for (const flag of ['--max-budget-usd', '--max-turns', '--fallback-model', '--replay-user-messages']) assert.ok(args.some(value => value === flag || value.startsWith(flag + '=')), flag)
  const own = entries.find(entry => entry.type === 'user').uuid
  assert.deepEqual(events.filter(event => event.type === 'checkpoint').map(event => event.messageId), [own])
  for (const entry of entries.filter(entry => entry.pid)) assert.throws(() => process.kill(entry.pid, 0), { code: 'ESRCH' })
})

test('workspace drawer cancels stale reads, preserves dirty form state, and does not populate a different thread', async t => {
  const dom = installClaudeAgentDOM(t)
  let target = { key: 'a', thread: { id: 'a', title: 'A' } }, release
  const panel = createWorkspacePanel(id => id, { target: () => target, request: (_path, _body, signal) => new Promise(resolve => { release = () => resolve(context) }), changed() {}, report() {}, interactions() {} })
  t.after(() => panel.dispose()); dom.container.append(panel.element)
  panel.open(); await tick(); panel.close(); target = { key: 'b', thread: { id: 'b', title: 'B' } }; release(); await dom.flush()
  assert.equal(panel.element.open, false)
  assert.doesNotMatch(panel.element.textContent, /10.0%/)
})

test('workspace form edits survive hiding and block navigation until explicitly discarded', async t => {
  const dom = installClaudeAgentDOM(t)
  const target = { key: 'a', thread: { id: 'a', title: 'A' } }
  const panel = createWorkspacePanel(id => id, { target: () => target, request: async () => context, changed() {}, report() {}, interactions() {} })
  t.after(() => panel.dispose()); dom.container.append(panel.element); panel.open(); await dom.flush()
  const form = dom.find('.ca-workspace-form'), budget = form.querySelector('input')
  budget.value = '12'; dom.fire(form, 'input')
  assert.equal(panel.canClose(), false)
  panel.hide(); panel.open(); await dom.flush()
  assert.equal(budget.value, '12'); assert.equal(panel.canClose(), false)
  dom.all('button').find(node => node.textContent === '放弃修改并关闭').click()
  assert.equal(panel.element.open, false); assert.equal(panel.canClose(), true)
})

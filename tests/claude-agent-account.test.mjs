import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { accountUsageView, readAccountUsage } from '../packages/app-claude-agent/dist/core/sdk/account.js'
import { createClaudeAgentSdkComponent } from '../packages/app-claude-agent/dist/core/sdk/adapter.js'
import { createAccountPanel, resetCountdown } from '../packages/app-claude-agent/dist/web/account.js'
import { installClaudeAgentDOM } from './helpers/claude-agent-dom.mjs'
import { createRunsFixture, fakeSdk, sampleResult } from './helpers/claude-agent.mjs'

const checkedAt = '2026-10-18T12:00:00.000Z', reset = '2026-10-18T13:00:00.000Z'
const nativeAccount = { email: 'qa@example.com', organization: 'Example', subscriptionType: 'Claude Max', apiProvider: 'firstParty', tokenSource: 'private-credential-path', secret: 'DO-NOT-EXPOSE' }
const nativeUsage = { subscription_type: 'max', rate_limits_available: true, rate_limits: { five_hour: { utilization: 3, resets_at: reset }, seven_day: { utilization: 16, resets_at: '2026-10-21T08:00:00Z' } }, session: { secret: 'DO-NOT-EXPOSE' } }
const view = () => accountUsageView(nativeAccount, nativeUsage, checkedAt)
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

test('account projection exposes current plan/windows and excludes credentials, raw errors and unrelated usage', () => {
  const result = view()
  assert.deepEqual(result.account, { email: 'qa@example.com', organization: 'Example', subscription: 'max', provider: 'firstParty' })
  assert.deepEqual(result.quotas.fiveHour, { usedPercent: 3, resetsAt: reset })
  assert.equal(result.quotas.weekly.usedPercent, 16)
  assert.equal(result.quotas.status, 'available')
  assert.doesNotMatch(JSON.stringify(result), /DO-NOT-EXPOSE|credential-path|tokenSource|session/)
  const invalid = accountUsageView(nativeAccount, { ...nativeUsage, rate_limits: { five_hour: { utilization: 101, resets_at: 'bad' } } }, checkedAt)
  assert.deepEqual(invalid.quotas.fiveHour, { usedPercent: null, resetsAt: null })
  assert.equal(invalid.quotas.weekly, null, 'an absent meter must not become zero usage')
})

test('quota failures, unsupported API authentication and incomplete scopes remain distinct from zero usage', async () => {
  const failed = await readAccountUsage({ accountInfo: async () => nativeAccount, usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { throw Error('secret token') } })
  assert.equal(failed.account.subscription, 'Claude Max'); assert.equal(failed.quotas.status, 'failed')
  assert.equal(failed.quotas.fiveHour, null); assert.doesNotMatch(JSON.stringify(failed), /secret token/)
  const api = accountUsageView({ apiProvider: 'firstParty', apiKeySource: 'private' }, { subscription_type: null, rate_limits_available: false, rate_limits: null }, checkedAt)
  assert.equal(api.quotas.status, 'unavailable'); assert.match(api.quotas.reason, /API/)
  const apiWithCachedPlan = accountUsageView({ ...nativeAccount, apiKeySource: 'environment' }, { subscription_type: null, rate_limits_available: false, rate_limits: null }, checkedAt)
  assert.equal(apiWithCachedPlan.account.subscription, null, 'an active API lane must not display a stale OAuth plan')
  const scope = accountUsageView(nativeAccount, { subscription_type: 'max', rate_limits_available: false, rate_limits: null }, checkedAt)
  assert.match(scope.quotas.reason, /授权/)
  const timeout = await readAccountUsage({ accountInfo: async () => nativeAccount, usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => new Promise(() => {}) }, 10)
  assert.equal(timeout.quotas.status, 'failed'); assert.equal(timeout.account.email, nativeAccount.email)
})

test('reset countdown handles weekly windows, expiry and unknown timestamps without resetting the meter locally', () => {
  const now = Date.parse(checkedAt)
  assert.equal(resetCountdown(reset, now), '1 小时 0 分钟后重置')
  assert.equal(resetCountdown(new Date(now + 86399000).toISOString(), now), '23 小时 59 分钟后重置')
  assert.equal(resetCountdown(new Date(now + 90061000).toISOString(), now), '1 天 1 小时 1 分钟后重置')
  assert.equal(resetCountdown(new Date(now + 1000).toISOString(), now), '0 分 1 秒后重置')
  assert.match(resetCountdown(checkedAt, now), /请刷新/)
  assert.match(resetCountdown(null, now), /未提供/)
})

test('account panel refreshes real snapshots, clears failed/stale data and reports partial quota failures', async t => {
  const dom = installClaudeAgentDOM(t); let calls = 0
  const panel = createAccountPanel(x => x, { target: () => ({ key: 'device:project', path: '/account?cwd=%2Fproject', label: '本机' }), request: async () => { calls++; if (calls === 2) throw Error('private details'); return calls === 3 ? accountUsageView(nativeAccount, undefined, checkedAt) : view() } })
  dom.container.append(panel.element); t.after(() => panel.dispose())
  panel.open(); await dom.flush()
  assert.match(panel.element.textContent, /Claude Max/); assert.match(panel.element.textContent, /已用 3%/); assert.match(panel.element.textContent, /已用 16%/)
  assert.match(panel.element.textContent, /查询于/)
  dom.find('.ca-account-refresh').click(); await dom.flush()
  assert.equal(dom.find('.ca-account-error').hidden, false)
  assert.match(dom.find('.ca-account-error').textContent, /读取失败/)
  assert.doesNotMatch(panel.element.textContent, /已用 3%|private details|qa@example.com/)
  dom.find('.ca-account-refresh').click(); await dom.flush()
  assert.match(panel.element.textContent, /qa@example.com/)
  assert.match(dom.find('.ca-account-error').textContent, /额度读取失败/)
  assert.equal(dom.find('progress').hidden, true)
})

test('switching device or closing the panel cancels observation and ignores the previous account reply', async t => {
  const dom = installClaudeAgentDOM(t), response = deferred(); let signal, target = { key: 'old', path: '/account', label: 'Old' }
  const panel = createAccountPanel(x => x, { target: () => target, request: async (_path, received) => { signal = received; return response.promise } })
  dom.container.append(panel.element); t.after(() => panel.dispose())
  panel.open(); await dom.flush(); target = { key: 'new', path: '/account', label: 'New' }; panel.update()
  assert.equal(signal.aborted, true); assert.equal(panel.element.open, false)
  response.resolve(view()); await dom.flush()
  assert.doesNotMatch(dom.find('.ca-account-content').textContent, /qa@example.com/)
})

async function protocolFixture(t, wait = false) {
  const directory = await mkdtemp(join(tmpdir(), 'claude-account-')), executable = join(directory, 'claude.mjs'), trace = join(directory, 'trace.jsonl')
  await writeFile(executable, `import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';const log=x=>appendFileSync(${JSON.stringify(trace)},JSON.stringify(x)+'\\n');const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');log({pid:process.pid,args:process.argv.slice(2)});setInterval(()=>{},1000);for await(const line of createInterface({input:process.stdin})){const x=JSON.parse(line);log(x);if(x.type!=='control_request')continue;if(x.request.subtype==='initialize')send({type:'control_response',response:{subtype:'success',request_id:x.request_id,response:{models:[],commands:[],agents:[],account:${JSON.stringify(nativeAccount)}}}});else if(!${wait}&&x.request.subtype==='get_usage')send({type:'control_response',response:{subtype:'success',request_id:x.request_id,response:${JSON.stringify(nativeUsage)}}});}`)
  const root = new Context(); await root.installComponent(createClaudeAgentSdkComponent({ executableOverride: executable }))
  t.after(async () => { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  const lines = async () => { try { return (await readFile(trace, 'utf8')).trim().split('\n').map(x => JSON.parse(x)) } catch { return [] } }
  return { root, sdk: root.get('claude-agent.sdk'), directory, lines }
}
test('account discovery uses actual SDK control requests, sends no prompt and joins its process exit', async t => {
  const f = await protocolFixture(t), result = await f.sdk.readAccountUsage(f.directory), lines = await f.lines()
  assert.equal(result.quotas.weekly.usedPercent, 16)
  assert.equal(result.account.email, nativeAccount.email)
  assert.ok(lines[0].args.includes('--no-session-persistence'))
  assert.ok(lines[0].args.includes('--strict-mcp-config'))
  assert.ok(lines.slice(1).every(x => x.type === 'control_request'))
  const usage = lines.find(x => x.request?.subtype === 'get_usage')
  assert.equal(usage.request.skip_behaviors, true)
  assert.throws(() => process.kill(lines[0].pid, 0), { code: 'ESRCH' })
})

test('cancelling account discovery terminates and joins its child without a model turn', async t => {
  const f = await protocolFixture(t, true), controller = new AbortController()
  const pending = f.sdk.readAccountUsage(f.directory, controller.signal), rejected = assert.rejects(pending, { code: 'cancelled' })
  let lines = []
  for (let i = 0; i < 300; i++) { lines = await f.lines(); if (lines.some(x => x.request?.subtype === 'get_usage')) break; await new Promise(r => setTimeout(r, 10)) }
  assert.ok(lines.some(x => x.request?.subtype === 'get_usage'))
  controller.abort(); await rejected
  assert.throws(() => process.kill(lines[0].pid, 0), { code: 'ESRCH' })
})

test('account inspection uses the active query, otherwise its own project discovery, without creating sessions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'claude-account-runs-')), sdk = fakeSdk(), calls = []
  sdk.port.readAccountUsage = async (cwd, signal) => { calls.push({ cwd, signal }); return view() }
  const f = await createRunsFixture(join(directory, 'index.sqlite'), { sdk })
  t.after(async () => { for (const run of sdk.runs) { run.finish({ kind: 'result', result: sampleResult() }); run.exit() } await f.close(); await rm(directory, { recursive: true, force: true }) })
  const signal = new AbortController().signal
  await f.runs.accountUsage(undefined, '/selected-project', signal)
  assert.equal((await f.runs.listThreads()).length, 0)
  assert.equal(calls[0].cwd, '/selected-project'); assert.equal(calls[0].signal, signal)
  const thread = await f.runs.createThread({ projectPath: '/thread-project' })
  await f.runs.accountUsage(thread.id)
  assert.equal(calls[1].cwd, '/thread-project')
  await f.runs.startRun(thread.id, { prompt: 'work', idempotencyKey: 'account-run' })
  sdk.runs[0].handle.inspect = async input => { assert.deepEqual(input, { action: 'account' }); return view() }
  assert.equal((await f.runs.accountUsage(thread.id)).account.email, nativeAccount.email)
  assert.equal(calls.length, 2, 'active account identity must come from the running query')
  await assert.rejects(f.runs.accountUsage('missing'), { code: 'thread-not-found' })
})

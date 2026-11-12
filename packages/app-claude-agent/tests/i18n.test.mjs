import test from 'node:test'
import assert from 'node:assert/strict'
import { createClaudeI18n, resolveClaudeLocale } from '../dist/web/i18n.js'
import { zh, en } from '../dist/web/i18n-resources.js'
import { messageFor, relativeTime, formatUsage } from '../dist/web/state.js'
import { renderApproval, syncTranscript } from '../dist/web/view.js'
import { createProjectPanel } from '../dist/web/projects.js'
import { createPermissionPicker } from '../dist/web/permissions.js'
import { mount } from '../dist/web/app.js'
import { installClaudeAgentDOM } from '../../../tests/helpers/claude-agent-dom.mjs'

function localeSource(initial = 'zh-CN') {
  let preferredLocale = initial, revision = 0, fail = false
  const listeners = new Set()
  return { listeners, current() { if (fail) throw new Error('unavailable'); return { preferredLocale, revision } }, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    set(value) { preferredLocale = value; revision++; for (const listener of listeners) listener() }, fail() { fail = true; for (const listener of listeners) listener() } }
}

test('application locales are independent, static, complete, plural-aware and resilient to optional source failures', t => {
  const source = localeSource('en-US'), first = createClaudeI18n(source), second = createClaudeI18n()
  t.after(() => { first.dispose(); second.dispose() })
  assert.equal(first.locale, 'en'); assert.equal(second.locale, 'zh-CN')
  assert.equal(resolveClaudeLocale('en-GB'), 'en'); assert.equal(resolveClaudeLocale('zh-Hans-CN'), 'zh-CN'); assert.equal(resolveClaudeLocale('unknown-###'), 'zh-CN')
  assert.equal(first.t('app.activeTasks', { count: 1 }), '1 active task'); assert.equal(first.t('app.activeTasks', { count: 2 }), '2 active tasks')
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  for (const key of Object.keys(zh)) {
    const params = value => [...value.matchAll(/{{(\w+)}}/g)].map(match => match[1]).sort()
    assert.deepEqual(params(zh[key]), params(en[key]), key)
  }
  source.fail(); assert.equal(first.locale, 'en', 'a failed source retains the last accepted language')
  first.dispose(); first.dispose(); assert.equal(source.listeners.size, 0)
  const broken = createClaudeI18n({ current() { throw new Error('no preference') }, subscribe() { throw new Error('no subscription') } })
  assert.equal(broken.t('app.send'), '发送'); broken.dispose()
})

test('locale refresh changes registered product labels without replacing transcript content, approval answers, focus or project input', async t => {
  const dom = installClaudeAgentDOM(t), source = localeSource(), i18n = createClaudeI18n(source)
  t.after(() => i18n.dispose())
  const transcript = document.createElement('div'); dom.container.append(transcript)
  const items = [{ id: 'original', role: 'user', streaming: false, blocks: [{ kind: 'text', text: '发送 <>&"\' User 原文', truncated: true }] }]
  syncTranscript(transcript, items, i18n)
  const article = transcript.querySelector('article'), original = transcript.querySelector('.ca-text'), originalContent = original.textContent
  const question = { id: 'q', kind: 'question', toolName: 'AskUserQuestion', input: {}, questions: [{ header: 'SDK 原始标题', question: 'Original SDK question?', options: [{ label: '原始选项', description: 'Original description' }], multiSelect: false }] }
  const approval = renderApproval(question, { decide() { assert.fail('locale must not answer an approval') } }, value => `test-${value}`, i18n)
  dom.container.append(approval)
  const answer = approval.querySelector('input'); answer.checked = true; answer.focus()
  const picker = createPermissionPicker(async () => assert.fail('locale must not change permission mode'), undefined, i18n); dom.container.append(picker.element)
  picker.update('default', true, true); picker.element.open = true
  const requests = []
  const panel = createProjectPanel(value => value, { request: async path => { requests.push(path); return { projects: [] } }, select() {}, create() {}, pickNative: async () => null, report() {} }, i18n)
  dom.container.append(panel.element); panel.setEnabled(true); panel.setPath('/project/原文'); panel.open(); await dom.flush()
  const projectInput = panel.element.querySelector('input[name="projectPath"]'); projectInput.value = '/edited/未保存'; projectInput.focus()
  const beforeRequests = requests.length
  source.set('en')
  assert.equal(transcript.querySelector('article'), article); assert.equal(transcript.querySelector('.ca-text'), original)
  assert.ok(original.textContent.startsWith('发送 <>&"\' User 原文')); assert.notEqual(original.textContent, originalContent)
  assert.match(original.textContent, /truncated/)
  assert.equal(answer.checked, true); assert.equal(approval.querySelector('input'), answer)
  assert.equal(approval.querySelector('button').textContent, 'Submit answers')
  assert.match(approval.textContent, /SDK 原始标题/); assert.match(approval.textContent, /原始选项/)
  assert.equal(picker.element.open, true); assert.equal(picker.summary.textContent, 'Ask')
  assert.equal(projectInput.value, '/edited/未保存'); assert.equal(document.activeElement, projectInput)
  assert.equal(panel.element.querySelector('dialog').open, true); assert.equal(requests.length, beforeRequests)
  assert.equal(projectInput.getAttribute('aria-label'), 'Project directory')
  panel.dispose()
})

test('owned errors and usage use explicit locale while SDK messages, currency and raw values are preserved', t => {
  const source = localeSource('en'), i18n = createClaudeI18n(source); t.after(() => i18n.dispose())
  assert.match(messageFor(Object.assign(new Error('run-active'), { code: 'run-active', status: 409 }), i18n), /already has an active task/)
  assert.equal(messageFor(Object.assign(new Error('SDK 原文 <error>'), { code: 'run-active', status: 409 }), i18n), 'SDK 原文 <error>')
  assert.equal(i18n.t('approval.path', { path: '<script>&"原文' }), 'Path: <script>&"原文')
  assert.equal(relativeTime('2026-11-12T11:45:00Z', Date.parse('2026-11-12T12:00:00Z'), i18n), '15 minutes ago')
  const result = { numTurns: 1, durationMs: 1500, totalCostUsd: 0.0042, isError: false, usage: { inputTokens: 1000, outputTokens: 4, cacheReadInputTokens: 2000, cacheCreationInputTokens: 0 } }
  assert.match(formatUsage(result, i18n), /3,000 input/); assert.match(formatUsage(result, i18n), /\$0\.0042/)
  source.set('zh-CN'); assert.match(formatUsage(result, i18n), /US\$0\.0042/)
  assert.equal(result.totalCostUsd, 0.0042); assert.equal(result.usage.inputTokens, 1000)
})

test('mounted app changes language in place while editing, approving and observing an active Run; hidden views keep the latest language', async t => {
  const dom = installClaudeAgentDOM(t, { autoRestore: false }), source = localeSource(), originalFetch = globalThis.fetch, controller = new AbortController(), requests = [], streams = []
  const apiBase = '/api/client/v1/apps/claude-agent', stamp = '2026-11-12T00:00:00.000Z'
  const thread = { id: 'one', projectPath: '/projects/原文', title: 'Original thread 用户标题', updatedAt: stamp, createdAt: stamp, lastRun: { id: 'run', status: 'running' }, pendingApprovals: 1 }
  const run = { id: 'run', threadId: 'one', status: 'running', prompt: '用户任务原文', permissionMode: 'default', result: null, error: null }
  const approval = { id: 'approval', kind: 'question', toolName: 'AskUserQuestion', input: {}, decision: null, questions: [{ header: 'SDK question', question: 'Keep raw?', options: [{ label: '原始选项' }], multiSelect: false }] }
  let mounted
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input), 'https://example.invalid').pathname, method = init.method ?? 'GET'; requests.push({ path, method, signal: init.signal })
    if (path === `${apiBase}/connections`) return Response.json({ connections: [{ id: 'first', name: 'Original device', instanceId: 'instance', revision: 1, endpoint: 'https://device.example' }], localInstanceId: null })
    if (path === `${apiBase}/local`) return Response.json({ instanceId: null })
    const target = path.replace(`${apiBase}/connections/first/v1`, '')
    if (target === '/instance') return Response.json({ capabilities: ['claude-agent.v1'] })
    if (target === '/products/claude-agent') return Response.json({ state: 'running' })
    if (target === '/apps/claude-agent/environment') return Response.json({ executable: {} })
    if (target.endsWith('/projects/recent')) return Response.json({ projects: [] })
    if (target === '/apps/claude-agent/threads') return Response.json([thread])
    if (target === '/apps/claude-agent/events') return new Response(new ReadableStream({ start(stream) { streams.push(stream); init.signal.addEventListener('abort', () => { try { stream.close() } catch {} }, { once: true }) } }))
    if (target === '/apps/claude-agent/threads/one') return Response.json(thread)
    if (target === '/apps/claude-agent/threads/one/messages') return Response.json({ messages: [] })
    if (target === '/apps/claude-agent/threads/one/runs') return Response.json([run])
    if (target === '/apps/claude-agent/threads/one/approvals') return Response.json([approval])
    if (target === '/apps/claude-agent/runs/run/messages') return Response.json([])
    if (target === '/apps/claude-agent/runs/run/view') return Response.json({ runId: 'run', threadId: 'one', seq: 0, items: [], approvals: [approval], notices: [] })
    assert.fail(`Unexpected ${method} ${target}`)
  }
  t.after(async () => { try { await mounted?.dispose(); controller.abort(); await dom.flush() } finally { globalThis.fetch = originalFetch; dom.restore() } })
  mounted = await mount(dom.container, { appId: 'claude-agent', apiBase, signal: controller.signal, locale: source, domId: value => `test-${value}`, route: { read: () => 'host/instance/thread/one', navigate() {}, subscribe: () => () => {} } })
  const prompt = dom.find('textarea'), answer = dom.find('.ca-approval input'), originalArticle = dom.find('[data-item-id]'), streamSignal = requests.find(item => item.path.endsWith('/events')).signal
  prompt.value = '未保存草稿 <>&"'; dom.fire(prompt, 'input', { isComposing: true }); prompt.selectionStart = 2; prompt.selectionEnd = 5; prompt.focus(); answer.checked = true
  const before = requests.length
  source.set('en-GB')
  assert.equal(dom.find('textarea'), prompt); assert.equal(prompt.value, '未保存草稿 <>&"'); assert.equal(prompt.selectionStart, 2); assert.equal(prompt.selectionEnd, 5); assert.equal(document.activeElement, prompt)
  assert.equal(dom.find('.ca-approval input'), answer); assert.equal(answer.checked, true)
  assert.equal(dom.find('[data-item-id]'), originalArticle); assert.equal(dom.find('.claude-agent-app').getAttribute('lang'), 'en')
  assert.equal(dom.find('.ca-cancel').textContent, 'Stop'); assert.equal(prompt.getAttribute('placeholder'), 'Describe a task, or ask a question…')
  assert.match(dom.find('.ca-drafts-button').textContent, /Unsent drafts/)
  assert.equal(requests.length, before, 'locale notification must not repeat discovery, reads or mutations'); assert.equal(streamSignal.aborted, false)
  assert.equal(mounted.canClose(), false, 'draft exit guard remains effective')
  await mounted.setActive(false, 'select'); const afterHide = requests.length; source.set('zh-CN')
  assert.equal(dom.find('.ca-cancel').textContent, '停止'); assert.equal(requests.length, afterHide); assert.equal(streamSignal.aborted, false)
  await mounted.dispose(); assert.equal(source.listeners.size, 0); const placeholder = prompt.getAttribute('placeholder'); source.set('en'); assert.equal(prompt.getAttribute('placeholder'), placeholder)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyRunEvent, emptyRunView, liveViewLimits, boundedJson } from '../dist/applications/claude-agent/core/events.js'
import { createMessageTranslator, historyMessages, permissionRequest, permissionResult, questionViews, blockView } from '../dist/applications/claude-agent/core/sdk/translate.js'
import { approvalView, decisionFor } from '../dist/applications/claude-agent/core/runs/approvals.js'
import { promptTitle, validateRunInput, validateThreadInput } from '../dist/applications/claude-agent/core/domain.js'

const fold = events => events.reduce(applyRunEvent, emptyRunView('run', 'thread'))

test('streamed blocks are finalized by the completed assistant block and tool results become user items', () => {
  const view = fold([
    { type: 'init', init: { nativeSessionId: 's', model: 'claude-sonnet-5', cwd: '/p', permissionMode: 'default', claudeCodeVersion: '2.1.278', toolCount: 12 } },
    { type: 'message-start', messageId: 'm1' },
    { type: 'block-start', messageId: 'm1', index: 0, block: 'thinking' },
    { type: 'thinking-delta', messageId: 'm1', index: 0, text: 'Plan' },
    { type: 'block-stop', messageId: 'm1', index: 0 },
    { type: 'block-start', messageId: 'm1', index: 1, block: 'text' },
    { type: 'text-delta', messageId: 'm1', index: 1, text: 'Hel' },
    { type: 'text-delta', messageId: 'm1', index: 1, text: 'lo' },
    { type: 'assistant', messageId: 'm1', blocks: [{ kind: 'thinking', text: 'Plan the reply', truncated: false }] },
    { type: 'block-stop', messageId: 'm1', index: 1 },
    { type: 'block-start', messageId: 'm1', index: 2, block: 'tool_use', toolUseId: 't1', name: 'Bash' },
    { type: 'assistant', messageId: 'm1', blocks: [{ kind: 'text', text: 'Hello', truncated: false }] },
    { type: 'assistant', messageId: 'm1', blocks: [{ kind: 'tool_use', toolUseId: 't1', name: 'Bash', input: { command: 'ls' }, inputTruncated: false }] },
    { type: 'tool-result', toolUseId: 't1', text: 'a.txt', isError: false, truncated: false },
    { type: 'text-delta', messageId: 'm1', index: 1, text: 'ignored after final' },
    { type: 'status', status: 'requesting' },
    { type: 'result', result: { subtype: 'success', isError: false, durationMs: 1, durationApiMs: 1, numTurns: 1, totalCostUsd: 0, stopReason: null, usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, text: 'Hello' } },
  ])
  assert.equal(view.seq, 17); assert.equal(view.init.nativeSessionId, 's')
  assert.deepEqual(view.items.map(item => [item.id, item.role]), [['m1', 'assistant'], ['result:t1', 'user']])
  assert.deepEqual(view.items[0].blocks.map(entry => [entry.block.kind, entry.state]), [['thinking', 'final'], ['text', 'final'], ['tool_use', 'final']])
  assert.equal(view.items[0].blocks[0].block.text, 'Plan the reply'); assert.equal(view.items[0].blocks[1].block.text, 'Hello')
  assert.deepEqual(view.items[0].blocks[2].block.input, { command: 'ls' })
  assert.equal(view.items[1].blocks[0].block.text, 'a.txt'); assert.equal(view.modelStatus, null); assert.equal(view.result.text, 'Hello')
})
test('the live view is bounded: block text, items, notices and approvals keep the newest entries', () => {
  let view = fold([{ type: 'message-start', messageId: 'm' }, { type: 'block-start', messageId: 'm', index: 0, block: 'text' }])
  view = applyRunEvent(view, { type: 'text-delta', messageId: 'm', index: 0, text: 'x'.repeat(liveViewLimits.blockText + 5) })
  assert.equal(view.items[0].blocks[0].block.text.length, liveViewLimits.blockText); assert.equal(view.items[0].blocks[0].block.truncated, true)
  for (let i = 0; i < liveViewLimits.items + 10; i++) view = applyRunEvent(view, { type: 'message-start', messageId: `m${i}` })
  assert.equal(view.items.length, liveViewLimits.items); assert.equal(view.items.at(-1).id, `m${liveViewLimits.items + 9}`)
  for (let i = 0; i < liveViewLimits.notices + 3; i++) view = applyRunEvent(view, { type: 'notice', notice: { code: 'n', message: String(i) } })
  assert.equal(view.notices.length, liveViewLimits.notices); assert.equal(view.notices.at(-1).message, String(liveViewLimits.notices + 2))
  assert.deepEqual(boundedJson({ a: 'b'.repeat(20) }, 10), { input: { preview: '{"a":"bbbb' }, truncated: true })
  assert.deepEqual(boundedJson(undefined, 10), { input: null, truncated: false })
})
test('the translator maps SDK frames to application events and ignores subagent and unknown frames', () => {
  const translate = createMessageTranslator()
  const init = { type: 'system', subtype: 'init', session_id: 'sess', model: 'claude-opus-5', cwd: '/p', permissionMode: 'default', claude_code_version: '2.1.278', tools: ['Bash', 'Read'], uuid: 'u', apiKeySource: 'none', mcp_servers: [], slash_commands: [], output_style: 'default', skills: [], plugins: [] }
  assert.deepEqual(translate(init), [{ type: 'init', init: { nativeSessionId: 'sess', model: 'claude-opus-5', cwd: '/p', permissionMode: 'default', claudeCodeVersion: '2.1.278', toolCount: 2 } }])
  const stream = event => ({ type: 'stream_event', event, parent_tool_use_id: null, uuid: 'u', session_id: 'sess' })
  assert.deepEqual(translate(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'orphan' } })), [], 'deltas before message_start have no message')
  assert.deepEqual(translate(stream({ type: 'message_start', message: { id: 'msg', role: 'assistant', content: [] } })), [{ type: 'message-start', messageId: 'msg' }])
  assert.deepEqual(translate(stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })), [{ type: 'block-start', messageId: 'msg', index: 0, block: 'thinking' }])
  assert.deepEqual(translate(stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } })), [{ type: 'thinking-delta', messageId: 'msg', index: 0, text: 'hm' }])
  assert.deepEqual(translate(stream({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: {} } })), [{ type: 'block-start', messageId: 'msg', index: 1, block: 'tool_use', toolUseId: 't1', name: 'Bash' }])
  assert.deepEqual(translate(stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"co' } })), [])
  assert.deepEqual(translate(stream({ type: 'content_block_stop', index: 1 })), [{ type: 'block-stop', messageId: 'msg', index: 1 }])
  assert.deepEqual(translate(stream({ type: 'message_stop' })), [])
  assert.deepEqual(translate(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'late' } })), [])
  const assistant = { type: 'assistant', uuid: 'u2', session_id: 'sess', parent_tool_use_id: null, message: { id: 'msg', role: 'assistant', content: [{ type: 'text', text: 'Hi' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }, { type: 'server_tool_use', id: 'x' }] } }
  assert.deepEqual(translate(assistant), [{ type: 'assistant', messageId: 'msg', blocks: [{ kind: 'text', text: 'Hi', truncated: false }, { kind: 'tool_use', toolUseId: 't1', name: 'Bash', input: { command: 'ls' }, inputTruncated: false }, { kind: 'unsupported', type: 'server_tool_use' }] }])
  assert.deepEqual(translate({ ...assistant, parent_tool_use_id: 'parent' }), [])
  const user = { type: 'user', uuid: 'u3', session_id: 'sess', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a.txt' }, { type: 'image' }], is_error: false }] } }
  assert.deepEqual(translate(user), [{ type: 'tool-result', toolUseId: 't1', text: 'a.txt\n[image]', isError: false, truncated: false }])
  assert.deepEqual(translate({ ...user, message: { role: 'user', content: 'typed prompt echo' } }), [])
  const result = translate({ type: 'result', subtype: 'success', is_error: false, duration_ms: 5, duration_api_ms: 4, num_turns: 2, total_cost_usd: 0.5, stop_reason: 'end_turn', result: 'Done', usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 7, cache_creation_input_tokens: 1 }, modelUsage: {}, permission_denials: [], uuid: 'u4', session_id: 'sess' })
  assert.deepEqual(result, [{ type: 'result', result: { subtype: 'success', isError: false, durationMs: 5, durationApiMs: 4, numTurns: 2, totalCostUsd: 0.5, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 3, cacheReadInputTokens: 7, cacheCreationInputTokens: 1 }, text: 'Done' } }])
  const failed = translate({ type: 'result', subtype: 'error_during_execution', is_error: true, duration_ms: 5, duration_api_ms: 0, num_turns: 0, total_cost_usd: 0, stop_reason: null, errors: ['Not logged in'], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: {}, permission_denials: [], uuid: 'u5', session_id: 'sess' })
  assert.deepEqual(failed[0].result.errors, ['Not logged in']); assert.equal(failed[0].result.isError, true)
  assert.deepEqual(translate({ type: 'system', subtype: 'status', status: 'compacting', uuid: 'u', session_id: 'sess' }), [{ type: 'status', status: 'compacting' }])
  assert.deepEqual(translate({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 90000 }, uuid: 'u', session_id: 'sess' }), [{ type: 'compact', trigger: 'auto', preTokens: 90000 }])
  assert.equal(translate({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 't', message: 'denied by rule', uuid: 'u', session_id: 'sess' })[0].notice.code, 'permission-denied')
  assert.deepEqual(translate({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' }, uuid: 'u', session_id: 'sess' }), [])
  assert.deepEqual(translate({ type: 'tool_progress', tool_use_id: 't', tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: 1, uuid: 'u', session_id: 'sess' }), [])
  assert.deepEqual(blockView('nonsense'), { kind: 'unsupported', type: 'string' })
})
test('permission requests and results are whitelisted projections of the canUseTool exchange', () => {
  const signal = new AbortController().signal
  const options = { toolUseID: 'tu1', requestId: 'r1', signal, title: 'Claude wants to run ls', description: 'List files', decisionReason: 'default mode', defaultToNo: true,
    suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }], behavior: 'allow', destination: 'localSettings' }] }
  const request = permissionRequest('Bash', { command: 'ls' }, options)
  assert.deepEqual({ ...request, signal: undefined }, { toolUseId: 'tu1', toolName: 'Bash', input: { command: 'ls' }, title: 'Claude wants to run ls', description: 'List files', reason: 'default mode', defaultToNo: true, allowSessionAvailable: true, questions: null, signal: undefined })
  assert.equal(permissionRequest('Bash', {}, { ...options, suppressAlwaysAllowRule: true }).allowSessionAvailable, false)
  assert.equal(permissionRequest('Bash', {}, { toolUseID: 'tu1', requestId: 'r1', signal }).allowSessionAvailable, false)
  assert.deepEqual(permissionResult({ behavior: 'allow' }, 'Bash', { command: 'ls' }, options), { behavior: 'allow', updatedInput: { command: 'ls' }, toolUseID: 'tu1', decisionClassification: 'user_temporary' })
  assert.deepEqual(permissionResult({ behavior: 'allow', session: true }, 'Bash', { command: 'ls' }, options), { behavior: 'allow', updatedInput: { command: 'ls' }, toolUseID: 'tu1', decisionClassification: 'user_permanent',
    updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }], behavior: 'allow', destination: 'session' }] })
  assert.deepEqual(permissionResult({ behavior: 'allow', session: true }, 'Edit', {}, { toolUseID: 'tu2', requestId: 'r2', signal }).updatedPermissions, [{ type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'session' }])
  assert.deepEqual(permissionResult({ behavior: 'deny', message: 'no' }, 'Bash', {}, options), { behavior: 'deny', message: 'no', toolUseID: 'tu1', decisionClassification: 'user_reject' })
  const questionsInput = { questions: [{ question: 'Which db?', header: 'Database', options: [{ label: 'Postgres', description: 'relational' }, { label: 'SQLite', description: 'embedded' }], multiSelect: false }, { question: '', options: [] }] }
  assert.deepEqual(questionViews(questionsInput), [{ question: 'Which db?', header: 'Database', options: [{ label: 'Postgres', description: 'relational' }, { label: 'SQLite', description: 'embedded' }], multiSelect: false }])
  assert.equal(questionViews({ questions: 'nope' }), null)
  const ask = permissionRequest('AskUserQuestion', questionsInput, { toolUseID: 'q1', requestId: 'r3', signal, suggestions: options.suggestions })
  assert.equal(ask.questions.length, 1); assert.equal(ask.allowSessionAvailable, true)
  assert.deepEqual(permissionResult({ behavior: 'allow', answers: { 'Which db?': 'SQLite' } }, 'AskUserQuestion', questionsInput, { toolUseID: 'q1', requestId: 'r3', signal }).updatedInput, { ...questionsInput, answers: { 'Which db?': 'SQLite' } })
  const view = approvalView({ id: 'a1', runId: 'run', threadId: 'thread', now: 't0', request: ask })
  assert.equal(view.kind, 'question'); assert.equal(view.allowSessionAvailable, false, 'questions are answered, never pre-approved for the session')
  assert.throws(() => decisionFor(view, 'allow', undefined), { code: 'invalid-input' })
  assert.throws(() => decisionFor(view, 'allow', { 'Which db?': 'SQLite', extra: 'x' }), { code: 'invalid-input' })
  assert.deepEqual(decisionFor(view, 'allow', { 'Which db?': ' SQLite ' }).outcome, { behavior: 'allow', answers: { 'Which db?': 'SQLite' } })
  const permission = approvalView({ id: 'a2', runId: 'run', threadId: 'thread', now: 't0', request })
  assert.throws(() => decisionFor(permission, 'deny', { any: 'x' }), { code: 'invalid-input' })
  assert.throws(() => decisionFor({ ...permission, allowSessionAvailable: false }, 'allow-session', undefined), { code: 'invalid-input' })
  assert.deepEqual(decisionFor(permission, 'allow-session', null).outcome, { behavior: 'allow', session: true })
  assert.throws(() => decisionFor(permission, 'maybe', undefined), { code: 'invalid-input' })
})
test('history projection keeps main-thread user and assistant messages only', () => {
  const messages = historyMessages([
    { type: 'user', uuid: 'u1', session_id: 's', parent_tool_use_id: null, parent_agent_id: null, message: { role: 'user', content: 'hello' } },
    { type: 'assistant', uuid: 'a1', session_id: 's', parent_tool_use_id: null, parent_agent_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't', name: 'Read', input: { file_path: '/x' } }] } },
    { type: 'user', uuid: 'u2', session_id: 's', parent_tool_use_id: null, parent_agent_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'file body', is_error: true }] } },
    { type: 'assistant', uuid: 'sub', session_id: 's', parent_tool_use_id: 't', parent_agent_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent' }] } },
    { type: 'system', uuid: 'sys', session_id: 's', parent_tool_use_id: null, parent_agent_id: null, message: {} },
    { type: 'user', uuid: 'empty', session_id: 's', parent_tool_use_id: null, parent_agent_id: null, message: { role: 'user', content: [] } },
  ])
  assert.deepEqual(messages.map(message => [message.id, message.role, message.blocks.map(block => block.kind)]), [['u1', 'user', ['text']], ['a1', 'assistant', ['text', 'tool_use']], ['u2', 'user', ['tool_result']]])
  assert.equal(messages[2].blocks[0].isError, true)
})
test('inputs are validated before any resource is touched', () => {
  assert.deepEqual(validateThreadInput({ projectPath: ' /tmp/project ', title: ' Demo ' }), { projectPath: '/tmp/project', title: 'Demo' })
  assert.throws(() => validateThreadInput({ projectPath: 'relative/path' }), { code: 'project-path-invalid' })
  assert.throws(() => validateThreadInput({ projectPath: '/tmp', extra: true }), { code: 'invalid-input' })
  assert.deepEqual(validateRunInput({ prompt: 'hi', idempotencyKey: 'k-1', model: 'claude-sonnet-5', effort: 'high' }), { prompt: 'hi', idempotencyKey: 'k-1', model: 'claude-sonnet-5', effort: 'high' })
  assert.deepEqual(validateRunInput({ prompt: 'hi', idempotencyKey: 'k', model: null, effort: null }), { prompt: 'hi', idempotencyKey: 'k' })
  assert.throws(() => validateRunInput({ prompt: '   ', idempotencyKey: 'k' }), { code: 'invalid-input' })
  assert.throws(() => validateRunInput({ prompt: 'hi', idempotencyKey: 'bad key!' }), { code: 'invalid-input' })
  assert.throws(() => validateRunInput({ prompt: 'hi', idempotencyKey: 'k', effort: 'ultra' }), { code: 'invalid-input' })
  assert.throws(() => validateRunInput({ prompt: 'x'.repeat(256 * 1024 + 1), idempotencyKey: 'k' }), { code: 'request-too-large' })
})
test('a prompt title is the first non-empty line, collapsed and bounded to 60 characters', () => {
  assert.equal(promptTitle('\n\n  Fix   the   build \nmore detail'), 'Fix the build')
  assert.equal(promptTitle('x'.repeat(80)), `${'x'.repeat(59)}…`); assert.equal(promptTitle('x'.repeat(60)), 'x'.repeat(60))
  assert.equal(promptTitle('   \n  '), '')
})

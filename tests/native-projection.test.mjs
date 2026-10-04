import assert from 'node:assert/strict'
import test from 'node:test'
import { boundProtocolView, reduceNativeView, reduceNativeExchange, projectProtocolRecords, projectNativeRequest, projectNativeResponse, projectNativeExchange } from '../dist/applications/harness/core/protocol-agents/projection.js'
import { decodeProtocolView } from '../dist/applications/harness/core/view/decode.js'
const envelope = (protocolId, exchanges) => ({ envelopeVersion: 1, viewSchemaVersion: 2, protocolId,
  sessionId: 'session', runId: 'run', viewRevision: 1, status: 'provisional', exchanges })
const exchange = (protocolId, response, diagnostic = false) => ({ id: 'e', ...projectNativeExchange(protocolId, response, diagnostic) })
const reduce = (protocolId, events) => events.reduce((current, event) => reduceNativeExchange(protocolId, current, event), { id: 'e', blocks: [] })
const safe = value => assert.doesNotMatch(JSON.stringify(value), /private-|encrypted_content|signature|credential|redacted-data/)

test('Responses preserves message phase, nested refusals, reasoning groups, citations and server search', () => {
  const raw = { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, credential: 'private-key', output: [
    { type: 'reasoning', id: 'native-r', encrypted_content: 'private-continuation', summary: [{ text: 'Summary' }, { text: 'Next' }] },
    { type: 'message', id: 'native-message', phase: 'commentary', status: 'completed', content: [
      { type: 'output_text', text: 'Answer', annotations: [{ type: 'url_citation', start_index: 0, end_index: 6, url: 'https://example.test/source', title: 'Source' }] },
      { type: 'refusal', refusal: 'Declined' }] },
    { type: 'function_call', call_id: 'request', name: 'bash', arguments: '{"command":"pwd","id":"literal"}', status: 'completed' },
    { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'topic', sources: [{ url: 'https://example.test/search', title: 'Search' }] } },
  ] }
  const view = exchange('responses', raw)
  assert.deepEqual(view.blocks.map(block => block.type), ['responses.reasoning', 'responses.message', 'responses.function_call', 'responses.web_search_call'])
  assert.deepEqual(view.blocks[0].summary.map(part => part.id), ['item-0:summary-0', 'item-0:summary-1'])
  assert.equal(view.blocks[1].phase, 'commentary')
  assert.equal(view.blocks[1].content[1].type, 'refusal')
  assert.equal(view.blocks[1].content[0].citations[0].url, 'https://example.test/source')
  assert.equal(view.blocks[2].requestId, 'request'); assert.match(view.blocks[2].arguments, /"id":"literal"/)
  assert.deepEqual(view.nativeState, { type: 'responses.state', status: 'incomplete', incompleteReason: 'max_output_tokens', partial: true })
  assert.ok(decodeProtocolView(envelope('responses', [view]))); safe(view)
  assert.equal(projectNativeResponse('responses', { output: [{ type: 'message', phase: 'private-unknown-phase', content: [] }] })[0].phase, 'unknown')
})

test('Responses stream/final use output indexes for grouped identity and preserve phase/refusal/annotations', () => {
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'first-private-id', summary: [], encrypted_content: 'private-hidden' } },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'Thought' },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'message', phase: 'final_answer', status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'Answer' },
    { type: 'response.output_text.annotation.added', output_index: 1, content_index: 0, annotation: { start_index: 0, end_index: 6, url: 'https://example.test/source' } },
    { type: 'response.refusal.delta', output_index: 1, content_index: 1, delta: 'No' },
    { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', call_id: 'request', name: 'bash', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"command":"pwd"}' },
  ]
  const streamed = reduce('responses', events), final = exchange('responses', { output: [
    { type: 'reasoning', id: 'different-id', summary: [{ text: 'Thought' }] },
    { type: 'message', phase: 'final_answer', status: 'in_progress', content: [{ type: 'output_text', text: 'Answer', annotations: [{ start_index: 0, end_index: 6, url: 'https://example.test/source' }] }, { type: 'refusal', refusal: 'No' }] },
    { type: 'function_call', call_id: 'request', name: 'bash', arguments: '{"command":"pwd"}' },
  ] })
  assert.deepEqual(streamed.blocks, final.blocks); safe(streamed)
  const reordered = reduce('responses', [events[2], events[3], events[0], events[1]])
  assert.deepEqual(reordered.blocks.map(block => block.id), ['item-0', 'item-1'])
})

test('Anthropic has distinct thinking/redacted/client/server/result blocks and safe pause/refusal states', () => {
  const raw = { stop_reason: 'pause_turn', content: [
    { type: 'thinking', thinking: 'Thinking', signature: 'private-signature' }, { type: 'redacted_thinking', data: 'redacted-data' },
    { type: 'text', text: 'Answer', citations: [{ type: 'web_search_result_location', url: 'https://example.test/source', title: 'Source', cited_text: 'Answer', encrypted_index: 'private-index' }] },
    { type: 'tool_use', id: 'request', name: 'bash', input: { command: 'pwd', id: 'literal' } },
    { type: 'server_tool_use', id: 'server-request', name: 'web_search', input: { query: 'topic' } },
    { type: 'web_search_tool_result', tool_use_id: 'server-request', content: [{ type: 'web_search_result', url: 'https://example.test/page', title: 'Page', encrypted_content: 'private-page' }] },
  ] }
  const view = exchange('anthropic-messages', raw)
  assert.deepEqual(view.blocks.map(block => block.type), ['anthropic.thinking', 'anthropic.redacted_thinking', 'anthropic.text', 'anthropic.tool_use', 'anthropic.server_tool_use', 'anthropic.web_search_tool_result'])
  assert.deepEqual(view.blocks[1], { id: 'block-1', type: 'anthropic.redacted_thinking' })
  assert.equal(view.blocks[2].citations[0].start, 'Answer'.length)
  assert.equal(view.blocks[5].requestId, 'server-request')
  assert.equal(view.nativeState.stopReason, 'pause_turn'); safe(view)
  const failed = exchange('anthropic-messages', { stop_reason: 'refusal', stop_details: { type: 'refusal', private: 'private-detail' }, content: [{ type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'too_many_requests' } }] })
  assert.equal(failed.blocks[0].status, 'failed'); assert.equal(failed.blocks[0].errorCode, 'too_many_requests'); assert.equal(failed.nativeState.stopDetailsType, 'refusal')
  assert.ok(decodeProtocolView(envelope('anthropic-messages', [view]))); safe(failed)
})

test('Anthropic streamed JSON, citations and redacted placeholders keep final identities', () => {
  const streamed = reduce('anthropic-messages', [
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: 'private-signature' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Thought' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'private-next' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call', name: 'bash', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' } },
    { type: 'content_block_start', index: 2, content_block: { type: 'redacted_thinking', data: 'redacted-data' } },
    { type: 'content_block_start', index: 3, content_block: { type: 'text', text: 'Answer' } },
    { type: 'content_block_delta', index: 3, delta: { type: 'citations_delta', citation: { url: 'https://example.test/source' } } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
  ])
  const final = exchange('anthropic-messages', { stop_reason: 'tool_use', content: [
    { type: 'thinking', thinking: 'Thought' }, { type: 'tool_use', id: 'call', name: 'bash', input: { command: 'pwd' } }, { type: 'redacted_thinking' }, { type: 'text', text: 'Answer', citations: [{ url: 'https://example.test/source' }] },
  ] })
  assert.deepEqual(streamed, final); safe(streamed)
})

test('Gemini keeps model_output content, thought summaries, annotations, function identities and interaction status', () => {
  const streamed = reduce('gemini-interactions', [
    { event_type: 'interaction.created', interaction: { status: 'in_progress', id: 'private-server-id' } },
    { event_type: 'step.start', index: 0, step: { type: 'thought', signature: 'private-signature', summary: [{ text: 'First' }] } },
    { event_type: 'step.delta', index: 0, delta: { type: 'thought_summary', content: { type: 'text', text: 'Next' } } },
    { event_type: 'step.start', index: 1, step: { type: 'model_output', content: [{ type: 'text', text: 'First answer' }, { type: 'text', text: 'Second' }] } },
    { event_type: 'step.delta', index: 1, delta: { type: 'text', text: ' answer' } },
    { event_type: 'step.delta', index: 1, delta: { type: 'text_annotation_delta', annotations: [{ kind: 'citation', url: 'https://example.test/source' }] } },
    { event_type: 'step.start', index: 2, step: { type: 'function_call', id: 'call', name: 'bash', arguments: {} } },
    { event_type: 'step.delta', index: 2, delta: { type: 'arguments_delta', arguments: '{"command":"pwd"}' } },
    { event_type: 'interaction.completed', interaction: { status: 'requires_action' } },
  ])
  const final = exchange('gemini-interactions', { status: 'requires_action', steps: [
    { type: 'thought', summary: [{ text: 'First' }, { text: 'Next' }] },
    { type: 'model_output', content: [{ type: 'text', text: 'First answer' }, { type: 'text', text: 'Second answer', annotations: [{ kind: 'citation', url: 'https://example.test/source' }] }] },
    { type: 'function_call', id: 'call', name: 'bash', arguments: { command: 'pwd' } },
  ] })
  assert.deepEqual(streamed, final); assert.ok(decodeProtocolView(envelope('gemini-interactions', [streamed]))); safe(streamed)
  assert.equal(exchange('gemini-interactions', { status: 'budget_exceeded', steps: [] }).nativeState.partial, true)
})

test('Chat streams reasoning_content, refusal and tool JSON as distinct types with stable final order', () => {
  const streamed = reduce('chat-completions', [
    { choices: [{ index: 0, delta: { content: 'Answer', tool_calls: [{ index: 0, id: 'call', function: { name: 'bash', arguments: '{"command":' } }] } }] },
    { choices: [{ index: 0, delta: { reasoning_content: 'Thought', refusal: 'No', tool_calls: [{ index: 0, function: { arguments: '"pwd"}' } }], signature: 'private-signature', reasoning_details: 'private-details' }, finish_reason: 'tool_calls' }] },
  ])
  const final = exchange('chat-completions', { choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: 'Answer', reasoning_content: 'Thought', refusal: 'No', tool_calls: [{ id: 'call', function: { name: 'bash', arguments: '{"command":"pwd"}' } }] } }] })
  assert.deepEqual(streamed, final); assert.deepEqual(final.blocks.map(block => block.type), ['chat.reasoning_content', 'chat.content', 'chat.refusal', 'chat.tool_call'])
  for (const reasoning of [undefined, '', null, { text: 'private-object' }, ['private-array']]) {
    assert.deepEqual(projectNativeResponse('chat-completions', { choices: [{ message: { reasoning_content: reasoning, content: 'Answer', reasoning: 'private-alias' } }] }), [{ id: 'choice-0:content-0', type: 'chat.content', text: 'Answer' }])
  }
  assert.equal(exchange('chat-completions', { choices: [{ finish_reason: 'length' }] }).nativeState.partial, true)
  assert.ok(decodeProtocolView(envelope('chat-completions', [streamed]))); safe(streamed)
})

for (const formatVersion of [1, 2]) test(`native record v${formatVersion} reprojects without changing history and keeps diagnostic partial state`, () => {
  const records = [{ id: 'request', kind: 'request', exchangeId: 'e', formatVersion, payload: { input: [{ role: 'user', content: 'Input' }], credential: 'private-key' } },
    { id: 'diagnostic', kind: 'diagnostic', exchangeId: 'e', formatVersion, payload: { status: 'failed', error: { code: 'server_error', message: 'private-error' }, output: [
      { type: 'reasoning', encrypted_content: 'private-continuation', summary: [] }, { type: 'message', phase: 'commentary', content: [{ type: 'output_text', text: 'Partial' }] }] } }]
  const before = structuredClone(records), views = projectProtocolRecords('responses', records)
  assert.deepEqual(records, before); assert.equal(views[0].blocks[1].content[0].text, 'Partial')
  assert.deepEqual(views[0].nativeState, { type: 'responses.state', status: 'failed', errorCode: 'server_error', diagnostic: true, partial: true })
  assert.deepEqual(views[0].inputs, [{ id: 'input-0', role: 'user', text: 'Input' }]); safe(views)
  assert.ok(decodeProtocolView(envelope('responses', views)))
})

test('diagnostics show only available safe metadata and unknown protocols never interpret another native format', () => {
  const view = projectProtocolRecords('gemini-interactions', [{ id: 'd', kind: 'diagnostic', payload: { type: 'gemini_response_diagnostic', stage: 'sse-event', event_type: 'step.delta', message: 'private-message', delta: { text: 'private-body' } } }])
  assert.deepEqual(view[0].nativeState, { type: 'gemini.state', stage: 'sse-event', eventType: 'step.delta', diagnostic: true }); assert.deepEqual(view[0].blocks, []); safe(view)
  for (const protocolId of ['responses', 'anthropic-messages', 'chat-completions', 'gemini-interactions']) {
    assert.equal(exchange(protocolId, {}, true).nativeState.partial, undefined, 'metadata diagnostics do not imply partial content')
  }
  assert.deepEqual(projectNativeResponse('retired-protocol', { choices: [{ message: { content: 'private-foreign-response' } }] }), [{ id: 'unsupported', type: 'harness.unsupported', text: 'Protocol display is unavailable' }])
  assert.deepEqual(reduceNativeView('retired-protocol', [], { choices: [{ delta: { content: 'private-foreign-stream' } }] }), [])
})

const longStreams = [
  ['responses', { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: '中\n"'.repeat(1000) }],
  ['anthropic-messages', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '中\n"'.repeat(1000) } }],
  ['chat-completions', { choices: [{ delta: { reasoning_content: '中\n"'.repeat(1000) } }] }],
  ['gemini-interactions', { event_type: 'step.delta', index: 0, delta: { type: 'text', text: '中\n"'.repeat(1000) } }],
]
for (const [protocolId, event] of longStreams) test(`${protocolId} repeated long streams stay decodable with one truncation marker`, () => {
  let blocks = protocolId === 'anthropic-messages' ? reduceNativeView(protocolId, [], { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
    : protocolId === 'gemini-interactions' ? reduceNativeView(protocolId, [], { event_type: 'step.start', index: 0, step: { type: 'model_output', content: [] } }) : []
  for (let at = 0; at < 40; at++) {
    blocks = reduceNativeView(protocolId, blocks, event)
    assert.ok(Buffer.byteLength(JSON.stringify(blocks)) <= 48 * 1024)
    assert.ok(decodeProtocolView(envelope(protocolId, [{ id: 'e', blocks }])))
    assert.equal(new Set(blocks.map(block => block.id)).size, blocks.length)
  }
  assert.equal(blocks.filter(block => block.type === 'harness.display_limit').length, 1)
})

test('nested clipping, source URLs, large identifiers and empty exchanges cannot exceed the byte budget', () => {
  const source = Array.from({ length: 100 }, (_, at) => ({ id: `${at}-${'x'.repeat(10000)}`, blocks: [] }))
  source.push({ id: 'last', blocks: [{ id: 'b'.repeat(10000), type: 'responses.message', content: [{ id: 'part', type: 'output_text', text: '中'.repeat(100000), citations: [{ start: 0, end: 1, url: 'https://example.test/source', title: 'Source' }] }] }] })
  const before = structuredClone(source), output = boundProtocolView(source)
  assert.deepEqual(source, before); assert.ok(Buffer.byteLength(JSON.stringify(output)) <= 48 * 1024); assert.ok(output.length <= 64)
  assert.ok(decodeProtocolView(envelope('responses', output))); assert.deepEqual(boundProtocolView(output), output)
  assert.deepEqual(output.find(exchange => exchange.id === 'last').blocks[0].content[0].citations, [])
})
const protocols = ['responses', 'anthropic-messages', 'chat-completions', 'gemini-interactions']
const prompt = (kind, role, content) => ({ versionId: kind + role, documentId: kind + role, kind, role, content })
function request(protocolId, prompts, text) {
  const messages = [...prompts.map(({ role, content }) => ({ role, content })), { role: 'user', content: text }]
  const image = protocolId === 'responses' ? { type: 'input_image', image_url: 'data:private-image;base64,secret-image' }
    : { type: 'image_url', image_url: { url: 'data:private-image;base64,secret-image' } }
  if (protocolId === 'responses') return { input: [...messages.slice(0, -1),
    { role: 'user', content: [{ type: 'input_text', text }, image] }], encrypted_content: 'private-continuation' }
  if (protocolId.endsWith('chat-completions')) return { messages: [...messages.slice(0, -1),
    { role: 'user', content: [{ type: 'text', text }, image] }], credential: 'private-key' }
  const users = prompts.filter(item => item.role === 'user').map(item => ({ type: 'text', text: item.content }))
  const system = prompts.filter(item => item.role !== 'user').map(item => item.content)
  if (protocolId === 'anthropic-messages') return {
    ...(system.length ? { system: system.map(text => ({ type: 'text', text, signature: 'private-signature' })) } : {}),
    messages: [...users.map(content => ({ role: 'user', content: [content] })),
      { role: 'user', content: [{ type: 'text', text }, { type: 'image', source: { type: 'base64', data: 'secret-image' } }] }],
  }
  return { ...(system.length ? { system_instruction: system.join('\n\n') } : {}),
    input: [...users.map(content => ({ type: 'user_input', content: [content] })),
      { type: 'user_input', content: [{ type: 'text', text }, { type: 'image', data: 'secret-image', signature: 'private-signature' }] }],
    continuation: 'private-continuation' }
}
function toolRequest(protocolId) {
  if (protocolId === 'responses') return { input: [{ type: 'function_call_output', call_id: 'call', output: 'private-tool-replay' }] }
  if (protocolId.endsWith('chat-completions')) return { messages: [{ role: 'tool', tool_call_id: 'call', content: 'private-tool-replay' }] }
  if (protocolId === 'anthropic-messages') return { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'private-tool-replay' }] }] }
  return { input: [{ type: 'function_result', call_id: 'call', result: [{ type: 'text', text: 'private-tool-replay' }] }] }
}

for (const protocolId of protocols) test(`${protocolId}: request projection classifies accepted prompts without repeating inherited context or template expansion`, () => {
  const prompts = [prompt('agent-instruction', 'system', 'System instruction'),
    prompt('context', 'developer', 'Developer context'),
    prompt('context', 'user', 'Literal {{input}} context')]
  const snapshots = [...prompts, prompt('task-template', 'user', 'TASK:{{input}}')]
  const text = 'TASK:Literal {{input}} context\n\nStored file: literal {{input}}'
  const initial = projectNativeRequest(protocolId, request(protocolId, prompts, text), snapshots)
  assert.deepEqual(initial.map(({ role, text }) => ({ role, text })), [
    ...prompts.map(item => ({ role: item.kind === 'context' ? 'context' : 'system', text: item.content })), { role: 'user', text }])
  assert.equal(initial.filter(item => item.role === 'user').length, 1)
  assert.doesNotMatch(JSON.stringify(initial), /private-|secret-image/)
  const child = projectNativeRequest(protocolId, request(protocolId, [], 'Literal {{input}} context'), snapshots)
  assert.deepEqual(child.map(({ role, text }) => ({ role, text })), [{ role: 'user', text: 'Literal {{input}} context' }])
  assert.deepEqual(projectNativeRequest(protocolId, toolRequest(protocolId), snapshots), [])
  const conservative = projectNativeRequest(protocolId, request(protocolId, prompts, text))
  assert.ok(conservative.some(item => item.role === 'system'))
  assert.equal(conservative.at(-1).text, text)
  assert.ok(!conservative.some(item => item.role === 'context'))
})


test('unsupported request blocks, tool continuation, signatures and image bytes never become display input', () => {
  assert.deepEqual(projectNativeRequest('responses', { input: [{ role: 'assistant', content: 'private-continuation' }, { role: 'user', content: [{ type: 'reasoning', text: 'private-thinking' }] }] }), [])
  assert.deepEqual(projectNativeRequest('anthropic-messages', { messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'private-thinking', signature: 'private-signature' }] }] }), [])
  assert.deepEqual(projectNativeRequest('gemini-interactions', { input: [{ type: 'model_output', content: [{ type: 'text', text: 'private-model-output' }] }] }), [])
  assert.deepEqual(projectNativeRequest('unknown-protocol', { input: 'private-input' }), [])
})

test('native terminal states never regress on late lifecycle frames', () => {
  const responses = reduce('responses', [{ type: 'response.completed', response: { status: 'completed', output: [] } }, { type: 'response.in_progress' }])
  assert.equal(responses.nativeState.status, 'completed')
  const anthropic = reduce('anthropic-messages', [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_start', message: { content: [] } }])
  assert.equal(anthropic.nativeState.stopReason, 'end_turn')
  const gemini = reduce('gemini-interactions', [{ event_type: 'interaction.status_update', status: 'in_progress' }, { event_type: 'interaction.completed', interaction: { status: 'completed' } }, { event_type: 'interaction.in_progress' }])
  assert.equal(gemini.nativeState.status, 'completed')
  const missing = reduce('gemini-interactions', [{ event_type: 'interaction.created', interaction: { object: 'interaction' } }])
  assert.equal(missing.nativeState.status, undefined, 'event name does not fabricate an absent native status')
})

test('exhausted nested text budgets empty earlier parts and converge without retaining full strings', () => {
  for (const type of ['responses.message', 'gemini.model_output', 'responses.reasoning', 'gemini.thought']) {
    const grouped = type.endsWith('message') || type.endsWith('model_output') ? { id: 'group', type, content: Array.from({ length: 16 }, (_, at) => ({ id: 'part-' + at, type: type === 'responses.message' ? 'output_text' : 'text', text: '中'.repeat(65_536) })) }
      : { id: 'group', type, summary: Array.from({ length: 16 }, (_, at) => ({ id: 'summary-' + at, text: '中'.repeat(65_536) })) }
    const bounded = boundProtocolView([{ id: 'e', blocks: [grouped] }])
    assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 48 * 1024)
    const group = bounded.find(exchange => exchange.id === 'e').blocks[0], parts = group.content ?? group.summary
    assert.ok(parts.some(part => part.text === ''))
    assert.ok(parts.every(part => part.text.length <= 16_000))
    assert.equal(bounded[0].blocks[0].type, 'harness.display_limit')
  }
})

test('Gemini summary identity survives more than 128 streamed parts and final projection keeps the same tail', () => {
  let blocks = reduceNativeView('gemini-interactions', [], { event_type: 'step.start', index: 0, step: { type: 'thought', summary: [] } })
  for (let at = 0; at < 140; at++) blocks = reduceNativeView('gemini-interactions', blocks, { event_type: 'step.delta', index: 0, delta: { type: 'thought_summary', content: { type: 'text', text: String(at) } } })
  const streamed = blocks.find(block => block.type === 'gemini.thought')
  assert.equal(streamed.summary.length, 128)
  assert.equal(new Set(streamed.summary.map(part => part.id)).size, 128)
  assert.equal(streamed.summary.at(-1).id, 'step-0:summary-139')
  const final = boundProtocolView([{ id: 'e', blocks: projectNativeResponse('gemini-interactions', { steps: [{ type: 'thought', summary: Array.from({ length: 140 }, (_, at) => ({ text: String(at) })) }] }) }]).find(exchange => exchange.id === 'e').blocks[0]
  assert.deepEqual(final.summary, streamed.summary)
})

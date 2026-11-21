import assert from 'node:assert/strict'
import { test } from 'node:test'
import { portableHistory } from '../dist/core/session/portable-history.js'

function history(protocolId, exchanges) {
  const field = protocolId === 'responses' ? 'input' : 'messages'
  return portableHistory(exchanges.flatMap(([items, payload], index) => {
    const exchangeId = `exchange-${index}`
    const record = { runId: 'run', protocolId, exchangeId, formatVersion: 2 }
    return [{ ...record, id: `request-${index}`, kind: 'request', payload: { [field]: items } },
      { ...record, id: `response-${index}`, kind: 'response', payload }]
  }))
}

const user = { role: 'user', content: 'Find the source.' }
const userEvent = { role: 'user', parts: [{ type: 'text', text: user.content }] }
const source = 'https://example.test/article'
const providerTool = (protocolId, id, phase, data) => ({ type: 'provider-tool', protocolId, name: 'web_search', id, phase, data })

test('portable Responses history carries observed search action and sources without native-only fields', () => {
  const webCall = { type: 'web_search_call', id: 'search-1', status: 'completed',
    action: { type: 'search', query: 'exact query', queries: ['exact query', 'follow up'],
      sources: [{ type: 'url', url: source, private_source_token: 'private-source-token' }], private_action: 'private-action' } }
  const webStep = { type: 'web_search_call', id: 'search-2', status: 'completed',
    action: { type: 'find_in_page', url: source, pattern: 'exact phrase' } }
  const message = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Exact answer.' }] }
  assert.deepEqual(history('responses', [[[user], { output: [webCall, webStep, message] }]]), [userEvent,
    { role: 'assistant', parts: [
      providerTool('responses', 'search-1', 'call', { action: { type: 'search', query: 'exact query', queries: ['exact query', 'follow up'] } }),
      providerTool('responses', 'search-1', 'result', { status: 'completed', sources: [{ type: 'url', url: source }] }),
      providerTool('responses', 'search-2', 'call', { action: { type: 'find_in_page', url: source, pattern: 'exact phrase' } }),
      providerTool('responses', 'search-2', 'result', { status: 'completed' }),
      { type: 'text', text: 'Exact answer.' },
    ] },
  ])
})

test('portable Anthropic history preserves server search observations around exact local tool results', () => {
  const search = { type: 'server_tool_use', id: 'search-1', name: 'web_search', input: { query: 'source query', private_input: 'private-input' } }
  const localCall = { type: 'tool_use', id: 'local-1', name: 'read', input: { file: 'notes.md' } }
  const localResult = { type: 'tool_result', tool_use_id: localCall.id, content: '{ "value": 12 }' }
  const searchResult = { type: 'web_search_tool_result', tool_use_id: search.id, content: [
    { type: 'web_search_result', url: source, title: 'Original title', page_age: null, encrypted_content: 'encrypted-document' },
  ] }
  const failedSearchResult = { type: 'web_search_tool_result', tool_use_id: 'search-2', content: {
    type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded', extra: 'private-error',
  } }
  const message = { type: 'text', text: 'After search.', citations: [{ encrypted_index: 'encrypted-index' }] }
  const firstResponse = { content: [search, localCall] }
  const secondResponse = { content: [searchResult, { ...search, id: 'search-2' }, failedSearchResult, message] }
  assert.deepEqual(history('anthropic-messages', [[[user], firstResponse], [[{ role: 'user', content: [localResult] }], secondResponse]]), [userEvent,
    { role: 'assistant', parts: [
      providerTool('anthropic-messages', search.id, 'call', { input: { query: 'source query' } }),
      { type: 'tool-call', id: localCall.id, name: localCall.name, arguments: localCall.input },
    ] },
    { role: 'tool', id: localCall.id, name: localCall.name, output: localResult.content },
    { role: 'assistant', parts: [
      providerTool('anthropic-messages', search.id, 'result', { content: [{ type: 'web_search_result', url: source, title: 'Original title', page_age: null }] }),
      providerTool('anthropic-messages', 'search-2', 'call', { input: { query: 'source query' } }),
      providerTool('anthropic-messages', 'search-2', 'result', { content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } }),
      { type: 'text', text: message.text },
    ] },
  ])
})

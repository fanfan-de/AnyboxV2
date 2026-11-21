import assert from 'node:assert/strict'
import test from 'node:test'
import { encodePortableHistory } from '../dist/core/protocol-agents/portable-history.js'
import { portableHistory } from '../dist/core/session/portable-history.js'

test('an Anthropic search resumed after pause carries public search facts across protocols', () => {
  const protocolId = 'anthropic-messages'
  const run = { runId: 'search-run', protocolId, formatVersion: 2 }
  const exchanges = [
    {
      request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'Search' }] }] },
      response: { type: 'message', role: 'assistant', stop_reason: 'pause_turn', content: [
        { type: 'server_tool_use', name: 'web_search', id: 'search-1', input: { query: 'native search' } },
      ] },
    },
    {
      request: { messages: [] },
      response: { type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [
        { type: 'web_search_tool_result', tool_use_id: 'search-1', content: [
          { type: 'web_search_result', url: 'https://example.com/source', title: 'Public source', encrypted_content: 'private-search-data' },
        ] },
        { type: 'text', text: 'Search answer', citations: [
          { type: 'web_search_result_location', url: 'https://example.com/source', encrypted_index: 'private-search-index' },
        ] },
      ] },
    },
  ]
  const records = exchanges.flatMap(({ request, response }, index) => [
    { ...run, id: `request-${index}`, exchangeId: `exchange-${index}`, kind: 'request', payload: request },
    { ...run, id: `response-${index}`, exchangeId: `exchange-${index}`, kind: 'response', payload: response },
  ])

  const history = portableHistory(records)
  assert.deepEqual(history.map(event => event.role), ['user', 'assistant', 'assistant'])
  assert.deepEqual(history[2].parts[0].data.content, [
    { type: 'web_search_result', url: 'https://example.com/source', title: 'Public source' },
  ])

  const gemini = encodePortableHistory('gemini-interactions', history)
  assert.deepEqual(gemini.items.map(item => item.type), ['user_input', 'model_output', 'model_output', 'model_output'])
  assert.deepEqual(gemini.items.at(-1).content[0], { type: 'text', text: 'Search answer' })
  assert.deepEqual(JSON.parse(gemini.items.at(-1).content[1].text).citations.map(citation => citation.url), ['https://example.com/source'])
  assert.match(JSON.stringify(gemini), /native search/)
  assert.match(JSON.stringify(gemini), /Public source/)
  assert.doesNotMatch(JSON.stringify(gemini), /private-search/)
})

test('Responses answer annotations carry safe public citations without full search sources', () => {
  const record = { runId: 'search-run', protocolId: 'responses', formatVersion: 2, exchangeId: 'exchange-0' }
  const records = [
    { ...record, id: 'request-0', kind: 'request', payload: { input: [{ role: 'user', content: 'Find a source' }] } },
    { ...record, id: 'response-0', kind: 'response', payload: { status: 'completed', output: [
      { type: 'web_search_call', id: 'search-1', status: 'completed', action: { type: 'search', query: 'source' } },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Search answer', annotations: [
        { type: 'url_citation', start_index: 0, end_index: 6, url: 'https://example.com/source', title: 'Public source' },
        { type: 'url_citation', start_index: 0, end_index: 6, url: 'javascript:private-link' },
        { type: 'url_citation', start_index: 0, end_index: 6, url: 'https://user:private-password@example.com/source' },
        { type: 'file_citation', file_id: 'private-file-handle', url: 'https://example.com/private-file' },
      ] }] },
    ] } },
  ]
  const history = portableHistory(records)
  const citations = [{ start: 0, end: 6, url: 'https://example.com/source', title: 'Public source' }]
  assert.deepEqual(history.at(-1).parts.at(-1), { type: 'text', text: 'Search answer', citations })
  const anthropic = encodePortableHistory('anthropic-messages', history)
  assert.deepEqual(anthropic.items.at(-1).content.slice(-2), [
    { type: 'text', text: 'Search answer' },
    { type: 'text', text: JSON.stringify({ citations }) },
  ])
  assert.doesNotMatch(JSON.stringify(anthropic), /private-/)
})

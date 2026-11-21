import assert from 'node:assert/strict'
import test from 'node:test'
import { boundProtocolView, projectNativeExchange, projectNativeUsage, projectProtocolRecords, reduceNativeExchange } from '../packages/app-harness/dist/core/protocol-agents/projection.js'
import { decodeProtocolView, reduceProtocolView } from '../packages/app-harness/dist/core/view/decode.js'
import { boundProtocolView as boundPersonalView, projectNativeUsage as projectPersonalUsage, projectProtocolRecords as projectPersonalRecords, reduceNativeExchange as reducePersonalExchange } from '../packages/app-personal-agent/dist/core/protocol-agents/projection.js'
import { decodeProtocolView as decodePersonalView } from '../packages/app-personal-agent/dist/core/view/decode.js'

const snapshot = (protocolId, exchanges, patch = {}) => ({ envelopeVersion: 1, viewSchemaVersion: 2, protocolId,
  sessionId: 'session', runId: 'run', viewRevision: 1, status: 'provisional', exchanges, ...patch })
const empty = () => ({ id: 'exchange', blocks: [] })
const usageCases = [
  ['responses', { input_tokens: 120, output_tokens: 18, input_tokens_details: { cached_tokens: 100 }, output_tokens_details: { reasoning_tokens: 10 } }],
  ['chat-completions', { prompt_tokens: 120, completion_tokens: 18, prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 10 } }],
  ['anthropic-messages', { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 18 }],
  ['gemini-interactions', { total_input_tokens: 120, total_output_tokens: 18, total_cached_tokens: 100, total_thought_tokens: 10 }],
]

for (const [protocolId, usage] of usageCases) test(`${protocolId} safely projects per-request usage through native records and bounded views`, () => {
  const payload = { usage: { ...usage, credential: 'private-key', metadata: { signature: 'private-signature' } } }
  const record = { id: 'response', exchangeId: 'exchange', kind: 'response', formatVersion: 2, payload }
  const before = structuredClone(record), exchanges = projectProtocolRecords(protocolId, [record])
  assert.deepEqual(exchanges[0].usage, { inputTokens: 120, outputTokens: 18,
    ...(protocolId === 'chat-completions' ? { cachedInputTokens: 100, uncachedInputTokens: 20 } : {}) })
  assert.deepEqual(record, before, 'reading legacy native records never rewrites them')
  assert.deepEqual(boundProtocolView(exchanges)[0].usage, exchanges[0].usage)
  assert.deepEqual(decodeProtocolView(snapshot(protocolId, exchanges)).exchanges[0].usage, exchanges[0].usage)
  assert.doesNotMatch(JSON.stringify(exchanges), /private|credential|signature|metadata|cached_tokens|cache_read_input_tokens/)
})

test('usage preserves reported zero, partial measurements and unknown values without inferring totals', () => {
  assert.deepEqual(projectNativeUsage('responses', { usage: { input_tokens: 0, output_tokens: 0 } }), { inputTokens: 0, outputTokens: 0 })
  assert.deepEqual(projectNativeUsage('responses', { usage: { input_tokens: 0 } }), { inputTokens: 0 })
  assert.deepEqual(projectNativeUsage('responses', { usage: { output_tokens: 6 } }), { outputTokens: 6 })
  for (const usage of [undefined, null, [], {}, { total_tokens: 500 }, { input_tokens: '50', output_tokens: -1 }, { input_tokens: NaN, output_tokens: Infinity }, { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 1.5 }]) {
    assert.equal(projectNativeUsage('responses', { usage }), undefined)
  }
  assert.equal(projectNativeUsage('retired-protocol', { usage: { input_tokens: 10, output_tokens: 20 } }), undefined)
  assert.deepEqual(projectNativeUsage('responses', { usage: { input_tokens: 10, output_tokens: 'unknown' } }), { inputTokens: 10 })
  assert.equal(projectNativeUsage('anthropic-messages', { usage: { cache_read_input_tokens: 5 } }), undefined, 'a missing base input count is unknown')
  assert.deepEqual(projectNativeUsage('anthropic-messages', { usage: { input_tokens: 5, cache_read_input_tokens: 'unknown', output_tokens: 6 } }), { outputTokens: 6 })
  assert.deepEqual(projectNativeUsage('anthropic-messages', { usage: { input_tokens: Number.MAX_SAFE_INTEGER, cache_creation_input_tokens: 1, output_tokens: 0 } }), { outputTokens: 0 })
})

test('Anthropic stream combines initial input/cache buckets with cumulative output deltas', () => {
  let exchange = reduceNativeExchange('anthropic-messages', empty(), { type: 'message_start', message: {
    usage: { input_tokens: 20, cache_read_input_tokens: 80, cache_creation_input_tokens: 10, output_tokens: 1 },
  } })
  assert.deepEqual(exchange.usage, { inputTokens: 110, outputTokens: 1 })
  exchange = reduceNativeExchange('anthropic-messages', exchange, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } })
  exchange = reduceNativeExchange('anthropic-messages', exchange, { type: 'message_delta', delta: {}, usage: { output_tokens: 10 } })
  exchange = reduceNativeExchange('anthropic-messages', exchange, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 18 } })
  assert.deepEqual(exchange.usage, { inputTokens: 110, outputTokens: 18 }, 'deltas replace cumulative counts, not sum them')
  exchange = reduceNativeExchange('anthropic-messages', exchange, { type: 'message_delta', delta: {}, usage: { input_tokens: 20, output_tokens: 20 } })
  assert.deepEqual(exchange.usage, { inputTokens: 110, outputTokens: 20 }, 'partial input deltas cannot drop previously reported cache buckets')
  assert.deepEqual(decodeProtocolView(snapshot('anthropic-messages', boundProtocolView([exchange]))).exchanges[0].usage, exchange.usage)
})

test('Responses, Chat and Gemini stream terminal measurements use only their native usage fields', () => {
  const cases = [
    ['responses', { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 120, output_tokens: 18 } } }],
    ['chat-completions', { choices: [], usage: { prompt_tokens: 120, completion_tokens: 18 } }],
    ['gemini-interactions', { event_type: 'interaction.completed', interaction: { status: 'completed', usage: { total_input_tokens: 120, total_output_tokens: 18 } } }],
  ]
  for (const [protocolId, event] of cases) {
    let exchange = reduceNativeExchange(protocolId, empty(), event)
    exchange = reduceNativeExchange(protocolId, exchange, event)
    assert.deepEqual(exchange.usage, { inputTokens: 120, outputTokens: 18 })
    assert.deepEqual(decodeProtocolView(snapshot(protocolId, [exchange])).exchanges[0].usage, exchange.usage)
  }
})

test('a later exchange without usage stays unknown and committed views replace provisional counts', () => {
  const exchanges = projectProtocolRecords('responses', [
    { id: 'r1', exchangeId: 'first', kind: 'response', payload: { usage: { input_tokens: 100, output_tokens: 10 } } },
    { id: 'q2', exchangeId: 'second', kind: 'request', payload: { input: [{ role: 'user', content: 'Next' }] } },
    { id: 'r2', exchangeId: 'second', kind: 'response', payload: { output: [] } },
  ])
  assert.deepEqual(exchanges[0].usage, { inputTokens: 100, outputTokens: 10 })
  assert.equal(exchanges[1].usage, undefined)
  const next = reduceNativeExchange('responses', { id: 'new', blocks: [] }, { type: 'response.in_progress' })
  assert.equal(next.usage, undefined)
  const provisional = snapshot('responses', [{ id: 'first', ...projectNativeExchange('responses', { usage: { input_tokens: 100, output_tokens: 5 } }) }])
  const committed = snapshot('responses', exchanges, { status: 'committed', viewRevision: 2 })
  assert.deepEqual(reduceProtocolView(provisional, committed), committed)
})

test('browser view decoder whitelists usage counts, rejects invalid values and accepts old views', () => {
  const frame = usage => snapshot('responses', [{ ...empty(), ...(usage === undefined ? {} : { usage }) }])
  assert.deepEqual(decodeProtocolView(frame({ inputTokens: 0, outputTokens: 10, credential: 'private-key' })).exchanges[0].usage, { inputTokens: 0, outputTokens: 10 })
  assert.equal(decodeProtocolView(frame()).exchanges[0].usage, undefined)
  for (const usage of [null, [], {}, { totalTokens: 10 }, { inputTokens: -1 }, { inputTokens: 1.5 }, { inputTokens: Infinity }, { inputTokens: NaN }, { inputTokens: '10' }, { outputTokens: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal(decodeProtocolView(frame(usage)), undefined)
  }
})

const cacheProjections = [
  { product: 'Anybox Harness', project: projectNativeUsage, reduce: reduceNativeExchange, projectRecords: projectProtocolRecords,
    bound: boundProtocolView, decode: decodeProtocolView },
  { product: 'Personal Agent', project: projectPersonalUsage, reduce: reducePersonalExchange, projectRecords: projectPersonalRecords,
    bound: boundPersonalView, decode: decodePersonalView },
]
for (const { product, project } of cacheProjections) test(`${product} projects explicit DeepSeek cache counts and falls back to generic Chat usage`, () => {
  const chat = usage => project('chat-completions', { usage })
  const totals = { prompt_tokens: 120, completion_tokens: 18 }
  assert.deepEqual(chat({ ...totals, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 120,
    prompt_tokens_details: { cached_tokens: 100 } }), { inputTokens: 120, outputTokens: 18, cachedInputTokens: 0, uncachedInputTokens: 120 })
  assert.deepEqual(chat({ ...totals, prompt_tokens_details: { cached_tokens: 100 } }),
    { inputTokens: 120, outputTokens: 18, cachedInputTokens: 100, uncachedInputTokens: 20 })
  assert.deepEqual(chat({ ...totals, prompt_cache_hit_tokens: 120 }),
    { inputTokens: 120, outputTokens: 18, cachedInputTokens: 120, uncachedInputTokens: 0 })
  assert.deepEqual(chat({ ...totals, prompt_cache_miss_tokens: 18 }),
    { inputTokens: 120, outputTokens: 18, uncachedInputTokens: 18 }, 'a reported miss alone does not imply a reported hit')
  assert.deepEqual(chat({ prompt_cache_hit_tokens: 0 }), { cachedInputTokens: 0 }, 'no prompt total is available from which to derive a miss')
  assert.equal(chat({ ...totals, prompt_tokens_details: { cached_tokens: 121 } }).uncachedInputTokens, undefined)
  assert.deepEqual(chat({ ...totals, prompt_cache_hit_tokens: '0', prompt_cache_miss_tokens: -1 }),
    { inputTokens: 120, outputTokens: 18 })
  assert.deepEqual(chat(totals), { inputTokens: 120, outputTokens: 18 }, 'older records do not gain cache counts')
})

for (const { product, reduce, projectRecords, bound, decode } of cacheProjections) test(`${product} preserves sanitized per-exchange cache counts through live and committed views`, () => {
  const protocolId = 'chat-completions'
  const usage = { prompt_tokens: 768, completion_tokens: 12, prompt_cache_hit_tokens: 640, prompt_cache_miss_tokens: 128 }
  const first = reduce(protocolId, { id: 'first', blocks: [] }, { choices: [], usage })
  assert.deepEqual(first.usage, { inputTokens: 768, outputTokens: 12, cachedInputTokens: 640, uncachedInputTokens: 128 })
  const second = reduce(protocolId, { id: 'second', blocks: [] }, { choices: [], usage: { prompt_tokens: 900, completion_tokens: 18 } })
  assert.deepEqual(second.usage, { inputTokens: 900, outputTokens: 18 })

  const records = [
    { id: 'r1', exchangeId: 'first', kind: 'response', payload: { usage: { ...usage, credential: 'private-key' } } },
    { id: 'r2', exchangeId: 'second', kind: 'response', payload: { usage: { prompt_tokens: 900, completion_tokens: 18 } } },
  ]
  const before = structuredClone(records)
  const exchanges = projectRecords(protocolId, records)
  const frame = snapshot(protocolId, bound(exchanges), { status: 'committed' })
  const decoded = decode(frame)
  assert.deepEqual(decoded?.exchanges.map(exchange => exchange.usage), [first.usage, second.usage])
  assert.deepEqual(records, before)
  assert.doesNotMatch(JSON.stringify(decoded), /private-key|prompt_cache_hit_tokens|prompt_cache_miss_tokens/)

  const extra = snapshot(protocolId, [{ ...empty(), usage: { cachedInputTokens: 0, uncachedInputTokens: 4, credential: 'private-key' } }])
  assert.deepEqual(decode(extra)?.exchanges[0].usage, { cachedInputTokens: 0, uncachedInputTokens: 4 })
  assert.equal(decode(snapshot(protocolId, [{ ...empty(), usage: { cachedInputTokens: -1 } }])), undefined)
})

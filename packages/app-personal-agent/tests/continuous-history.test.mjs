import assert from 'node:assert/strict'
import test from 'node:test'
import { estimateNativeIntent, estimateNativePrefix } from '../dist/core/protocol-agents/context-estimate.js'
import { contextUsage } from '../dist/web/context-usage.js'

test('native input estimate uses the latest full input measurement and counts only replayed deltas', () => {
  const chat = (message, input) => ({ kind: 'response', payload: { choices: [{ message }],
    usage: { ...(input === undefined ? {} : { prompt_tokens: input }), completion_tokens: 10_000 } } })
  const assistant = { role: 'assistant', content: 'Recorded.', reasoning_content: 'Native reasoning.' }
  const earlier = chat(assistant, 20)
  const initial = { kind: 'request', payload: { messages: [{ role: 'system', content: 'x'.repeat(12_000) }] } }
  const latest = chat(assistant, 1_200)
  const noBaseline = () => assert.fail('measured native history should not re-estimate the earlier prefix')
  const replayTokens = estimateNativeIntent(assistant)
  assert.equal(estimateNativePrefix('chat-completions', [earlier, initial, latest], noBaseline), 1_200 + replayTokens)
  const next = { kind: 'request', payload: { messages: [{ role: 'user', content: 'Continue.' }] } }
  const more = chat(assistant)
  assert.equal(estimateNativePrefix('chat-completions', [earlier, initial, latest, next, more], noBaseline),
    1_200 + replayTokens * 2 + estimateNativeIntent(next.payload))
  assert.equal(estimateNativePrefix('chat-completions', [next, more], () => 50),
    50 + replayTokens + estimateNativeIntent(next.payload))
})

test('the running context view uses the first-request estimate until the provider reports usage', () => {
  const run = { id: 'run', status: 'running', modelId: 'model', history: { kind: 'tree', parentNodeId: null }, estimatedInputTokens: 1234 }
  const state = { session: { modelId: 'model' }, position: { viewNodeId: null }, runs: [run], path: [], views: new Map() }
  assert.match(contextUsage(state).label, /本轮输入估计 1,234 tokens/)
  state.views.set(run.id, { exchanges: [{ usage: { inputTokens: 1200, outputTokens: 40 } }] })
  assert.equal(contextUsage(state).inputTokens, 1200)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { boundProtocolView, reduceNativeView, projectProtocolRecords, projectNativeResponse } from '../dist/harness/protocol-agents/projection.js'
import { decodeProtocolView } from '../dist/client/protocols/view.js'

const envelope = exchanges => ({ envelopeVersion: 1, viewSchemaVersion: 1, protocolId: 'responses',
  sessionId: 'session', runId: 'run', viewRevision: 1, status: 'provisional', exchanges })

test('repeated long deltas retain a single truncation marker and remain decodable', () => {
  let blocks = []
  for (let at = 0; at < 100; at++) {
    blocks = reduceNativeView('responses', blocks, { type: 'response.output_text.delta', item_id: 'message', content_index: 0, delta: '中'.repeat(1000) })
    assert.ok(decodeProtocolView(envelope([{ id: 'exchange', blocks }])))
    assert.equal(new Set(blocks.map(block => block.id)).size, blocks.length)
  }
  assert.equal(blocks.filter(block => block.id === 'display-limit').length, 1)
  assert.ok(Buffer.byteLength(JSON.stringify(blocks)) < 48 * 1024)
})

test('large native identifiers, empty exchanges and citations cannot exceed display limits', () => {
  const input = Array.from({ length: 100 }, (_, at) => ({ id: `${at}-${'x'.repeat(10000)}`, blocks: [] }))
  input.push({ id: 'last', blocks: [{ id: 'b'.repeat(10000), kind: 'text', text: 'answer',
    citations: [{ start: 0, end: 6, url: 'https://example.test/' + 'x'.repeat(100000), title: 'Title' }] }] })
  const output = boundProtocolView(input)
  assert.ok(Buffer.byteLength(JSON.stringify(output)) <= 48 * 1024)
  assert.ok(output.length <= 64)
  assert.ok(decodeProtocolView(envelope(output)))
  assert.equal(output.find(exchange => exchange.id === 'last').blocks[0].text, 'answer')
  assert.deepEqual(boundProtocolView(output), output)
})

test('display cropping never changes the native recovery records', () => {
  const records = [{ id: 'response', kind: 'response', exchangeId: 'exchange', payload: { status: 'completed', output: [
    { type: 'reasoning', encrypted_content: 'private', summary: [] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '中'.repeat(100000), annotations: [] }] }] } }]
  const before = structuredClone(records), view = projectProtocolRecords('responses', records)
  assert.deepEqual(records, before)
  assert.ok(Buffer.byteLength(JSON.stringify(view)) <= 48 * 1024)
  assert.doesNotMatch(JSON.stringify(view), /private/)
  assert.ok(decodeProtocolView(envelope(view)))
})

test('long stream identities normalize before lookup, preserving deltas without duplicate blocks', () => {
  const event = { type: 'response.output_text.delta', item_id: 'i'.repeat(10000), delta: 'one' }
  const blocks = reduceNativeView('responses', reduceNativeView('responses', [], event), { ...event, delta: 'two' })
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].text, 'onetwo')
  assert.ok(decodeProtocolView(envelope([{ id: 'exchange', blocks }])))
})

test('stream and final blocks keep identities for Responses reasoning and Anthropic client tools', () => {
  const summary = reduceNativeView('responses', [], { type: 'response.reasoning_summary_text.delta', item_id: 'rs', summary_index: 0, delta: 'summary' })
  const finalSummary = projectNativeResponse('responses', { output: [{ type: 'reasoning', id: 'rs', summary: [{ text: 'summary' }] }] })
  assert.deepEqual(summary, finalSummary)
  const tool = { type: 'tool_use', id: 'native-tool', name: 'bash', input: {} }
  const streamed = reduceNativeView('anthropic-messages', [], { type: 'content_block_start', index: 0, content_block: tool })
  assert.equal(streamed[0].id, projectNativeResponse('anthropic-messages', { content: [tool] })[0].id)
  assert.equal(streamed[0].requestId, 'native-tool')
})

test('Gemini preserves multiple content blocks and initial thought summaries throughout streaming', () => {
  const step = { id: 'native-step', type: 'model_output', content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] }
  let blocks = reduceNativeView('gemini-interactions', [], { event_type: 'step.start', index: 0, step })
  blocks = reduceNativeView('gemini-interactions', blocks, { event_type: 'step.delta', index: 0, delta: { type: 'text', text: ' delta' } })
  assert.deepEqual(blocks.map(block => block.text), ['first', 'second delta'])
  const final = projectNativeResponse('gemini-interactions', { steps: [{ ...step, content: [step.content[0], { type: 'text', text: 'second delta' }] }] })
  assert.deepEqual(blocks, final)
  const thought = { type: 'thought', signature: 'private', summary: [{ type: 'text', text: 'initial summary' }] }
  assert.deepEqual(reduceNativeView('gemini-interactions', [], { event_type: 'step.start', index: 0, step: thought }),
    projectNativeResponse('gemini-interactions', { steps: [thought] }))
})

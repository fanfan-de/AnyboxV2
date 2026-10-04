import assert from 'node:assert/strict'
import test from 'node:test'
import { runGemini } from '../dist/applications/harness/core/protocol-agents/gemini.js'

const initial = { input: [{ type: 'user_input', content: [{ type: 'text', text: 'Use the tool' }] }] }
const emptyOutput = { type: 'model_output' }
const output = text => ({ type: 'model_output', content: [{ type: 'text', text }] })
const call = { type: 'function_call', id: 'call-id', name: 'bash', arguments: { command: 'pwd' } }
const reply = (steps, status = 'completed', id = 'response-id') => ({ response: { status, steps }, records: [{ kind: 'response', id }] })

test('Gemini ignores absent model output content while preserving other response text', async () => {
  const result = await runGemini({
    async call(intent) {
      assert.deepEqual(intent, initial)
      return reply([emptyOutput, output('first'), { type: 'thought' }, emptyOutput, output('second')])
    },
    async tools() { assert.fail('a text response must not run tools') },
  }, initial)
  assert.deepEqual(result, { kind: 'completed', output: 'firstsecond', resultRecordIds: ['response-id'] })
})

test('Gemini completes a response with only absent model output content', async () => {
  const result = await runGemini({
    async call() { return reply([emptyOutput]) },
    async tools() { assert.fail('an empty response must not run tools') },
  }, initial)
  assert.deepEqual(result, { kind: 'completed', output: '', resultRecordIds: ['response-id'] })
})

test('Gemini continues tool calls when an adjacent model output omits content', async () => {
  const intents = [], result = { stdout: '/project\n', stderr: '', exitCode: 0 }
  let toolCalls = 0
  const conclusion = await runGemini({
    async call(intent) {
      intents.push(intent)
      return intents.length === 1 ? reply([emptyOutput, call], 'requires_action', 'tool-response')
        : reply([emptyOutput, output('done')], 'completed', 'final-response')
    },
    async tools(calls) {
      toolCalls++
      assert.deepEqual(calls, [{ id: call.id, name: call.name, arguments: call.arguments }])
      return [{ name: 'bash', result }]
    },
  }, initial)
  assert.equal(toolCalls, 1)
  assert.deepEqual(intents, [initial, { input: [{ type: 'function_result', call_id: 'call-id', name: 'bash',
    result: [{ type: 'text', text: JSON.stringify(result) }] }] }])
  assert.deepEqual(conclusion, { kind: 'completed', output: 'done', resultRecordIds: ['final-response'] })
})

test('Gemini rejects invalid present content before executing any collected tools', async () => {
  for (const content of [null, {}, 'text', 0, true, [null], [{ type: 'text', text: null }]]) {
    let toolCalls = 0
    await assert.rejects(runGemini({
      async call() { return reply([call, { type: 'model_output', content }], 'requires_action') },
      async tools() { toolCalls++; return [] },
    }, initial), { category: 'invalid-response' })
    assert.equal(toolCalls, 0)
  }
})

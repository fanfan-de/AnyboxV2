import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { createResponsesProtocol, createAnthropicMessagesProtocol, createChatCompletionsProtocol, createGeminiInteractionsProtocol } from '@anybox/models'
import { createExecution, validateRestore } from '../packages/models/dist/execution.js'
import { createProtocolAgentsComponent, createProtocolAgentBindingComponent } from '../dist/applications/harness/core/protocol-agents/registry.js'
import { modelSnapshot } from './helpers/controlled-models.mjs'
import { bashToolDefinition } from '../dist/applications/harness/core/tool/bash-component.js'

const factories = { responses: createResponsesProtocol, 'anthropic-messages': createAnthropicMessagesProtocol,
  'chat-completions': createChatCompletionsProtocol, 'gemini-interactions': createGeminiInteractionsProtocol }
function answer(id, tool) {
  const args = { command: 'printf original' }
  if (id === 'responses') return { status: 'completed', output: tool ? [{ type: 'function_call', call_id: 'stable-call', name: 'bash', arguments: JSON.stringify(args), status: 'completed' }]
    : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'final' }] }] }
  if (id === 'anthropic-messages') return { type: 'message', role: 'assistant', stop_reason: tool ? 'tool_use' : 'end_turn',
    content: tool ? [{ type: 'tool_use', id: 'stable-call', name: 'bash', input: args }] : [{ type: 'text', text: 'final' }] }
  if (id === 'gemini-interactions') return { status: tool ? 'requires_action' : 'completed', steps: tool
    ? [{ type: 'function_call', id: 'stable-call', name: 'bash', arguments: args }]
    : [{ type: 'model_output', content: [{ type: 'text', text: 'final' }] }] }
  return { choices: [{ index: 0, finish_reason: tool ? 'tool_calls' : 'stop', message: { role: 'assistant', content: tool ? '' : 'final',
    ...(tool ? { tool_calls: [{ id: 'stable-call', type: 'function', function: { name: 'bash', arguments: JSON.stringify(args) } }] } : {}) } }] }
}
async function fixture(protocolId) {
  const root = new Context(), requests = [], base = factories[protocolId]()
  const snapshot = { ...modelSnapshot('default', base.descriptor.version), protocolId,
    parameters: { protocolId, formatVersion: 1, value: protocolId === 'anthropic-messages' ? { max_tokens: 4096 } : {} }, capabilities: { ...modelSnapshot().capabilities, streaming: false } }
  const protocol = { ...base, exchange(input) {
    requests.push(structuredClone(input.request))
    return { result: Promise.resolve(answer(protocolId, requests.length === 1)), done: Promise.resolve(), cancel() {} }
  } }
  const lease = () => ({ protocolId, protocolVersion: protocol.descriptor.version, generationId: 'driver-generation', signal: new AbortController().signal, release() {} })
  const executions = new Set()
  await root.installComponent({ name: 'resume-model-fixture', apply(ctx) {
    ctx.provide('harness.image-assets', { readImage() { throw new Error('unexpected image read') } })
    ctx.provide('models.protocols', { acquire: lease })
    ctx.provide('models', { get() { return { parameters: { protocolId } } }, async openNative(input) {
      if (input.restore) validateRestore(input.restore, snapshot, protocol)
      const controller = new AbortController()
      const stop = () => controller.abort(); input.signal?.addEventListener('abort', stop, { once: true })
      const execution = createExecution({ protocol, snapshot, capabilities: snapshot.capabilities, controller, restore: input.restore,
        provider: { protocolId, baseUrl: 'https://fixture.invalid', auth: 'none', timeoutMs: 1000 }, onRelease() { executions.delete(execution); input.signal?.removeEventListener('abort', stop) } })
      executions.add(execution); return execution
    } })
    ctx.effect(() => async () => { await Promise.all([...executions].map(execution => execution.close())) }, 'join resume fixture executions')
  } })
  await root.installComponent(createProtocolAgentsComponent())
  await root.installComponent(createProtocolAgentBindingComponent(protocolId))
  return { root, registry: root.get('harness.protocol-agents'), requests, snapshot }
}
function recorder(records, cursors, tools) {
  return { signal: new AbortController().signal, publish() {}, executeTools: tools,
    async perform(descriptor, start) {
      const call = start(), value = await call.result; await call.done
      const observed = descriptor.observe(value)
      for (const record of [...(descriptor.records ?? []), ...(observed.records ?? [])]) records.set(record.id, record)
      if (observed.protocolCursor) cursors.push(observed.protocolCursor)
      return value
    } }
}

for (const protocolId of Object.keys(factories)) test(`${protocolId}: restored Loop consumes the committed response and appends tool output once`, async t => {
  const f = await fixture(protocolId); t.after(() => f.root.fiber.dispose())
  const input = { schemaVersion: 1, raw: 'original raw task', text: 'fixed transformed task', template: null }
  const initialization = { schemaVersion: 1, toolContractVersion: 'known-tools-v1', prompts: [], tools: [bashToolDefinition] }
  const program = await f.registry.prepare({ runId: 'run', sessionId: 'session', modelId: 'default', initialization, input, signal: new AbortController().signal })
  const records = new Map(), cursors = [], batches = []
  await program.execute(recorder(records, cursors, async (requests, scheduling, batchId) => {
    batches.push({ requests, scheduling, batchId }); throw new Error('simulated Runtime loss after response commit')
  }))
  await program.close(); program.release()
  assert.equal(f.requests.length, 1)
  const resume = { run: { id: 'run', sessionId: 'session', modelId: 'default', status: 'running', protocolBinding: program.binding,
    modelSnapshot: program.modelSnapshot, nativeInput: input, history: { kind: 'tree', parentNodeId: null } }, projectId: 'project', initialization,
    records: [...records.values()].map(record => ({ ...record, runId: 'run', protocolId })),
    state: { schemaVersion: 1, runOwnerEpoch: 2, revision: 1, stage: 'response', protocolCursor: cursors.at(-1), totalToolOutputBytes: 0 } }
  const restored = await f.registry.prepareResume({ resume, signal: new AbortController().signal })
  const resumedRecords = new Map(), resumedCursors = []
  const conclusion = await restored.execute(recorder(resumedRecords, resumedCursors, async (requests, scheduling, batchId) => {
    assert.deepEqual(requests, batches[0].requests)
    assert.equal(scheduling, 'serial')
    assert.equal(batchId, batches[0].batchId)
    return [{ name: 'bash', result: { status: 'completed', stdout: 'ORIGINAL-RESULT', stderr: '', exitCode: 0 } }]
  }))
  const exit = await restored.close(); restored.release()
  assert.equal(conclusion.kind, 'completed'); assert.equal(conclusion.output, 'final')
  assert.equal(f.requests.length, 2)
  assert.equal(JSON.stringify(f.requests[1]).split('fixed transformed task').length - 1, 1)
  assert.equal(JSON.stringify(f.requests[1]).split('ORIGINAL-RESULT').length - 1, 1)
  assert.deepEqual(exit.checkpoint.modelSnapshot, program.modelSnapshot)

  // A committed final reply can be closed and settled after takeover without another model request.
  const finalResume = { ...resume, records: [...resume.records, ...[...resumedRecords.values()].map(record => ({ ...record, runId: 'run', protocolId }))],
    state: { ...resume.state, stage: 'settling', protocolCursor: resumedCursors.at(-1), conclusion } }
  const finalProgram = await f.registry.prepareResume({ resume: finalResume, signal: new AbortController().signal })
  const replayed = await finalProgram.execute(recorder(new Map(), [], async () => { throw new Error('unexpected tools') }))
  assert.deepEqual(replayed, conclusion)
  assert.equal(f.requests.length, 2)
  assert.deepEqual((await finalProgram.close()).checkpoint.modelSnapshot, program.modelSnapshot)
  finalProgram.release()
})

test('active Run restoration rejects an account epoch change without sending another request', async t => {
  const f = await fixture('chat-completions'); t.after(() => f.root.fiber.dispose())
  const input = { schemaVersion: 1, raw: 'fixed task', text: 'fixed task', template: null }
  const initialization = { schemaVersion: 1, toolContractVersion: 'known-tools-v1', prompts: [], tools: [bashToolDefinition] }
  const program = await f.registry.prepare({ runId: 'run', sessionId: 'session', modelId: 'default', initialization, input, signal: new AbortController().signal })
  const records = new Map(), cursors = []
  await program.execute(recorder(records, cursors, async () => { throw new Error('Runtime terminated at the tool boundary') }))
  await program.close(); program.release()
  const resume = { run: { id: 'run', sessionId: 'session', modelId: 'default', status: 'running', protocolBinding: program.binding,
    modelSnapshot: program.modelSnapshot, nativeInput: input, history: { kind: 'tree', parentNodeId: null } }, projectId: 'project', initialization,
    records: [...records.values()].map(record => ({ ...record, runId: 'run', protocolId: 'chat-completions' })),
    state: { schemaVersion: 1, runOwnerEpoch: 2, revision: 1, stage: 'response', protocolCursor: cursors.at(-1), totalToolOutputBytes: 0 } }
  f.snapshot.historyScopeEpoch = 'a-different-account-epoch'
  await assert.rejects(f.registry.prepareResume({ resume, signal: new AbortController().signal }))
  assert.equal(f.requests.length, 1)
})

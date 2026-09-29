import { createProtocolAgentsComponent, createProtocolAgentBindingComponent } from '../../dist/harness/protocol-agents/registry.js'
import { modelSnapshot } from './controlled-models.mjs'

export async function installTestProtocolAgents(root) {
  if (root.get('harness.protocol-agents')) return
  await root.installComponent(createProtocolAgentsComponent())
  await root.installComponent(createProtocolAgentBindingComponent('chat-completions'))
}
export function nativeRegistration(input, snapshot = modelSnapshot(), prompts = [], parentContextRef = null, initialization) {
  return { binding: { protocolId: snapshot.protocolId, generationId: 'test-binding', driverVersion: snapshot.protocolVersion,
    loopVersion: '1.0.0', recordFormatVersion: 1, viewSchemaVersion: 1 },
    initialization: initialization ?? { schemaVersion: 1, prompts: prompts.filter(prompt => prompt.kind !== 'task-template'), tools: [], toolContractVersion: 'known-tools-v1' },
    input: { schemaVersion: 1, raw: input.input, text: input.input, template: null }, parentContextRef }
}
export async function registerNativeRun(records, id, input, now, prompts = [], snapshot = modelSnapshot()) {
  const history = await records.loadNativeHistory(input.sessionId, input.parentNodeId)
  const initialization = history?.initialization ?? await records.loadNativeInitialization(input.sessionId)
  return records.registerRun(id, input, now, prompts, snapshot, nativeRegistration(input, snapshot, prompts, history?.contextRef ?? null, initialization))
}
export const completedOutcome = (id, output, snapshot = modelSnapshot()) => ({ kind: 'completed', output, resultRecordIds: [`response:${id}`],
  records: [{ id: `request:${id}`, exchangeId: `exchange:${id}`, kind: 'request', formatVersion: 1, payload: { messages: [{ role: 'user', content: id }], tools: [] } },
    { id: `response:${id}`, exchangeId: `exchange:${id}`, kind: 'response', formatVersion: 1, payload: { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: output } }] } }],
  checkpoint: { protocolId: snapshot.protocolId, recordFormatVersion: 1, modelSnapshot: snapshot } })
export const completeNativeRun = (records, id, output, now) => records.settleRun(id, completedOutcome(id, output), now)
export async function prepareTestProgram(root, id, input) {
  const program = await root.get('harness.protocol-agents').prepare({ runId: id, sessionId: input.sessionId, modelId: input.modelId ?? 'default',
    signal: new AbortController().signal, initialization: { schemaVersion: 1, prompts: [], tools: [], toolContractVersion: 'known-tools-v1' },
    input: { schemaVersion: 1, raw: input.input, text: input.input, template: null } })
  const accepted = await root.get('harness.session-runs').registerRun(id, input, 'now', [], program.modelSnapshot,
    { binding: program.binding, input: program.input, initialization: program.initialization, parentContextRef: null })
  return { program, run: accepted.run }
}

import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Component } from '@nya/core'
import { modelsServiceKey, modelsProtocolsServiceKey } from '@anybox/models'
import type { JsonValue, ModelsService, ModelsProtocolsService, NativeExecution, NativeObject, NativeProtocolLease, NativeRestoreState } from '@anybox/models'
import { protocolAgentServiceKey } from '../run/program.js'
import type { NativeInitialization, PreparedRunProgram, PrepareRunInput, ProgramExitReport, ProtocolAgentPort, ProtocolBindingSnapshot } from '../run/program.js'
import { modelFailure, normalizeModelFailure } from '../run/model.js'
import { RunFailure } from '../run/domain.js'
import { bashToolDefinition } from '../tool/bash-component.js'
import { applyPatchToolDefinition } from '../tool/apply-patch-component.js'
import { createExchangeRunner, initialMessages, serializable, toNativeRecord, toProtocolRecord } from './shared.js'
import type { ExchangeRunner } from './shared.js'
import type { ProtocolConclusion } from '../run/program.js'
import { runResponses } from './responses.js'
import { runAnthropic } from './anthropic.js'
import { runChat } from './chat.js'
import { runGemini } from './gemini.js'

export const supportedProtocolIds = Object.freeze(['responses', 'anthropic-messages', 'chat-completions', 'gemini-interactions', 'deepseek-chat-completions'])
type Loop = (runner: ExchangeRunner, initial: NativeObject) => Promise<ProtocolConclusion>
const loops: Readonly<Record<string, Loop>> = Object.freeze({ responses: runResponses, 'anthropic-messages': runAnthropic,
  'chat-completions': runChat, 'deepseek-chat-completions': runChat, 'gemini-interactions': runGemini })
interface Owner { readonly abort: AbortController; readonly done: Promise<void>; release(): void }
interface Entry { readonly id: string; readonly protocolId: string; readonly driverGenerationId: string; readonly loop: Loop;
  readonly controller: AbortController; readonly owners: Set<Owner>; accepting: boolean; closing?: Promise<void> }
export interface ProtocolAgentRegistry extends ProtocolAgentPort {
  register(protocolId: string, driver: NativeProtocolLease): { readonly generationId: string; unregister(): Promise<void> }
}

function validateInitialization(initialization: NativeInitialization): void {
  if (initialization.schemaVersion !== 1 || initialization.toolContractVersion !== 'known-tools-v1') throw modelFailure('unsupported-request')
  const names = new Set<string>()
  for (const tool of initialization.tools) {
    const known = [bashToolDefinition, applyPatchToolDefinition].find(item => item.name === tool.name)
    if (!known || names.has(tool.name) || JSON.stringify(known) !== JSON.stringify(tool)) throw modelFailure('unsupported-request')
    names.add(tool.name)
  }
}

function encodeInitial(protocolId: string, input: PrepareRunInput): NativeObject {
  const prompts = input.history ? [] : initialMessages(input.initialization)
  const tools = input.initialization.tools
  const withTools = (encoded: readonly NativeObject[]): NativeObject => input.history ? {} : { tools: encoded }
  const declaration = (tool: typeof tools[number]) => ({ name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }), parameters: tool.parameters })
  if (protocolId === 'responses') return { input: [...prompts, { role: 'user', content: input.input.text }],
    ...withTools(tools.map(tool => ({ type: 'function', ...declaration(tool), strict: false }))) }
  if (protocolId === 'chat-completions' || protocolId === 'deepseek-chat-completions') {
    if (protocolId === 'deepseek-chat-completions' && prompts.some(prompt => prompt.role === 'developer')) throw modelFailure('unsupported-request')
    return { messages: [...prompts, { role: 'user', content: input.input.text }],
      ...withTools(tools.map(tool => ({ type: 'function', function: declaration(tool) }))) }
  }
  const instructions = prompts.filter(prompt => prompt.role === 'system' || prompt.role === 'developer').map(prompt => String(prompt.content))
  if (protocolId === 'anthropic-messages') return {
    messages: [...prompts.filter(prompt => prompt.role === 'user').map(prompt => ({ role: 'user', content: [{ type: 'text', text: prompt.content }] })),
      { role: 'user', content: [{ type: 'text', text: input.input.text }] }],
    ...(instructions.length ? { system: instructions.map(text => ({ type: 'text', text })) } : {}),
    ...withTools(tools.map(tool => ({ name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), input_schema: tool.parameters }))),
  }
  if (protocolId === 'gemini-interactions') return {
    input: [...prompts.filter(prompt => prompt.role === 'user').map(prompt => ({ type: 'user_input', content: [{ type: 'text', text: prompt.content }] })),
      { type: 'user_input', content: [{ type: 'text', text: input.input.text }] }],
    ...(instructions.length ? { system_instruction: instructions.join('\n\n') } : {}),
    ...withTools(tools.map(tool => ({ type: 'function', ...declaration(tool) }))),
  }
  throw modelFailure('unsupported-request')
}

/** Stable registry. Entries own only preparation/Run leases, never a second execution context. */
export function createProtocolAgentsComponent(): Component.Object<void, {
  [modelsServiceKey]: ModelsService; [modelsProtocolsServiceKey]: ModelsProtocolsService
}> {
  return { name: 'harness-protocol-agents', inject: [modelsServiceKey, modelsProtocolsServiceKey], apply(ctx, _config, deps) {
    const entries = new Map<string, Entry>(), retired = new Set<Entry>()
    let accepting = true
    const stop = (entry: Entry): void => {
      entry.accepting = false
      entry.controller.abort('protocol-revoked')
      for (const owner of entry.owners) owner.abort.abort('protocol-revoked')
    }
    const unregister = (entry: Entry): Promise<void> => {
      if (entry.closing) return entry.closing
      stop(entry)
      if (entries.get(entry.protocolId) === entry) entries.delete(entry.protocolId)
      retired.add(entry)
      entry.closing = Promise.all([...entry.owners].map(owner => owner.done)).then(() => { retired.delete(entry) })
      return entry.closing
    }
    ctx.effect(() => async () => {
      accepting = false
      await Promise.all([...new Set([...entries.values(), ...retired])].map(unregister))
    }, 'revoke and join protocol Run leases')
    const service: ProtocolAgentRegistry = {
      register(protocolId, driver) {
        if (!accepting || driver.signal.aborted || !loops[protocolId] || driver.protocolId !== protocolId) throw modelFailure('dependency-unavailable')
        const old = entries.get(protocolId)
        if (old) { stop(old); retired.add(old) }
        const entry: Entry = { id: randomUUID(), protocolId, driverGenerationId: driver.generationId, loop: loops[protocolId]!,
          controller: new AbortController(), owners: new Set(), accepting: true }
        const revoked = () => stop(entry)
        driver.signal.addEventListener('abort', revoked, { once: true })
        entries.set(protocolId, entry)
        return { generationId: entry.id, unregister() {
          return unregister(entry).finally(() => { driver.signal.removeEventListener('abort', revoked) })
        } }
      },
      protocolForModel(modelId) {
        const model = deps[modelsServiceKey].get(modelId)
        if (!model) throw modelFailure('model-unavailable')
        return model.parameters.protocolId
      },
      async prepare(input) {
        const protocolId = service.protocolForModel(input.modelId), entry = entries.get(protocolId)
        if (!accepting || !entry?.accepting) throw modelFailure('dependency-unavailable')
        validateInitialization(input.initialization)
        if (input.history && (input.history.binding.protocolId !== protocolId || input.history.binding.loopVersion !== '1.0.0' ||
          input.history.binding.recordFormatVersion !== 1 || input.history.initialization.toolContractVersion !== 'known-tools-v1')) throw modelFailure('unsupported-request')
        if (input.history) {
          const checkpoint = input.history.checkpoint
          if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) throw modelFailure('unsupported-request')
          const metadata = checkpoint as NativeObject
          if (metadata.protocolId !== protocolId || metadata.recordFormatVersion !== 1 ||
            !isDeepStrictEqual(metadata.modelSnapshot, input.history.modelSnapshot)) throw modelFailure('unsupported-request')
        }
        const driver = deps[modelsProtocolsServiceKey].acquire(protocolId)
        if (driver.generationId !== entry.driverGenerationId) { driver.release(); throw modelFailure('dependency-unavailable') }
        let resolve!: () => void, released = false
        const owner: Owner = { abort: new AbortController(), done: new Promise<void>(yes => { resolve = yes }), release() {
          if (released) return
          released = true; entry.owners.delete(owner); driver.release(); resolve()
        } }
        entry.owners.add(owner)
        const signal = AbortSignal.any([input.signal, owner.abort.signal, entry.controller.signal, driver.signal])
        let execution: NativeExecution | undefined
        try {
          signal.throwIfAborted()
          const restore: NativeRestoreState | undefined = input.history ? { protocolId, recordFormatVersion: 1,
            modelSnapshot: input.history.modelSnapshot, records: input.history.records.map(record => toNativeRecord(protocolId, record)) } : undefined
          execution = await deps[modelsServiceKey].openNative({ modelId: input.modelId, lease: driver, signal, ...(restore ? { restore } : {}) })
          signal.throwIfAborted()
          if (input.initialization.tools.length && !execution.capabilities.tools) throw modelFailure('unsupported-request')
          const initial = encodeInitial(protocolId, input), owned = execution
          const binding: ProtocolBindingSnapshot = { protocolId, generationId: entry.id + ':' + driver.generationId,
            driverVersion: owned.snapshot.protocolVersion, loopVersion: '1.0.0', recordFormatVersion: 1, viewSchemaVersion: 1 }
          let closing: Promise<ProgramExitReport> | undefined, executed = false
          const program: PreparedRunProgram = { binding, modelSnapshot: owned.snapshot, initialization: input.initialization, input: input.input,
            signal,
            async execute(host) {
              if (executed) throw modelFailure('invalid-response')
              executed = true
              try { return await entry.loop(createExchangeRunner(owned, host, { sessionId: input.sessionId, runId: input.runId }), initial) }
              catch (error) {
                if (host.signal.aborted || program.signal.aborted) throw error
                const failure = error instanceof RunFailure ? error : normalizeModelFailure(error)
                return { kind: 'failed', category: failure.category, error: failure.message }
              }
            },
            close() {
              closing ??= owned.close().then(report => ({ records: report.records.map(toProtocolRecord),
                checkpoint: serializable(report.restoreState ?? null), cleanup: report.cleanup === 'succeeded' ? 'completed' : 'failed' }))
              return closing
            },
            release: () => owner.release(),
          }
          return program
        } catch (error) {
          try {
            if (execution && (await execution.close()).cleanup === 'failed') throw modelFailure('cleanup-failure')
          } finally { owner.release() }
          throw normalizeModelFailure(error)
        }
      },
    }
    ctx.provide(protocolAgentServiceKey, service)
  } }
}

/** One component pins one concrete driver/Loop pair; replacing it joins only its Runs. */
export function createProtocolAgentBindingComponent(protocolId: string): Component.Object<void, {
  [protocolAgentServiceKey]: ProtocolAgentRegistry; [modelsProtocolsServiceKey]: ModelsProtocolsService
}> {
  return { name: 'harness-protocol-agent-' + protocolId, inject: [protocolAgentServiceKey, modelsProtocolsServiceKey], apply(ctx, _config, deps) {
    const lease = deps[modelsProtocolsServiceKey].acquire(protocolId)
    let registration: ReturnType<ProtocolAgentRegistry['register']>
    try { registration = deps[protocolAgentServiceKey].register(protocolId, lease) } catch (error) { lease.release(); throw error }
    ctx.effect(() => async () => { try { await registration.unregister() } finally { lease.release() } }, 'unregister and join protocol agent binding')
  } }
}

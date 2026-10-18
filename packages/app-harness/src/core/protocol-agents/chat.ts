import type { NativeObject } from '@anybox/models'
import type { ProtocolConclusion } from '../run/program.js'
import { modelFailure } from '../run/model.js'
import { validateToolBatch } from '../run/domain.js'
import { completed, jsonArguments, nativeArray, nativeObject, nativeString, nonempty, toolResult, toolImageInputs } from './shared.js'
import type { ExchangeRunner } from './shared.js'

/** All Chat Completions providers share this native Agent flow. */
export async function runChat(runner: ExchangeRunner, initial: NativeObject): Promise<ProtocolConclusion> {
  let intent = initial
  while (true) {
    const reply = await runner.call(intent), choices = nativeArray(reply.response.choices)
    if (choices.length !== 1) throw modelFailure('unsupported-request')
    const choice = nativeObject(choices[0]), message = nativeObject(choice.message)
    if (choice.finish_reason === 'length') throw modelFailure('incomplete-response')
    if (choice.finish_reason === 'content_filter' || message.refusal) throw modelFailure('refused-response')
    const calls = message.tool_calls == null ? [] : nativeArray(message.tool_calls).map(raw => {
      const call = nativeObject(raw), fn = nativeObject(call.function)
      if (call.type !== 'function') throw modelFailure('unsupported-request')
      return { id: nonempty(call.id), name: nonempty(fn.name), arguments: jsonArguments(fn.arguments) }
    })
    if (choice.finish_reason === 'tool_calls') {
      if (!calls.length) throw modelFailure('invalid-response')
      const batch = validateToolBatch(calls), results = await runner.tools(batch)
      intent = { messages: [...batch.map((call, index) => ({ role: 'tool', tool_call_id: call.id, content: toolResult(results[index]!) })), ...toolImageInputs('chat-completions', results)] }
    } else if (choice.finish_reason === 'stop') {
      if (calls.length) throw modelFailure('invalid-response')
      return completed(reply, message.content == null ? '' : nativeString(message.content))
    } else throw modelFailure('invalid-response')
  }
}

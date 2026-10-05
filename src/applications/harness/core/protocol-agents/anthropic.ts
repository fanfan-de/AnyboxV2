import type { NativeObject } from '@anybox/models'
import type { ProtocolConclusion } from '../run/program.js'
import { modelFailure } from '../run/model.js'
import { validateToolBatch } from '../run/domain.js'
import { completed, nativeArray, nativeObject, nativeString, nonempty, toolResult, toolImageInputs } from './shared.js'
import type { ExchangeRunner } from './shared.js'

/** Server pause and client tools are distinct Messages transitions. */
export async function runAnthropic(runner: ExchangeRunner, initial: NativeObject): Promise<ProtocolConclusion> {
  let intent = initial
  while (true) {
    const reply = await runner.call(intent), response = reply.response
    const reason = response.stop_reason
    if (reason === 'refusal' || (response.stop_details && typeof response.stop_details === 'object' &&
      !Array.isArray(response.stop_details) && (response.stop_details as NativeObject).type === 'refusal')) throw modelFailure('refused-response')
    if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') throw modelFailure('incomplete-response')
    const calls = [], text: string[] = []
    for (const raw of nativeArray(response.content)) {
      const block = nativeObject(raw)
      if (block.type === 'tool_use') calls.push({ id: nonempty(block.id), name: nonempty(block.name), arguments: nativeObject(block.input) })
      else if (block.type === 'text') text.push(nativeString(block.text))
      else if (!['thinking', 'redacted_thinking', 'server_tool_use', 'web_search_tool_result'].includes(String(block.type))) throw modelFailure('unsupported-request')
    }
    if (reason === 'tool_use') {
      if (!calls.length) throw modelFailure('invalid-response')
      const batch = validateToolBatch(calls), results = await runner.tools(batch)
      intent = { messages: [{ role: 'user', content: batch.map((call, index) => ({ type: 'tool_result', tool_use_id: call.id, content: toolResult(results[index]!) })) }, ...toolImageInputs('anthropic-messages', results)] }
    } else if (reason === 'pause_turn') {
      if (calls.length) throw modelFailure('invalid-response')
      // The execution already committed the exact paused assistant blocks.
      intent = { messages: [] }
    } else if (reason === 'end_turn' || reason === 'stop_sequence') {
      if (calls.length) throw modelFailure('invalid-response')
      return completed(reply, text.join(''))
    } else throw modelFailure('invalid-response')
  }
}

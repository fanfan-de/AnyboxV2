import type { NativeObject } from '@anybox/models'
import type { ProtocolConclusion } from '../run/program.js'
import { modelFailure } from '../run/model.js'
import { validateToolBatch } from '../run/domain.js'
import { completed, jsonArguments, nativeArray, nativeObject, nativeString, nonempty, toolResult } from './shared.js'
import type { ExchangeRunner } from './shared.js'

/** Responses makes its own decisions from output items and native response status. */
export async function runResponses(runner: ExchangeRunner, initial: NativeObject): Promise<ProtocolConclusion> {
  let intent = initial
  while (true) {
    const reply = await runner.call(intent), response = reply.response
    if (response.status === 'incomplete') throw modelFailure('incomplete-response')
    if (response.status !== 'completed') throw modelFailure('provider-failure')
    const calls = [], text: string[] = []
    for (const raw of nativeArray(response.output)) {
      const item = nativeObject(raw)
      if (item.status !== undefined && item.status !== 'completed') throw modelFailure('incomplete-response')
      if (item.type === 'function_call') calls.push({ id: nonempty(item.call_id), name: nonempty(item.name), arguments: jsonArguments(item.arguments) })
      else if (item.type === 'message') {
        for (const raw of nativeArray(item.content)) {
          const block = nativeObject(raw)
          if (block.type === 'refusal') throw modelFailure('refused-response')
          if (block.type !== 'output_text') throw modelFailure('unsupported-request')
          text.push(nativeString(block.text))
        }
      } else if (item.type !== 'reasoning' && item.type !== 'web_search_call') throw modelFailure('unsupported-request')
    }
    if (!calls.length) return completed(reply, text.join(''))
    const batch = validateToolBatch(calls), results = await runner.tools(batch)
    intent = { input: batch.map((call, index) => ({ type: 'function_call_output', call_id: call.id, output: toolResult(results[index]!) })) }
  }
}

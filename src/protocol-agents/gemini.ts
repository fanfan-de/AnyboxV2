import type { NativeObject } from '@anybox/models'
import type { ProtocolConclusion } from '../run/program.js'
import { modelFailure } from '../run/model.js'
import { validateToolBatch } from '../run/domain.js'
import { completed, nativeArray, nativeObject, nativeString, nonempty, toolResult } from './shared.js'
import type { ExchangeRunner } from './shared.js'

export async function runGemini(runner: ExchangeRunner, initial: NativeObject): Promise<ProtocolConclusion> {
  let intent = initial
  while (true) {
    const reply = await runner.call(intent), response = reply.response
    if (response.status === 'incomplete' || response.status === 'budget_exceeded') throw modelFailure('incomplete-response')
    if (!['completed', 'requires_action'].includes(String(response.status))) throw modelFailure('provider-failure')
    const calls = [], text: string[] = []
    for (const raw of nativeArray(response.steps)) {
      const step = nativeObject(raw)
      if (step.type === 'function_call') calls.push({ id: nonempty(step.id), name: nonempty(step.name), arguments: nativeObject(step.arguments) })
      else if (step.type === 'model_output') {
        for (const raw of nativeArray(step.content)) {
          const block = nativeObject(raw)
          if (block.type !== 'text') throw modelFailure('unsupported-request')
          text.push(nativeString(block.text))
        }
      } else if (step.type !== 'thought') throw modelFailure('unsupported-request')
    }
    if (!calls.length) {
      if (response.status === 'requires_action') throw modelFailure('invalid-response')
      return completed(reply, text.join(''))
    }
    const batch = validateToolBatch(calls), results = await runner.tools(batch)
    intent = { input: batch.map((call, index) => ({ type: 'function_result', call_id: call.id, name: call.name,
      result: [{ type: 'text', text: toolResult(results[index]!) }] })) }
  }
}

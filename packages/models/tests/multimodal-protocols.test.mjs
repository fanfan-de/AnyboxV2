import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createResponsesProtocol, createAnthropicMessagesProtocol, createGeminiInteractionsProtocol, nativeImageResourceUri } from '../dist/index.js'
import { declared, jsonResponse, nativeSession, sse, responseReply, responseText } from './native-protocol-helpers.mjs'
import { deferred, fixture, tick } from './helpers.mjs'

const text = value => ({ type: 'text', text: value })
const declaration = { ...declared, imageInput: { support: 'supported' } }
const bytes = Uint8Array.from([137, 80, 78, 71, 1, 2, 3])
const ref = { id: 'image:one', byteLength: bytes.length, mimeType: 'image/png', sha256: createHash('sha256').update(bytes).digest('hex') }
const reader = (value = bytes) => ({ read() { return { result: Promise.resolve(value), done: Promise.resolve(), cancel() {} } } })
const cases = [
  { id: 'responses', create: createResponsesProtocol, field: 'input',
    image: uri => ({ type: 'input_image', image_url: uri }), text: value => ({ type: 'input_text', text: value }),
    user: content => ({ role: 'user', content }), tool: { input: [{ type: 'function_call_output', call_id: 'call', output: 'result' }] },
    reply: () => responseReply([responseText('answer')]), events: reply => [{ type: 'response.completed', response: reply }],
    wire: (mimeType, data) => ({ type: 'input_image', image_url: `data:${mimeType};base64,${data}` }),
    invalid: image => [{ input: [{ role: 'system', content: [image] }] }, { input: [{ role: 'developer', content: [image] }] }, { input: [{ type: 'function_call_output', call_id: 'call', output: [image] }] }],
  },
  { id: 'anthropic-messages', create: createAnthropicMessagesProtocol, field: 'messages', text,
    image: uri => ({ type: 'image', source: { type: 'url', url: uri } }), user: content => ({ role: 'user', content }),
    tool: { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'result' }] }] },
    reply: () => ({ type: 'message', role: 'assistant', content: [text('answer')], stop_reason: 'end_turn' }),
    events: reply => [{ type: 'message_start', message: { ...reply, content: [], stop_reason: null } },
      { type: 'content_block_start', index: 0, content_block: reply.content[0] }, { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }],
    wire: (mimeType, data) => ({ type: 'image', source: { type: 'base64', media_type: mimeType, data } }),
    invalid: image => [{ messages: [], system: [image] }, { messages: [{ role: 'assistant', content: [image] }] }, { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: [image] }] }] }],
  },
  { id: 'gemini-interactions', create: createGeminiInteractionsProtocol, field: 'input', text,
    image: uri => ({ type: 'image', uri }), user: content => ({ type: 'user_input', content }),
    tool: { input: [{ type: 'function_result', call_id: 'call', name: 'lookup', result: [text('result')] }] },
    reply: () => ({ id: 'interaction', status: 'completed', steps: [{ type: 'model_output', content: [text('answer')] }] }),
    events: reply => [{ event_type: 'interaction.completed', interaction: reply }],
    wire: (mimeType, data) => ({ type: 'image', mime_type: mimeType, data }),
    invalid: image => [{ input: [], system_instruction: [image] }, { input: [{ type: 'model_output', content: [image] }] }, { input: [{ type: 'function_result', call_id: 'call', name: 'lookup', result: [image] }] }],
  },
]

for (const c of cases) {
  const intent = content => ({ [c.field]: [c.user(content)] })
  const imageIntent = () => intent([c.image(nativeImageResourceUri(ref.id))])
  const protocol = fetch => c.create({ fetch: fetch ?? (async () => jsonResponse(c.reply())) })
  const add = f => f.add({ capabilityDeclarations: { ...declaration, streaming: { support: 'unsupported' } }, defaults: c.id === 'anthropic-messages' ? { maxOutputTokens: 4096 } : {} })

  for (const streaming of [false, true]) test(`${c.id}: image bytes/order survive JSON/SSE, continuation and restoration`, async () => {
    const sent = [], reads = [], refs = ['image/jpeg', 'image/png', 'image/webp'].map((mimeType, i) => ({ ...ref, id: `image:${i}`, mimeType }))
    const p = protocol(async (_url, init) => { sent.push(JSON.parse(init.body)); return streaming ? sse(c.events(c.reply())) : jsonResponse(c.reply()) })
    const resources = { read(resource) { reads.push(resource.id); return reader().read() } }
    const execution = nativeSession(p, { declaration, resources, streaming })
    const content = [c.text('Before'), ...refs.map(ref => c.image(nativeImageResourceUri(ref.id))), c.text('After')]
    const prepared = execution.prepareExchange(intent(content), { resourceRefs: refs })
    assert.deepEqual(prepared.record.resourceRefs, refs); assert.equal(prepared.record.recordFormatVersion, 2)
    assert.equal(reads.length, 0); assert.equal(sent.length, 0)
    await prepared.start().result
    await execution.prepareExchange(c.tool).start().result
    const wire = [c.text('Before'), ...refs.map(ref => c.wire(ref.mimeType, Buffer.from(bytes).toString('base64'))), c.text('After')]
    assert.deepEqual(sent[0][c.field][0].content, wire); assert.deepEqual(sent[1][c.field][0].content, wire)
    assert.doesNotMatch(JSON.stringify(sent), /urn:anybox:resource:/)
    const report = await execution.close()
    assert.doesNotMatch(JSON.stringify(report), /data:image|base64|private-native-test-key/)
    const restored = nativeSession(p, { declaration, resources, streaming, restore: { ...report.restoreState, records: report.records } })
    await restored.prepareExchange(imageIntent(), { resourceRefs: [ref] }).start().result
    assert.deepEqual(sent[2][c.field][0].content, wire)
    assert.deepEqual(sent[2][c.field].at(-1).content, [c.wire(ref.mimeType, Buffer.from(bytes).toString('base64'))])
    assert.deepEqual(reads, [...refs, ...refs, ...refs, ref].map(ref => ref.id))
    assert.equal((await restored.close()).records.length, 2)
  })

  test(`${c.id}: explicit capability, exact references and allowed image positions are required`, async () => {
    let requests = 0, reads = 0
    const p = protocol(async () => { requests++; return jsonResponse(c.reply()) })
    const resources = { read() { reads++; return reader().read() } }
    for (const support of ['unknown', 'unsupported']) {
      const e = nativeSession(p, { resources, declaration: { ...declaration, imageInput: { support } } })
      assert.throws(() => e.prepareExchange(imageIntent(), { resourceRefs: [ref] }), { code: 'capability-unsupported' }); await e.close()
    }
    const e = nativeSession(p, { declaration, resources })
    for (const metadata of [[], [ref, ref], [{ ...ref, mimeType: 'text/html' }], [ref, { ...ref, id: 'extra' }]])
      assert.throws(() => e.prepareExchange(imageIntent(), { resourceRefs: metadata }))
    assert.throws(() => e.prepareExchange(intent([c.text('text')]), { resourceRefs: [ref] }))
    for (const uri of ['https://private.invalid/image', 'data:image/png;base64,AA==', 'file-123', 'urn:anybox:resource:%ZZ'])
      assert.throws(() => e.prepareExchange(intent([c.image(uri)]), { resourceRefs: [ref] }))
    for (const input of c.invalid(c.image(nativeImageResourceUri(ref.id)))) assert.throws(() => e.prepareExchange(input, { resourceRefs: [ref] }))
    assert.throws(() => e.prepareExchange(intent([{ ...c.image(nativeImageResourceUri(ref.id)), detail: 'high' }]), { resourceRefs: [ref] }))
    assert.throws(() => e.prepareExchange(intent([c.wire(ref.mimeType, 'AA==')]), { resourceRefs: [ref] }))
    assert.equal(reads, 0); assert.equal(requests, 0)
    await e.prepareExchange(imageIntent(), { resourceRefs: [ref] }).start().result
    assert.throws(() => e.prepareExchange(imageIntent(), { resourceRefs: [{ ...ref, sha256: '0'.repeat(64) }] }))
    await e.close()
  })

  test(`${c.id}: old text strings/blocks/empty arrays restore unchanged and never resolve arbitrary strings`, async () => {
    const p = protocol(), e = nativeSession(p), uri = nativeImageResourceUri(ref.id)
    for (const content of ['old text', [], [c.text(uri)]]) await e.prepareExchange(intent(content)).start().result
    const report = await e.close()
    const legacy = { ...report.restoreState, recordFormatVersion: 1, records: report.records.map(({ resourceRefs, ...record }) => ({ ...record, recordFormatVersion: 1 })) }
    const copy = JSON.stringify(legacy), restored = nativeSession(p, { restore: legacy })
    await restored.prepareExchange(intent([c.text('next')])).start().result; await restored.close()
    assert.equal(JSON.stringify(legacy), copy)
  })

  for (const action of ['cancel', 'close', 'unregister']) test(`${c.id}: ${action} joins a resource reader after result before actual exit`, async () => {
    const entered = deferred(), result = deferred(), done = deferred(), cancelled = deferred(); let requests = 0
    const p = protocol(async () => { requests++; return jsonResponse(c.reply()) }), f = await fixture({ protocols: [p] })
    try {
      await add(f)
      const e = await f.open({ modelId: 'model', resources: { read() { entered.resolve(); return { result: result.promise, done: done.promise, cancel() { cancelled.resolve() } } } } })
      const op = e.prepareExchange(imageIntent(), { resourceRefs: [ref] }).start()
      await entered.promise; result.resolve(bytes); await tick(); assert.equal(requests, 0)
      let exited = false; void op.done.then(() => { exited = true })
      const closing = action === 'unregister' ? f.registrations[0].unregister() : action === 'close' ? e.close() : (op.cancel(), Promise.resolve())
      await cancelled.promise; await tick(); assert.equal(exited, false)
      done.resolve(); await assert.rejects(op.result, { code: 'cancelled' }); await op.done; await closing
      assert.equal((await e.close()).restoreState, undefined); assert.equal(requests, 0)
    } finally { done.resolve(); result.resolve(bytes); await f.root.fiber.dispose() }
  })

  test(`${c.id}: resource failures cannot send requests or create resumable state`, async () => {
    const faults = [
      [reader(bytes.slice(1)), 'invalid-resource'], [reader(new Uint8Array(bytes.length)), 'invalid-resource'],
      [{ read() { throw new Error('/private/image.png') } }, 'resource-unavailable'],
      [{ read() { return { result: new Promise(() => {}), done: Promise.reject(new Error('/private/cleanup')), cancel() {} } } }, 'cleanup-failure'],
    ]
    for (const [resources, code] of faults) {
      let requests = 0
      const e = nativeSession(protocol(async () => { requests++; return jsonResponse(c.reply()) }), { declaration, resources })
      const op = e.prepareExchange(imageIntent(), { resourceRefs: [ref] }).start()
      await assert.rejects(op.result, error => error.code === code && !String(error).includes('/private/'))
      if (code === 'cleanup-failure') await assert.rejects(op.done, { code }); else await op.done
      const report = await e.close(); assert.equal(report.restoreState, undefined); assert.equal(requests, 0)
      if (code === 'cleanup-failure') assert.equal(report.cleanup, 'failed')
    }
  })

  test(`${c.id}: repeated image occurrences count toward 32 MiB before any reads`, async () => {
    let reads = 0, requests = 0
    const e = nativeSession(protocol(async () => { requests++; return jsonResponse(c.reply()) }), { declaration, resources: { read() { reads++; return reader().read() } } })
    const op = e.prepareExchange(intent([c.image(nativeImageResourceUri(ref.id)), c.image(nativeImageResourceUri(ref.id))]),
      { resourceRefs: [{ ...ref, byteLength: 13 * 1024 * 1024 }] }).start()
    await assert.rejects(op.result, { code: 'request-too-large' }); await op.done; await e.close()
    assert.equal(reads, 0); assert.equal(requests, 0)
  })

  test(`${c.id}: v1 upgrades to mixed v2 history; malformed references and semantic changes reject`, async () => {
    const p = protocol(), f = await fixture({ protocols: [p] })
    try {
      await add(f)
      const first = await f.open({ modelId: 'model' }); await first.prepareExchange(intent([c.text('old')])).start().result
      const report = await first.close(), legacy = { ...report.restoreState, recordFormatVersion: 1,
        modelSnapshot: { ...report.restoreState.modelSnapshot, protocolVersion: '2.0.0', capabilities: { ...report.restoreState.modelSnapshot.capabilities, imageInput: false } },
        records: report.records.map(({ resourceRefs, ...record }) => ({ ...record, recordFormatVersion: 1 })) }
      const original = JSON.stringify(legacy)
      const next = await f.open({ modelId: 'model', resources: reader(), restore: legacy })
      await next.prepareExchange(imageIntent(), { resourceRefs: [ref] }).start().result
      const newer = await next.close(), chain = { ...newer.restoreState, records: [...legacy.records, ...newer.records] }
      const restored = await f.open({ modelId: 'model', resources: reader(), restore: chain })
      await restored.prepareExchange(intent([c.text('continue')])).start().result; await restored.close()
      assert.equal(JSON.stringify(legacy), original)
      for (const invalid of [
        { ...chain, records: chain.records.map(record => ({ ...record, recordFormatVersion: 1 })) },
        { ...chain, records: chain.records.map(record => record.kind === 'request' ? { ...record, resourceRefs: [] } : record) },
        ...[{ protocolVersion: '9.0.0' }, { historyScopeEpoch: 'other-account' }, { remoteModelId: 'other-model' }, { parameters: { ...chain.modelSnapshot.parameters, value: { temperature: 1 } } }].map(patch => ({ ...chain, modelSnapshot: { ...chain.modelSnapshot, ...patch } })),
      ]) await assert.rejects(f.open({ modelId: 'model', resources: reader(), restore: invalid }))
      // A v1 image must still fail the codec even when its matching resource metadata is removed.
      assert.throws(() => p.restore(newer.records.map(({ resourceRefs, ...record }) => ({ ...record, recordFormatVersion: 1 }))))
      const config = f.settings.configurations()[0]
      await f.settings.updateConfiguration(config.id, { capabilities: { ...config.capabilities, imageInput: { support: 'unsupported' } } }, config.revision)
      await assert.rejects(f.open({ modelId: 'model', resources: reader(), restore: chain }), { code: 'invalid-config' })
    } finally { await f.root.fiber.dispose() }
  })
  for (const failCleanup of [false, true]) test(`${c.id}: image transport terminal diagnostics survive ${failCleanup ? 'cleanup failure' : 'cancellation'}`, async () => {
    const entered = deferred(), release = deferred()
    const p = protocol(async () => sse(c.events(c.reply()), { close: false, cancel: async () => {
      entered.resolve(); await release.promise; if (failCleanup) throw new Error('private cleanup detail')
    } }))
    const e = nativeSession(p, { declaration, resources: reader(), streaming: true })
    const op = e.prepareExchange(imageIntent(), { resourceRefs: [ref] }).start()
    await entered.promise
    if (!failCleanup) op.cancel()
    let settled = false; void op.result.catch(() => { settled = true }); await tick(); assert.equal(settled, false)
    release.resolve()
    await assert.rejects(op.result, { code: failCleanup ? 'cleanup-failure' : 'cancelled' })
    if (failCleanup) await assert.rejects(op.done, { code: 'cleanup-failure' }); else await op.done
    const report = await e.close()
    assert.equal(report.restoreState, undefined)
    assert.equal(report.records.at(-1).kind, 'diagnostic')
    assert.match(JSON.stringify(report.records.at(-1).payload), /answer/)
    assert.doesNotMatch(JSON.stringify(report), /base64|data:image|private-native-test-key/)
  })

  test(`${c.id}: timeout waits for resource exit and never starts HTTP`, async () => {
    const result = deferred(), done = deferred(), cancelled = deferred(); let requests = 0
    const f = await fixture({ protocols: [protocol(async () => { requests++; return jsonResponse(c.reply()) })] })
    try {
      await f.add({ timeoutMs: 20, capabilityDeclarations: declaration, defaults: c.id === 'anthropic-messages' ? { maxOutputTokens: 4096 } : {} })
      const e = await f.open({ modelId: 'model', resources: { read() { return { result: result.promise, done: done.promise, cancel() { cancelled.resolve() } } } } })
      const op = e.prepareExchange(imageIntent(), { resourceRefs: [ref] }).start()
      await cancelled.promise
      let settled = false; void op.result.catch(() => { settled = true }); await tick(); assert.equal(settled, false)
      result.resolve(bytes); done.resolve(); await assert.rejects(op.result, { code: 'timeout' }); await op.done
      assert.equal((await e.close()).restoreState, undefined); assert.equal(requests, 0)
    } finally { result.resolve(bytes); done.resolve(); await f.root.fiber.dispose() }
  })

}

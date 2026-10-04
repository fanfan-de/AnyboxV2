import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createChatCompletionsProtocol, createResponsesProtocol, createAnthropicMessagesProtocol, createGeminiInteractionsProtocol, nativeImageResourceUri, parseNativeImageResourceUri } from '../dist/index.js'
import { capabilities, deferred, fixture, tick } from './helpers.mjs'
import { chatReply, chatChunk, declared, jsonResponse, nativeSession, sse } from './native-protocol-helpers.mjs'

const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
const ref = { id: 'image:one', sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength, mimeType: 'image/png' }
const declaration = { ...declared, imageInput: { support: 'supported' } }
const image = (id = ref.id) => ({ type: 'image_url', image_url: { url: nativeImageResourceUri(id) } })
const intent = () => ({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Before' }, image(), { type: 'text', text: 'After' }] }] })
const reader = (values = bytes) => ({ read() { return { result: Promise.resolve(values), done: Promise.resolve(), cancel() {} } } })
const dataUrl = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`

for (const disabledThinking of [false, true]) for (const streaming of [false, true]) test(`native image resources remain references across tool continuation and restore (Chat thinking ${disabledThinking ? 'disabled' : 'omitted'}, ${streaming ? 'SSE' : 'JSON'})`, async () => {
  const sent = [], reads = []
  const protocol = createChatCompletionsProtocol({ fetch: async (_url, init) => {
    sent.push(JSON.parse(init.body))
    return streaming ? sse([chatChunk({ role: 'assistant', content: 'answer' }, 'stop'), '[DONE]']) : jsonResponse(chatReply())
  } })
  const parameters = disabledThinking ? { max_tokens: 75, thinking: { type: 'disabled' } } : {}
  const resources = { read(resource) { reads.push(resource.id); return reader().read() } }
  const execution = nativeSession(protocol, { declaration, resources, streaming, parameters })
  const prepared = execution.prepareExchange(intent(), { resourceRefs: [ref] })
  assert.equal(sent.length, 0); assert.equal(reads.length, 0); assert.equal(prepared.record.recordFormatVersion, 2)
  assert.deepEqual(prepared.record.resourceRefs, [ref]); assert.deepEqual(prepared.record.payload, intent())
  await prepared.start().result
  await execution.prepareExchange({ messages: [{ role: 'tool', tool_call_id: 'call', content: 'result' }] }).start().result
  assert.equal(sent[1].messages[0].content[1].image_url.url, dataUrl)
  assert.deepEqual(sent[0].messages[0].content.map(block => block.text ?? 'image'), ['Before', 'image', 'After'])
  if (disabledThinking) assert.deepEqual(sent[0].thinking, { type: 'disabled' })
  const report = await execution.close()
  assert.equal(report.restoreState.recordFormatVersion, 2)
  assert.doesNotMatch(JSON.stringify(report), /data:image|base64|private-native-test-key/)
  const restored = nativeSession(protocol, { declaration, resources, streaming, parameters, restore: { ...report.restoreState, records: structuredClone(report.records) } })
  await restored.prepareExchange({ messages: [{ role: 'user', content: 'Next' }] }).start().result
  assert.equal(sent[2].messages[0].content[1].image_url.url, dataUrl)
  assert.equal((await restored.close()).records.length, 2); assert.deepEqual(reads, [ref.id, ref.id, ref.id])
})

test('image admission rejects missing, extra and conflicting resource metadata without reading or fetching', async () => {
  let reads = 0, requests = 0
  const protocol = createChatCompletionsProtocol({ fetch: async () => { requests++; return jsonResponse(chatReply()) } })
  const execution = nativeSession(protocol, { declaration, resources: { read() { reads++; return reader().read() } } })
  assert.throws(() => execution.prepareExchange(intent()), { code: 'invalid-config' })
  assert.throws(() => execution.prepareExchange({ messages: [{ role: 'user', content: 'text' }] }, { resourceRefs: [ref] }), { code: 'invalid-config' })
  assert.throws(() => execution.prepareExchange(intent(), { resourceRefs: [ref, ref] }), { code: 'invalid-config' })
  assert.throws(() => execution.prepareExchange(intent(), { resourceRefs: [{ ...ref, mimeType: 'text/html' }] }), { code: 'invalid-config' })
  assert.equal(reads, 0); assert.equal(requests, 0)
  await execution.prepareExchange(intent(), { resourceRefs: [ref] }).start().result
  assert.throws(() => execution.prepareExchange(intent(), { resourceRefs: [{ ...ref, sha256: '0'.repeat(64) }] }), { code: 'invalid-config' })
  await execution.close()
  const unavailable = nativeSession(protocol, { declaration })
  assert.throws(() => unavailable.prepareExchange(intent(), { resourceRefs: [ref] }), { code: 'resource-unavailable' }); await unavailable.close()
})

test('image capability requires explicit model support', async () => {
  const protocol = createChatCompletionsProtocol()
  for (const support of ['unsupported', 'unknown']) {
    const execution = nativeSession(protocol, { declaration: { ...declaration, imageInput: { support } }, resources: reader() })
    assert.throws(() => execution.prepareExchange(intent(), { resourceRefs: [ref] }), { code: 'capability-unsupported' }); await execution.close()
  }
  for (const create of [createResponsesProtocol, createAnthropicMessagesProtocol, createGeminiInteractionsProtocol]) assert.equal(create().effectiveCapabilities(declaration, {}).imageInput, true)
  const f = await fixture({ protocols: [protocol] })
  try {
    await f.add({ key: 'private-key' }); const reads = f.vault.reads.length
    await assert.rejects(f.open({ modelId: 'model', requirements: { imageInput: true } }), { code: 'capability-unsupported' })
    assert.equal(f.vault.reads.length, reads)
  } finally { await f.root.fiber.dispose() }
})

test('each execution captures its own resource reader before later caller mutation', async () => {
  const reads = [], protocol = createChatCompletionsProtocol({ fetch: async () => jsonResponse(chatReply()) })
  const firstReader = { read() { reads.push('first'); return reader().read() } }
  const first = nativeSession(protocol, { declaration, resources: firstReader })
  const second = nativeSession(protocol, { declaration, resources: { read() { reads.push('second'); return reader().read() } } })
  firstReader.read = () => { throw new Error('replacement must not affect admitted execution') }
  await first.prepareExchange(intent(), { resourceRefs: [ref] }).start().result; await first.close()
  await second.prepareExchange(intent(), { resourceRefs: [ref] }).start().result; await second.close()
  assert.deepEqual(reads, ['first', 'second'])
})

test('image content rejects external URLs, inline data, detail fields and images in system/tool roles', async () => {
  const execution = nativeSession(createChatCompletionsProtocol(), { declaration, resources: reader() })
  for (const content of [
    [{ type: 'image_url', image_url: { url: 'https://private.invalid/picture' } }],
    [{ type: 'image_url', image_url: { url: dataUrl } }],
    [{ type: 'image_url', image_url: { url: nativeImageResourceUri(ref.id), detail: 'high' } }],
    [{ type: 'input_audio', input_audio: {} }],
  ]) assert.throws(() => execution.prepareExchange({ messages: [{ role: 'user', content }] }, { resourceRefs: [ref] }))
  for (const role of ['system', 'developer', 'tool']) assert.throws(() => execution.prepareExchange({ messages: [{ role, content: [image()] }] }, { resourceRefs: [ref] }))
  assert.equal(parseNativeImageResourceUri(nativeImageResourceUri(ref.id)), ref.id)
  assert.equal(parseNativeImageResourceUri('urn:anybox:resource:%ZZ'), undefined)
  await execution.close()
})

test('resource read result never starts transport until read done and cancellation joins actual exit', async () => {
  const entered = deferred(), result = deferred(), done = deferred(), cancelled = deferred(); let requests = 0
  const protocol = createChatCompletionsProtocol({ fetch: async () => { requests++; return jsonResponse(chatReply()) } })
  const execution = nativeSession(protocol, { declaration, resources: { read(_ref, { signal }) {
    signal.addEventListener('abort', () => cancelled.resolve(), { once: true }); entered.resolve()
    return { result: result.promise, done: done.promise, cancel() { cancelled.resolve() } }
  } } })
  const operation = execution.prepareExchange(intent(), { resourceRefs: [ref] }).start()
  await entered.promise; result.resolve(bytes); await tick(); assert.equal(requests, 0)
  let exited = false; void operation.done.then(() => { exited = true })
  operation.cancel(); await cancelled.promise; const closing = execution.close(); await tick(); assert.equal(exited, false)
  done.resolve(); await assert.rejects(operation.result, { code: 'cancelled' }); await operation.done
  assert.equal((await closing).restoreState, undefined); assert.equal(requests, 0)
})

test('resource cleanup failure terminates a broken result and fails execution cleanup', async () => {
  let requests = 0
  const protocol = createChatCompletionsProtocol({ fetch: async () => { requests++; return jsonResponse(chatReply()) } })
  const execution = nativeSession(protocol, { declaration, resources: { read() { return { result: new Promise(() => {}), done: Promise.reject(new Error('private-path')), cancel() {} } } } })
  const operation = execution.prepareExchange(intent(), { resourceRefs: [ref] }).start()
  await assert.rejects(operation.result, { code: 'cleanup-failure' }); await assert.rejects(operation.done, { code: 'cleanup-failure' })
  assert.equal((await execution.close()).cleanup, 'failed'); assert.equal(requests, 0)
})

test('protocol unregister revokes resources and waits for a reader that has not actually exited', async () => {
  const entered = deferred(), cancelled = deferred(), result = deferred(), done = deferred(); let requests = 0
  const protocol = createChatCompletionsProtocol({ fetch: async () => { requests++; return jsonResponse(chatReply()) } })
  const f = await fixture({ protocols: [protocol] })
  try {
    await f.add({ capabilityDeclarations: capabilities({ imageInput: { support: 'supported' }, streaming: { support: 'unsupported' } }) })
    const execution = await f.open({ modelId: 'model', resources: { read() { entered.resolve(); return { result: result.promise, done: done.promise, cancel() { cancelled.resolve() } } } } })
    const operation = execution.prepareExchange(intent(), { resourceRefs: [ref] }).start(); await entered.promise
    let closed = false; const unregister = f.registrations[0].unregister().then(() => { closed = true })
    await cancelled.promise; result.resolve(bytes); await tick(); assert.equal(closed, false); assert.equal(requests, 0)
    done.resolve(); await assert.rejects(operation.result, { code: 'cancelled' }); await operation.done; await unregister
    assert.equal(closed, true); assert.equal(requests, 0)
    assert.throws(() => f.open({ modelId: 'model', resources: reader() }), { code: 'protocol-unavailable' })
  } finally { done.resolve(); result.resolve(bytes); await f.root.fiber.dispose() }
})

test('missing/corrupt resources fail before transport with fixed errors', async () => {
  for (const [resources, code] of [[reader(new Uint8Array([1])), 'invalid-resource'], [reader(new Uint8Array(bytes.byteLength)), 'invalid-resource'],
    [{ read() { throw new Error('/private/user/image.png') } }, 'resource-unavailable']]) {
    let requests = 0
    const execution = nativeSession(createChatCompletionsProtocol({ fetch: async () => { requests++; return jsonResponse(chatReply()) } }), { declaration, resources })
    const operation = execution.prepareExchange(intent(), { resourceRefs: [ref] }).start()
    await assert.rejects(operation.result, error => error.code === code && !String(error).includes('/private/')); await operation.done
    assert.equal((await execution.close()).restoreState, undefined); assert.equal(requests, 0)
  }
})

test('32 MiB wire limit counts base64 expansion and rejects before reading resources or fetching', async () => {
  let reads = 0, requests = 0
  const execution = nativeSession(createChatCompletionsProtocol({ fetch: async () => { requests++; return jsonResponse(chatReply()) } }), { declaration,
    resources: { read() { reads++; return reader().read() } } })
  const oversized = { ...ref, byteLength: 25 * 1024 * 1024 }
  const operation = execution.prepareExchange(intent(), { resourceRefs: [oversized] }).start()
  await assert.rejects(operation.result, { code: 'request-too-large' }); await operation.done
  assert.equal(reads, 0); assert.equal(requests, 0); await execution.close()
})

test('v1 text restores additively into v2 images while downgrade and unrelated changes remain incompatible', async () => {
  const sent = [], protocol = createChatCompletionsProtocol({ fetch: async (_url, init) => { sent.push(JSON.parse(init.body)); return jsonResponse(chatReply()) } })
  const f = await fixture({ protocols: [protocol] })
  try {
    await f.add({ capabilityDeclarations: capabilities({ imageInput: { support: 'supported' }, streaming: { support: 'unsupported' } }) })
    const first = await f.open({ modelId: 'model' }); await first.prepareExchange({ messages: [{ role: 'user', content: 'Old text' }] }).start().result
    const report = await first.close()
    const legacy = { ...report.restoreState, recordFormatVersion: 1, modelSnapshot: { ...report.restoreState.modelSnapshot, protocolVersion: '2.0.0', capabilities: { ...report.restoreState.modelSnapshot.capabilities, imageInput: false } },
      records: report.records.map(({ resourceRefs: _refs, ...record }) => ({ ...record, recordFormatVersion: 1 })) }
    const original = JSON.stringify(legacy)
    const upgraded = await f.open({ modelId: 'model', restore: legacy, resources: reader(), requirements: { imageInput: true } })
    await upgraded.prepareExchange(intent(), { resourceRefs: [ref] }).start().result
    const next = await upgraded.close(); assert.equal(next.records[0].recordFormatVersion, 2); assert.equal(JSON.stringify(legacy), original)
    const chain = { ...next.restoreState, records: [...legacy.records, ...next.records] }
    const restored = await f.open({ modelId: 'model', restore: chain, resources: reader() }); await restored.prepareExchange({ messages: [{ role: 'user', content: 'Again' }] }).start().result; await restored.close()
    assert.equal(sent.at(-1).messages[2].content[1].image_url.url, dataUrl)
    for (const invalid of [
      { ...chain, recordFormatVersion: 3 },
      { ...chain, records: chain.records.map(record => record.kind === 'request' && record.resourceRefs?.length ? { ...record, resourceRefs: [] } : record) },
      { ...chain, records: chain.records.map(record => ({ ...record, recordFormatVersion: 1 })) },
      { ...chain, modelSnapshot: { ...chain.modelSnapshot, capabilities: { ...chain.modelSnapshot.capabilities, imageInput: false } } },
    ]) await assert.rejects(f.open({ modelId: 'model', restore: invalid, resources: reader() }))
    for (const changes of [{ protocolVersion: '9.0.0' }, { historyScopeEpoch: 'different-account' }, { parameters: { ...legacy.modelSnapshot.parameters, value: { temperature: 1 } } },
      { capabilities: { ...legacy.modelSnapshot.capabilities, tools: false } }]) await assert.rejects(f.open({ modelId: 'model', restore: { ...legacy, modelSnapshot: { ...legacy.modelSnapshot, ...changes } }, resources: reader() }), { code: 'invalid-config' })
    const current = f.settings.configurations()[0]
    await f.settings.updateConfiguration(current.id, { capabilities: { ...current.capabilities, imageInput: { support: 'unsupported' } } }, current.revision)
    await assert.rejects(f.open({ modelId: 'model', restore: chain, resources: reader() }), { code: 'invalid-config' })
  } finally { await f.root.fiber.dispose() }
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { createChatCompletionsProtocol, nativeImageResourceUri } from '../dist/index.js'
import { capabilities, fixture } from './helpers.mjs'
import { chatReply } from './native-protocol-helpers.mjs'

const intent = content => ({ messages: [{ role: 'user', content }] })

async function nativeFixture(t) {
  const requests = [], restores = []
  let fail = false
  const chat = createChatCompletionsProtocol({ async fetch(_url, init) {
    requests.push({ body: JSON.parse(init.body), authorization: new Headers(init.headers).get('Authorization') })
    if (fail) return new Response(null, { status: 500 })
    return Response.json(chatReply())
  } })
  const protocol = { ...chat, restore(records, prefix) { restores.push(records.length); return chat.restore(records, prefix) }, release() {} }
  const f = await fixture({ protocols: [protocol] })
  t.after(() => f.close())
  const { model, provider } = await f.add({ key: 'first-test-key', capabilityDeclarations: capabilities({
    streaming: { support: 'unsupported' }, imageInput: { support: 'supported' },
  }) })
  const open = options => f.open({ modelId: model.runtimeModelId, ...options })
  return { ...f, open, protocol, provider, restores, requests, failRequests: () => { fail = true } }
}

test('warm native continuation skips restore and produces the same request as cold replay', async t => {
  const f = await nativeFixture(t)
  const first = await f.open({ captureContinuation: true })
  const received = await first.prepareExchange(intent('before')).start().result
  const report = await first.close()
  assert.ok(report.continuation)
  assert.deepEqual(Object.keys(report.continuation), ['resourceRefs'])
  assert.ok(Object.isFrozen(report.continuation))
  assert.ok(Object.isFrozen(report.continuation.resourceRefs))
  assert.deepEqual(f.restores, [0])

  await assert.rejects(f.open({ continuation: structuredClone(report.continuation) }), { code: 'invalid-config' })
  await assert.rejects(f.open({ continuation: report.continuation, restore: { ...report.restoreState, records: report.records } }), { code: 'invalid-config' })
  assert.equal(f.vault.reads.length, 1)

  const warm = await f.open({ continuation: report.continuation })
  assert.deepEqual(f.restores, [0])
  const next = warm.prepareExchange(intent('after'))
  assert.equal(next.request.precedingRecordId, received.records.at(-1).id)
  await next.start().result
  const warmReport = await warm.close()
  assert.equal(warmReport.continuation, undefined)
  assert.equal(warmReport.records.length, 2)
  assert.deepEqual(warmReport.records[0].payload, intent('after'))
  assert.equal(f.vault.reads.length, 2)

  const cold = await f.open({ restore: { ...report.restoreState, records: report.records } })
  assert.deepEqual(f.restores, [0, 2])
  await cold.prepareExchange(intent('after')).start().result
  await cold.close()
  assert.deepEqual(f.requests[1], f.requests[2])
  assert.deepEqual(f.requests[1].body.messages, [...intent('before').messages, received.response.choices[0].message, ...intent('after').messages])
})

test('credential changes, generation replacement, aborted or failed closes do not revive native state', async t => {
  const f = await nativeFixture(t)
  const capture = async () => {
    const execution = await f.open({ captureContinuation: true })
    await execution.prepareExchange(intent('test')).start().result
    const report = await execution.close()
    assert.ok(report.continuation)
    return report.continuation
  }
  const beforeRotation = await capture()
  const provider = f.settings.configuredProviders().find(provider => provider.id === f.provider.id)
  await f.settings.setApiKey(provider.id, 'rotated-test-key', provider.revision)
  await assert.rejects(f.open({ continuation: beforeRotation }), { code: 'invalid-config' })
  assert.equal(f.vault.reads.length, 1)

  const beforeReplacement = await capture()
  assert.equal(f.requests.at(-1).authorization, 'Bearer rotated-test-key')
  await f.registrations[0].unregister()
  f.registry.register(f.protocol)
  await assert.rejects(f.open({ continuation: beforeReplacement }), { code: 'invalid-config' })
  assert.equal(f.vault.reads.length, 2)

  const controller = new AbortController()
  const aborted = await f.open({ captureContinuation: true, signal: controller.signal })
  await aborted.prepareExchange(intent('cancel after response')).start().result
  controller.abort()
  assert.equal((await aborted.close()).continuation, undefined)

  f.failRequests()
  const failed = await f.open({ captureContinuation: true })
  await assert.rejects(failed.prepareExchange(intent('provider error')).start().result, { code: 'provider-failure' })
  assert.equal((await failed.close()).continuation, undefined)
})

test('warm continuation carries image identities and uses the new execution resolver', async t => {
  const f = await nativeFixture(t)
  const bytes = Buffer.from('fixture bytes')
  const ref = { id: 'image-ref', sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, mimeType: 'image/png' }
  const reads = []
  const resolver = name => ({ read(resource) {
    reads.push(name)
    assert.deepEqual(resource, ref)
    return { result: Promise.resolve(bytes), done: Promise.resolve(), cancel() {} }
  } })
  const first = await f.open({ captureContinuation: true, resources: resolver('first') })
  const image = { type: 'image_url', image_url: { url: nativeImageResourceUri(ref.id) } }
  await first.prepareExchange(intent([{ type: 'text', text: 'image' }, image]), { resourceRefs: [ref] }).start().result
  const report = await first.close()
  assert.deepEqual(report.continuation.resourceRefs, [ref])
  assert.ok(Object.isFrozen(report.continuation.resourceRefs[0]))

  const warm = await f.open({ continuation: report.continuation, resources: resolver('warm') })
  await warm.prepareExchange(intent('continue')).start().result
  await warm.close()
  assert.deepEqual(reads, ['first', 'warm'])
  assert.deepEqual(f.requests[1].body.messages[0], f.requests[0].body.messages[0])
  assert.deepEqual(f.restores, [0])
})

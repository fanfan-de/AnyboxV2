import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, FiberState } from '@nya/core'
import { createResourceProbe, modelServiceKey, runServiceKey } from '../dist/resource-probe.js'

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  const done = deferred()
  const cancelled = deferred()
  const events = []
  const root = new Context()
  const provider = root.installComponent({
    name: 'controlled-model',
    apply(ctx) {
      ctx.effect(() => () => { events.push('provider-cleaned') }, 'model cleanup')
      ctx.provide(modelServiceKey, {
        call(prompt) {
          events.push(`called:${prompt}`)
          return {
            result: Promise.resolve('answer'),
            done: done.promise,
            cancel(reason) {
              events.push(`cancelled:${reason}`)
              cancelled.resolve()
            },
          }
        },
      })
    },
  })
  const owner = root.installComponent(createResourceProbe())
  return { root, provider, owner, done, cancelled, events }
}

test('removing a model provider waits for its consumer and the actual call cleanup', async () => {
  const { root, provider, owner, done, cancelled, events } = fixture()
  try {
    await provider
    await owner
    assert.equal(provider.state, FiberState.ACTIVE)
    assert.equal(owner.state, FiberState.ACTIVE)
    const runs = root.get(runServiceKey)
    const call = runs.start('hello')
    assert.equal(await call.result, 'answer')

    let finished = false
    const stopping = provider.dispose().then(() => { finished = true })
    await cancelled.promise
    assert.equal(finished, false)
    assert.equal(events.includes('provider-cleaned'), false)
    assert.throws(() => runs.start('late'), /closing/)

    done.resolve()
    await stopping
    assert.equal(finished, true)
    assert.equal(events.at(-1), 'provider-cleaned')
    assert.equal(root.get(runServiceKey), undefined)
  } finally {
    done.resolve()
    await root.fiber.dispose()
  }
})

test('disposing the owner closes admission and waits for its active call', async () => {
  const { root, provider, owner, done, cancelled, events } = fixture()
  try {
    await provider
    await owner
    const runs = root.get(runServiceKey)
    runs.start('hello')

    let finished = false
    const stopping = owner.dispose().then(() => { finished = true })
    await cancelled.promise
    assert.equal(finished, false)
    assert.throws(() => runs.start('late'), /closing/)

    done.resolve()
    await stopping
    assert.equal(root.get(runServiceKey), undefined)
    assert.equal(events.includes('provider-cleaned'), false)
  } finally {
    done.resolve()
    await root.fiber.dispose()
  }
})

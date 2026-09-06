import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fixture, waitFor } from './helpers.mjs'

function observer() {
  const reports = []
  const waiters = new Set()
  return {
    reports,
    onReport(report) {
      reports.push(report)
      for (const waiter of waiters) if (waiter.matches(report)) {
        waiters.delete(waiter)
        waiter.resolve(report)
      }
    },
    next(matches) {
      return new Promise(resolve => { waiters.add({ matches, resolve }) })
    },
  }
}

test('HMR watches shared code and JSON changes in the same application, retaining healthy code on errors', { timeout: 20_000 }, async t => {
  const f = await fixture(t)
  const dependency = join(f.directory, 'message.mjs')
  await writeFile(dependency, `export const prefix = 'code-one:'`)
  await writeFile(f.valuePath, `
    import { Context } from '@nya/core'
    import { prefix } from './message.mjs'
    export default (ctx, config) => {
      if (!(ctx.root instanceof Context)) throw new Error('duplicate Core')
      ctx.provide('testValue', { value: prefix + config.value })
    }
  `)
  const events = observer()
  const app = f.create({ development: { entries: [pathToFileURL(f.valuePath).href], onReport: events.onReport } })
  await waitFor(app.start(), t.signal)
  const context = app.context
  const firstConsumer = context.testConsumer
  const firstGeneration = events.reports.at(-1).generation
  assert.equal(context.testConsumer.value, 'code-one:one')

  const replaced = events.next(report => report.status === 'applied' && report.generation > firstGeneration)
  await writeFile(dependency, `export const prefix = 'code-two:'`)
  const replacement = await waitFor(replaced, t.signal)
  assert.equal(replacement.pid, process.pid)
  assert.strictEqual(app.context, context)
  assert.notStrictEqual(context.testConsumer, firstConsumer)
  assert.equal(context.testConsumer.value, 'code-two:one')

  const configured = events.next(report => report.configuration?.entries.some(entry => entry.config?.value === 'two'))
  f.config.entries[0].config.value = 'two'
  await f.writeConfig(f.config)
  await waitFor(configured, t.signal)
  assert.equal(context.testConsumer.value, 'code-two:two')

  const invalid = events.next(report => report.status === 'failed')
  await writeFile(dependency, `export const prefix = ;`)
  await waitFor(invalid, t.signal)
  assert.equal(context.testConsumer.value, 'code-two:two')
  const recovered = events.next(report => report.status === 'applied' && report.generation > replacement.generation)
  await writeFile(dependency, `export const prefix = 'code-three:'`)
  await waitFor(recovered, t.signal)
  assert.equal(context.testConsumer.value, 'code-three:two')
  const hmr = context.hmr
  await app.close()
  assert.throws(() => hmr.reload(), /inactive context/)
  assert.equal(context.fiber.inspect().children.length, 0)
})

test('development startup compiles a TypeScript component before Include loads it', { timeout: 20_000 }, async t => {
  const f = await fixture(t)
  const sourcePath = join(f.directory, 'value.ts')
  await writeFile(sourcePath, `
    import { Context, type Component } from '@nya/core'
    declare module '@nya/core' {
      interface Context { testValue: { readonly value: string } }
    }
    const component: Component.Object<{ value: string }> = {
      apply(ctx, config) {
        if (!(ctx.root instanceof Context)) throw new Error('duplicate Core')
        ctx.provide('testValue', { value: config.value })
      },
    }
    export default component
  `)
  f.config.entries[0].name = './value.ts'
  await f.writeConfig(f.config)
  const app = f.create({ development: { entries: [pathToFileURL(sourcePath).href], watch: false } })
  await waitFor(app.start(), t.signal)
  assert.equal(app.context.testConsumer.value, 'one')
  assert.equal(app.context.hmr.report().status, 'applied')
})

test('HMR requests host restart at its version limit without discarding the current runtime', { timeout: 10_000 }, async t => {
  const f = await fixture(t)
  const app = f.create({ development: { entries: [pathToFileURL(f.valuePath).href], watch: false, maxGenerations: 1 } })
  await app.start()
  await writeFile(f.valuePath, `export default ctx => { ctx.provide('testValue', { value: 'new' }) }`)
  const report = await app.context.hmr.reload()
  assert.equal(report.status, 'restart-required')
  assert.strictEqual(await waitFor(app.restartRequested, t.signal), report)
  assert.equal(app.context.testConsumer.value, 'one')
})

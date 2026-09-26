import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { projectServiceKey } from '../dist/project/component.js'
import { bashServiceKey, createBashComponent } from '../dist/tool/bash-component.js'

async function fixture(options = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-bash-')))
  const root = new Context()
  await root.installComponent({
    name: 'test-projects',
    apply(ctx) {
      ctx.provide(projectServiceKey, {
        async requireAvailable(id) {
          if (id !== 'project-1') throw new Error('unknown project')
          return { id, path: directory, name: 'test', available: true, createdAt: 'now' }
        },
      })
    },
  })
  await root.installComponent(createBashComponent(options))
  return {
    directory, root, bash: root.get(bashServiceKey),
    async close() {
      try { await root.fiber.dispose() }
      finally { rmSync(directory, { recursive: true, force: true }) }
    },
  }
}

async function untilFile(path) {
  for (let attempt = 0; attempt < 200 && !existsSync(path); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(existsSync(path), `command did not create ${path}`)
}

function deferred() {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}

test('Bash runs in the selected project with only the chosen host environment', async () => {
  const f = await fixture()
  const prior = process.env.ANYBOX_BASH_TEST_SECRET
  process.env.ANYBOX_BASH_TEST_SECRET = 'private-value'
  try {
    const call = f.bash.execute({
      projectId: 'project-1',
      command: 'printf "PWD=%s\\nHOME=%s\\nSECRET=%s\\n" "$PWD" "$HOME" "${ANYBOX_BASH_TEST_SECRET-unset}"',
    })
    const result = await call.result
    await call.done
    assert.equal(result.exitCode, 0)
    assert.equal(result.signal, null)
    assert.equal(result.stdout, `PWD=${f.directory}\nHOME=${process.env.HOME ?? ''}\nSECRET=unset\n`)
    assert.equal(result.stderr, '')
    assert.equal(result.truncated, false)
  } finally {
    if (prior === undefined) delete process.env.ANYBOX_BASH_TEST_SECRET
    else process.env.ANYBOX_BASH_TEST_SECRET = prior
    await f.close()
  }
})

test('Bash returns nonzero exit status and bounds combined output', async () => {
  const f = await fixture({ maxOutputBytes: 6 })
  try {
    const call = f.bash.execute({ projectId: 'project-1', command: "printf 'abcdef'; printf '1234' >&2; exit 7" })
    const result = await call.result
    await call.done
    assert.equal(result.exitCode, 7)
    assert.equal(result.signal, null)
    assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 6)
    assert.equal(result.truncated, true)
  } finally { await f.close() }
})

test('Bash rejects invalid commands before execution and unavailable projects with a fixed category', async () => {
  const f = await fixture()
  try {
    assert.throws(() => f.bash.execute({ projectId: 'project-1', command: '   ' }),
      error => error.category === 'invalid-request')
    assert.throws(() => f.bash.execute({ projectId: 'project-1', command: 'printf invalid\0command' }),
      error => error.category === 'invalid-request')
    const call = f.bash.execute({ projectId: 'missing', command: 'pwd' })
    await assert.rejects(call.result, error => error.category === 'unavailable' && !error.message.includes('missing'))
    await call.done
  } finally { await f.close() }
})

test('Bash timeout rejects result before the resistant process has exited', async () => {
  const f = await fixture({ timeoutMs: 300, terminationGraceMs: 250 })
  try {
    const call = f.bash.execute({
      projectId: 'project-1', command: "trap '' TERM; printf ready > started; while :; do sleep 1; done",
    })
    await untilFile(join(f.directory, 'started'))
    let exited = false
    void call.done.then(() => { exited = true })
    await assert.rejects(call.result, error => error.category === 'timeout')
    assert.equal(exited, false)
    await call.done
    assert.equal(exited, true)
  } finally { await f.close() }
})

test('explicit cancellation and component disposal wait for Bash to exit', async () => {
  const f = await fixture({ terminationGraceMs: 250 })
  try {
    const first = f.bash.execute({
      projectId: 'project-1', command: "trap '' TERM; printf ready > first-started; while :; do sleep 1; done",
    })
    await untilFile(join(f.directory, 'first-started'))
    first.cancel('user-requested')
    let firstExited = false
    void first.done.then(() => { firstExited = true })
    await assert.rejects(first.result, error => error.category === 'cancelled')
    assert.equal(firstExited, false)
    await first.done
    assert.equal(firstExited, true)

    const second = f.bash.execute({
      projectId: 'project-1', command: "trap '' TERM; printf ready > second-started; while :; do sleep 1; done",
    })
    await untilFile(join(f.directory, 'second-started'))
    const closing = f.close()
    let closed = false
    void closing.then(() => { closed = true })
    await assert.rejects(second.result, error => error.category === 'cancelled')
    assert.equal(closed, false)
    await closing
    assert.equal(closed, true)
  } finally { await f.close() }
})

test('disposal waits for an accepted project lookup and never spawns after cancellation', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anybox-bash-')))
  const root = new Context()
  const lookupStarted = deferred()
  const releaseLookup = deferred()
  try {
    await root.installComponent({
      name: 'delayed-projects',
      apply(ctx) {
        ctx.provide(projectServiceKey, {
          async requireAvailable(id) {
            lookupStarted.resolve()
            await releaseLookup.promise
            return { id, path: directory, name: 'test', available: true, createdAt: 'now' }
          },
        })
      },
    })
    await root.installComponent(createBashComponent())
    const bash = root.get(bashServiceKey)
    const call = bash.execute({ projectId: 'project-1', command: 'printf ran > should-not-exist' })
    await lookupStarted.promise
    const closing = root.fiber.dispose()
    let closed = false
    void closing.then(() => { closed = true })
    await assert.rejects(call.result, error => error.category === 'cancelled')
    assert.equal(closed, false)
    releaseLookup.resolve()
    await call.done
    await closing
    assert.equal(existsSync(join(directory, 'should-not-exist')), false)
  } finally {
    releaseLookup.resolve()
    await root.fiber.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

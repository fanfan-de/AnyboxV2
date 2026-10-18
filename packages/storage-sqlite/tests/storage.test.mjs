import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Context, FiberState } from '@nya/core'
import { createLocalSqliteComponent } from '../dist/sqlite.js'
import { localStorageServiceKey } from '../dist/port.js'

const v1 = { version: 1, up(tx) { tx.execute('CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL)') } }
const v2 = { version: 2, up(tx) { tx.execute('ALTER TABLE notes ADD COLUMN category TEXT') } }

async function open(file, migrations = [v1]) {
  const context = new Context()
  const fiber = context.installComponent(createLocalSqliteComponent(file))
  await fiber
  assert.equal(fiber.state, FiberState.ACTIVE)
  const store = context.get(localStorageServiceKey)
  await store.migrate('notes', migrations)
  return { context, store }
}

const domainVersion = (store, domain) => store.read(reader =>
  reader.get('SELECT version FROM schema_migrations WHERE domain = ?', [domain])?.version)

test('SQLite storage restores data and applies each new migration on reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-sqlite-'))
  const file = join(directory, 'data.sqlite')
  let first
  let second
  try {
    first = await open(file)
    await first.store.transaction(tx => {
      tx.execute('INSERT INTO notes (id, body) VALUES (?, ?)', ['1', 'hello'])
    })
    await first.context.fiber.dispose()

    second = await open(file, [v1, v2])
    const row = await second.store.read(reader =>
      reader.get('SELECT body, category FROM notes WHERE id = ?', ['1']))
    assert.deepEqual({ ...row }, { body: 'hello', category: null })
    assert.equal(await domainVersion(second.store, 'notes'), 2)
    assert.equal(existsSync(`${file}.lock`), false)
  } finally {
    await second?.context.fiber.dispose()
    await first?.context.fiber.dispose()
    assert.equal(existsSync(`${file}.lock`), false)
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a rejected transaction rolls back all writes and leaves the connection usable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-sqlite-'))
  const file = join(directory, 'data.sqlite')
  const { context, store } = await open(file)
  try {
    await assert.rejects(store.transaction(async tx => {
      tx.execute('INSERT INTO notes (id, body) VALUES (?, ?)', ['1', 'first'])
      await Promise.resolve()
      throw new Error('domain failure')
    }), /domain failure/)
    assert.equal(await store.read(reader => reader.get('SELECT id FROM notes WHERE id = ?', ['1'])), undefined)

    await assert.rejects(store.transaction(tx => {
      tx.execute('INSERT INTO notes (id, body) VALUES (?, ?)', ['2', 'second'])
      tx.execute('INSERT INTO notes (id, body) VALUES (?, ?)', ['2', 'duplicate'])
    }), error => error.code === 'operation-failed')
    assert.equal(await store.read(reader => reader.get('SELECT id FROM notes WHERE id = ?', ['2'])), undefined)
    const cancellation = new AbortController()
    await assert.rejects(store.transaction(async tx => {
      tx.execute('INSERT INTO notes (id, body) VALUES (?, ?)', ['4', 'cancelled'])
      cancellation.abort(new Error('cancelled'))
      await Promise.resolve()
    }, cancellation.signal), /cancelled/)
    assert.equal(await store.read(reader => reader.get('SELECT id FROM notes WHERE id = ?', ['4'])), undefined)
    await assert.rejects(store.read(reader => reader.get(
      "INSERT INTO notes (id, body) VALUES ('5', 'read must not write') RETURNING id")),
    error => error.code === 'operation-failed')
    assert.equal(await store.read(reader => reader.get('SELECT id FROM notes WHERE id = ?', ['5'])), undefined)
    await store.transaction(tx => tx.execute('INSERT INTO notes (id, body) VALUES (?, ?)', ['3', 'works']))
    assert.equal((await store.read(reader => reader.get('SELECT body FROM notes WHERE id = ?', ['3']))).body, 'works')
  } finally {
    await context.fiber.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('one transaction can commit or roll back changes across separately owned tables', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-sqlite-'))
  const file = join(directory, 'data.sqlite')
  const { context, store } = await open(file)
  await store.migrate('prompts', [{ version: 1, up(tx) { tx.execute('CREATE TABLE prompt_records (id TEXT PRIMARY KEY)') } }])
  await store.migrate('runs', [{ version: 1, up(tx) { tx.execute('CREATE TABLE run_records (id TEXT PRIMARY KEY)') } }])
  const savePrompt = (tx, id) => tx.execute('INSERT INTO prompt_records (id) VALUES (?)', [id])
  const saveRun = (tx, id) => tx.execute('INSERT INTO run_records (id) VALUES (?)', [id])
  try {
    await assert.rejects(store.transaction(tx => {
      savePrompt(tx, 'draft')
      saveRun(tx, 'run')
      throw new Error('reject both')
    }), /reject both/)
    assert.equal(await store.read(reader => reader.get('SELECT id FROM prompt_records')), undefined)
    assert.equal(await store.read(reader => reader.get('SELECT id FROM run_records')), undefined)
    await store.transaction(tx => { savePrompt(tx, 'draft'); saveRun(tx, 'run') })
    assert.equal((await store.read(reader => reader.get('SELECT id FROM prompt_records'))).id, 'draft')
    assert.equal((await store.read(reader => reader.get('SELECT id FROM run_records'))).id, 'run')
  } finally {
    await context.fiber.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a second provider for the same SQLite file fails with an occupied code', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-sqlite-'))
  const file = join(directory, 'data.sqlite')
  const first = await open(file)
  const second = new Context()
  try {
    const fiber = second.installComponent(createLocalSqliteComponent(file))
    await assert.rejects(async () => { await fiber }, error => error.code === 'occupied')
    assert.equal(fiber.state, FiberState.FAILED)
    assert.equal(await domainVersion(first.store, 'notes'), 1)
  } finally {
    await second.fiber.dispose()
    await first.context.fiber.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('separate service keys own separate databases and clean up independently on the same root', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-sqlite-'))
  const context = new Context()
  let release
  let closing
  try {
    const businessFiber = context.installComponent(createLocalSqliteComponent(join(directory, 'business.sqlite')))
    const registryFile = join(directory, 'registry.sqlite')
    const registryFiber = context.installComponent(createLocalSqliteComponent(registryFile, { serviceKey: 'host.package-storage' }))
    await Promise.all([businessFiber, registryFiber])
    const business = context.get(localStorageServiceKey)
    const registry = context.get('host.package-storage')
    assert.notEqual(business, registry)
    await Promise.all([business.migrate('notes', [v1]), registry.migrate('notes', [v1])])
    await business.transaction(tx => tx.execute('INSERT INTO notes (id, body) VALUES (?, ?)', ['1', 'business']))
    let entered
    const inside = new Promise(resolve => { entered = resolve })
    const gate = new Promise(resolve => { release = resolve })
    const accepted = registry.transaction(async tx => {
      tx.execute('INSERT INTO notes (id, body) VALUES (?, ?)', ['1', 'registry'])
      entered()
      await gate
    })
    await inside
    closing = registryFiber.dispose()
    let closed = false
    void closing.then(() => { closed = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(closed, false)
    await assert.rejects(registry.read(reader => reader.get('SELECT 1')), error => error.code === 'closed')
    assert.equal((await business.read(reader => reader.get('SELECT body FROM notes WHERE id = ?', ['1']))).body, 'business')
    assert.equal(context.get(localStorageServiceKey), business)
    release()
    await accepted
    await closing

    const replacement = context.installComponent(createLocalSqliteComponent(registryFile, { serviceKey: 'host.package-storage' }))
    await replacement
    const reopenedRegistry = context.get('host.package-storage')
    assert.notEqual(reopenedRegistry, registry)
    assert.equal((await reopenedRegistry.read(reader => reader.get('SELECT body FROM notes WHERE id = ?', ['1']))).body, 'registry')
    assert.equal(context.get(localStorageServiceKey), business)
  } finally {
    release?.()
    await closing
    await context.fiber.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('different service keys cannot bypass exclusive ownership of the same file on one root', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-sqlite-'))
  const file = join(directory, 'data.sqlite')
  const { context, store } = await open(file)
  try {
    const conflicting = context.installComponent(createLocalSqliteComponent(file, { serviceKey: 'host.package-storage' }))
    await assert.rejects(async () => { await conflicting }, error => error.code === 'occupied')
    assert.equal(conflicting.state, FiberState.FAILED)
    assert.equal(context.get('host.package-storage'), undefined)
    await store.transaction(tx => tx.execute('INSERT INTO notes (id, body) VALUES (?, ?)', ['1', 'owner retained']))
    assert.equal((await store.read(reader => reader.get('SELECT body FROM notes WHERE id = ?', ['1']))).body, 'owner retained')
    assert.equal(context.get(localStorageServiceKey), store)
  } finally {
    await context.fiber.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('invalid service keys are rejected by the factory before filesystem changes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-sqlite-'))
  const targetDirectory = join(directory, 'not-created')
  const file = join(targetDirectory, 'data.sqlite')
  try {
    for (const serviceKey of ['', '  ', 'host\0storage', null, 12]) {
      assert.throws(() => createLocalSqliteComponent(file, { serviceKey }), /service key/)
    }
    assert.equal(existsSync(targetDirectory), false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('close rejects new operations and waits for accepted work before releasing the file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-sqlite-'))
  const file = join(directory, 'data.sqlite')
  const first = await open(file)
  let release
  const gate = new Promise(resolve => { release = resolve })
  let entered
  const inside = new Promise(resolve => { entered = resolve })
  let closing
  try {
    const active = first.store.transaction(async tx => {
      tx.execute('INSERT INTO notes (id, body) VALUES (?, ?)', ['1', 'committed before close'])
      entered()
      await gate
    })
    await inside
    const queued = first.store.read(reader => reader.get('SELECT body FROM notes WHERE id = ?', ['1']))
    closing = first.context.fiber.dispose()
    let closed = false
    void closing.then(() => { closed = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(closed, false)
    await assert.rejects(first.store.read(reader => reader.get('SELECT 1')), error => error.code === 'closed')
    release()
    await active
    assert.equal((await queued).body, 'committed before close')
    await closing
    assert.equal(existsSync(`${file}.lock`), false)

    const reopened = await open(file)
    try {
      assert.equal((await reopened.store.read(reader => reader.get('SELECT body FROM notes WHERE id = ?', ['1']))).body,
        'committed before close')
    } finally { await reopened.context.fiber.dispose() }
  } finally {
    release()
    await closing
    await first.context.fiber.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a failed domain migration rolls back its schema and version and leaves storage usable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-sqlite-'))
  const file = join(directory, 'data.sqlite')
  const { context, store } = await open(file)
  try {
    await assert.rejects(store.migrate('notes', [v1, {
      version: 2,
      up(tx) { tx.execute('CREATE TABLE partial (id TEXT)'); throw new Error('migration stopped') },
    }]), error => error.code === 'migration-failed')
    assert.equal(await domainVersion(store, 'notes'), 1)
    assert.equal(await store.read(reader => reader.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'partial'")), undefined)
    await store.transaction(tx => tx.execute('INSERT INTO notes (id, body) VALUES (?, ?)', ['1', 'still usable']))
  } finally {
    await context.fiber.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('domains track versions independently and a newer domain schema is rejected', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-sqlite-'))
  const file = join(directory, 'data.sqlite')
  const first = await open(file, [v1, v2])
  try {
    await first.store.migrate('other', [{ version: 1, up(tx) { tx.execute('CREATE TABLE other (id TEXT)') } }])
    assert.equal(await domainVersion(first.store, 'notes'), 2)
    assert.equal(await domainVersion(first.store, 'other'), 1)
    await assert.rejects(first.store.migrate('notes', [v1]), error => error.code === 'schema-version')
    await assert.rejects(first.store.migrate('notes', [v2]), error => error.code === 'schema-version')
    await assert.rejects(first.store.migrate(' ', [v1]), /domain/)
  } finally {
    await first.context.fiber.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('an unrecognized database layout fails startup and releases ownership', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-sqlite-'))
  const file = join(directory, 'data.sqlite')
  const foreign = new DatabaseSync(file)
  foreign.exec('CREATE TABLE unknown (id TEXT); PRAGMA user_version = 2')
  foreign.close()
  const context = new Context()
  try {
    const fiber = context.installComponent(createLocalSqliteComponent(file))
    await assert.rejects(async () => { await fiber }, error => error.code === 'schema-version')
    assert.equal(fiber.state, FiberState.FAILED)
    assert.equal(existsSync(`${file}.lock`), false)
  } finally {
    await context.fiber.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

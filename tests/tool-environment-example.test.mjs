import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { createNotesEnvironment } from '../examples/tool-environments/notes/environment.mjs'
import { loadExampleNotes, runNotesDemo } from '../examples/tool-environments/notes/demo.mjs'

test('a standalone notes environment exposes real documents without depending on an Agent', async () => {
  const source = await readFile(new URL('../examples/tool-environments/notes/environment.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /(?:from|import\s*\()\s*['"][^'"]*(?:app-harness|models|host|distribution)/)
  const documents = await loadExampleNotes(), environment = createNotesEnvironment(documents)
  const scope = environment.openScope({ scopeId: 'independent-consumer', ownerEpoch: 1, signal: new AbortController().signal })
  const search = scope.execute({ operationId: 'search', toolId: 'notes.search', version: '1', arguments: { query: '发布检查' }, resuming: false })
  const result = await search.result; await search.done
  assert.deepEqual(result.result.notes, [{ id: 'release-checklist', title: 'Anybox 发布检查' }])
  const read = scope.execute({ operationId: 'read', toolId: 'notes.read', version: '1', arguments: { id: 'release-checklist' }, resuming: false })
  assert.equal((await read.result).result.content, documents[0].content); await read.done
  const close = scope.close(); await close.result; await close.done
  assert.throws(() => scope.execute({ operationId: 'late', toolId: 'notes.read', version: '1', arguments: { id: 'release-checklist' }, resuming: false }), error => error.category === 'cancelled')
})

test('notes capabilities are an immutable scope snapshot and do not pretend to recover unknown work', async () => {
  const documents = [{ id: 'one', title: 'Original', content: 'Original bytes' }]
  const environment = createNotesEnvironment(documents)
  documents[0].content = 'Changed outside environment'
  const controller = new AbortController(), scope = environment.openScope({ scopeId: 'read-only', ownerEpoch: 1, signal: controller.signal })
  const input = { operationId: 'read', toolId: 'notes.read', version: '1', arguments: { id: 'one' }, resuming: false }
  const call = scope.execute(input)
  assert.equal((await call.result).result.content, 'Original bytes'); await call.done
  assert.equal(environment.recovery, undefined)
  assert.throws(() => scope.execute({ ...input, resuming: true }), error => error.category === 'outcome-unknown')
  assert.throws(() => scope.execute({ ...input, arguments: { path: '/outside-the-environment' } }), /arguments/)
  controller.abort()
  assert.throws(() => scope.execute(input), error => error.category === 'cancelled')
  const close = scope.close(); await close.result; await close.done
})

test('inserting notes changes only assembly: an existing Agent gains search/read in a new Session', { timeout: 15000 }, async () => {
  const result = await runNotesDemo()
  assert.deepEqual(result.withoutEnvironment.declaredTools, [])
  assert.deepEqual(result.withoutEnvironment.calls, [])
  assert.deepEqual(result.newSession.declaredTools, ['notes_search', 'notes_read'])
  assert.deepEqual(result.newSession.calls, ['notes_search', 'notes_read'])
  assert.match(result.newSession.answer, /执行 `npm run check`/)
  assert.match(result.newSession.answer, /进程资源真正退出/)
  assert.deepEqual(result.existingSession.declaredTools, [])
  assert.deepEqual(result.existingSession.calls, [])
  assert.equal(result.computerOperations, 0)
})

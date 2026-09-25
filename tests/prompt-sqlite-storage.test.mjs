import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { createPromptComponent, promptServiceKey } from '../dist/prompt/component.js'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { localStorageServiceKey } from '../dist/storage/port.js'

test('removing Prompt waits for accepted writes before releasing its service', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'anybox-prompts-'))
  const root = new Context()
  let release
  const gate = new Promise(resolve => { release = resolve })
  let entered
  const inside = new Promise(resolve => { entered = resolve })
  let nextId = 0
  const inputs = { newId: () => `prompt-${++nextId}`, now: () => 'now' }
  const createPrompt = () => createPromptComponent(inputs)
  try {
    const databaseFiber = root.installComponent(createLocalSqliteComponent(join(directory, 'harness.sqlite')))
    const promptFiber = root.installComponent(createPrompt())
    await databaseFiber
    await promptFiber
    const database = root.get(localStorageServiceKey)
    const prompts = root.get(promptServiceKey)
    const input = {
      name: 'Saved', kind: 'context', role: 'user', content: 'Persist this.',
    }
    const blocker = database.transaction(async () => { entered(); await gate })
    await inside
    const writing = prompts.createPrompt('alice', input)
    let removed = false
    const removing = promptFiber.dispose().then(() => { removed = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(removed, false)
    await assert.rejects(prompts.createPrompt('alice', input), /closing/)
    release()
    const [, document] = await Promise.all([blocker, writing, removing])

    const replacement = root.installComponent(createPrompt())
    await replacement
    assert.deepEqual(root.get(promptServiceKey).getPrompt('alice', document.id), document)
  } finally {
    release?.()
    await root.fiber.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})

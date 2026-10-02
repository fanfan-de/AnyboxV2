import assert from 'node:assert/strict'
import { test } from 'node:test'
import { rememberPromptViewState, readPromptViewState } from '../dist/applications/harness/web/product-view-state.js'

const memory = () => { const values = new Map(); return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } }
test('Prompt view persistence keeps identifiers and scroll only, excluding form content and credentials', () => {
  const storage = memory(), key = JSON.stringify(['agent', 'host-a', 'prompts'])
  const expected = { documentId: 'doc', agentId: 'assistant', versionId: 'v2', scroll: 128 }
  rememberPromptViewState(storage, key, { ...expected, content: 'private draft', apiKey: 'secret', name: 'unsaved' })
  assert.deepEqual(readPromptViewState(storage, key), expected)
  assert.ok([...storage.values.values()].every(value => !value.includes('private draft') && !value.includes('secret') && !value.includes('unsaved')))
  assert.deepEqual(readPromptViewState(storage, JSON.stringify(['agent', 'host-b', 'prompts'])), { scroll: 0 })
})

test('malformed and unavailable browser storage cannot break module mounting', () => {
  const corrupt = { getItem: () => '{bad', setItem() {} }
  assert.deepEqual(readPromptViewState(corrupt, 'key'), { scroll: 0 })
  const blocked = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
  rememberPromptViewState(blocked, 'key', { scroll: 0 })
  assert.deepEqual(readPromptViewState(blocked, 'key'), { scroll: 0 })
})

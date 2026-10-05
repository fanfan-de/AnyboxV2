import assert from 'node:assert/strict'
import { test } from 'node:test'
import { listTools, createToolSelection, validateToolSelection, validateLibraryArguments, defaultToolIds, legacyToolSelection } from '../dist/applications/harness/core/tool/catalog.js'
import { bashToolDefinition } from '../dist/applications/harness/core/tool/bash-component.js'
import { applyPatchToolDefinition } from '../dist/applications/harness/core/tool/apply-patch-component.js'

test('the built-in catalog has distinct versioned source contracts and the recommended mixed subset', () => {
  const tools = listTools()
  assert.equal(tools.length, 22)
  assert.equal(new Set(tools.map(tool => tool.toolId)).size, 22)
  assert.equal(new Set(tools.map(tool => tool.definition.name)).size, 22)
  assert.equal(defaultToolIds.length, 10)
  assert.ok(defaultToolIds.includes('codex.view_image'))
  assert.ok(tools.every(tool => tool.source.harnessId && tool.source.referenceUrl && tool.scope && tool.adaptation))
  const chosen = createToolSelection(['deepseek-harness.edit', 'claude-code.Grep', 'anybox.bash'])
  assert.deepEqual(chosen.tools.map(tool => tool.definition.name), ['claude_code_Grep', 'deepseek_harness_edit', 'bash'])
  assert.ok(Object.isFrozen(chosen.tools[0].definition.parameters))
})

test('tool dependency validation does not silently alter the selected IDs', () => {
  assert.throws(() => createToolSelection(['codex.exec_command']), /dependency/)
  assert.throws(() => createToolSelection(['codex.write_stdin']), /dependency/)
  assert.deepEqual(createToolSelection(['codex.write_stdin', 'codex.exec_command']).tools.map(tool => tool.toolId), ['codex.exec_command', 'codex.write_stdin'])
  assert.deepEqual(createToolSelection([]).tools, [])
  assert.throws(() => createToolSelection(['unknown-tool']))
})

test('selection snapshots pin exact immutable definitions and keep existing contracts intact', () => {
  assert.deepEqual(legacyToolSelection.tools.map(tool => tool.definition), [bashToolDefinition, applyPatchToolDefinition])
  assert.deepEqual(validateToolSelection(structuredClone(createToolSelection())), createToolSelection())
  const changed = structuredClone(createToolSelection())
  changed.tools[0].definition.description = 'changed tool'
  assert.throws(() => validateToolSelection(changed))
  const version = structuredClone(createToolSelection())
  version.tools[0].version = '2.0.0'
  assert.throws(() => validateToolSelection(version))
  const missing = structuredClone(createToolSelection())
  missing.tools = missing.tools.filter(tool => tool.toolId !== 'codex.write_stdin')
  assert.throws(() => validateToolSelection(missing))
  assert.throws(() => validateToolSelection({ schemaVersion: 1, tools: [legacyToolSelection.tools[0], legacyToolSelection.tools[0]] }))
})

test('source schemas reject unsupported modes and retain their own argument shapes', () => {
  assert.deepEqual(validateLibraryArguments('codex_exec_command', { cmd: 'pwd', tty: false }), { cmd: 'pwd', tty: false })
  assert.throws(() => validateLibraryArguments('codex_exec_command', { cmd: 'pwd', tty: true }))
  assert.throws(() => validateLibraryArguments('claude_code_Bash', { command: 'pwd', run_in_background: true }))
  assert.throws(() => validateLibraryArguments('deepseek_harness_bash', { command: 'pwd' }))
  assert.deepEqual(validateLibraryArguments('deepseek_harness_bash', { description: 'Inspect directory', command: 'pwd', workdir: '/tmp' }), { description: 'Inspect directory', command: 'pwd', workdir: '/tmp' })
  assert.throws(() => validateLibraryArguments('claude_code_Read', { file_path: 'x.pdf', pages: '1' }))
  assert.throws(() => validateLibraryArguments('codex_write_stdin', { session_id: '1' }))
  assert.throws(() => validateLibraryArguments(null, {}))
  assert.throws(() => validateLibraryArguments('claude_code_Edit', { file_path: 'x', old_string: 'old', new_string: undefined }))
  assert.throws(() => validateLibraryArguments('claude_code_Edit', { file_path: 'x', old_string: '', new_string: 'new' }))
  assert.throws(() => validateLibraryArguments('deepseek_harness_grep', { pattern: 'x', include: '!*.ts' }))
  assert.throws(() => validateLibraryArguments('deepseek_harness_grep', { pattern: 'x', include: '*.ts,*.js' }))
})

test('plan and todo contracts reject multiple active entries and preserve source-specific fields', () => {
  const todo = { todos: [{ content: 'Read file', status: 'in_progress' }] }
  assert.deepEqual(validateLibraryArguments('deepseek_harness_todo_write', todo), todo)
  assert.throws(() => validateLibraryArguments('claude_code_TodoWrite', todo))
  assert.deepEqual(validateLibraryArguments('claude_code_TodoWrite', { todos: [{ ...todo.todos[0], activeForm: 'Reading file' }] }).todos[0].activeForm, 'Reading file')
  assert.throws(() => validateLibraryArguments('codex_update_plan', { plan: [{ step: 'A', status: 'in_progress' }, { step: 'B', status: 'in_progress' }] }))
})

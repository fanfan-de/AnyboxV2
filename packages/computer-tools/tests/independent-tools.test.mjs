import assert from 'node:assert/strict'
import { mkdtemp, realpath, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import { createBashComponent, bashServiceKey } from '../dist/bash-component.js'
import { createApplyPatchComponent } from '../dist/apply-patch-component.js'
import { createFileToolsComponent, fileToolsServiceKey } from '../dist/files-component.js'
import { createProcessToolsComponent, processToolsServiceKey } from '../dist/process-component.js'
import { adaptFileToolCall, adaptProcessToolCall } from '../dist/adapters.js'
import { toolImagesServiceKey } from '../dist/images.js'
import { computerToolContracts, validateComputerToolArguments } from '../dist/contracts/index.js'

test('source contracts remain usable without importing resource components', () => {
  assert.equal(computerToolContracts.filter(tool => tool.selectable).length, 19)
  assert.throws(() => validateComputerToolArguments('bash', { command: ' ' }))
  assert.deepEqual(adaptProcessToolCall('codex_exec_command', { cmd: 'echo hello', yield_time_ms: 0 }), {
    operation: 'execute', input: { command: 'echo hello', yieldTimeMs: 0 },
  })
})

test('independent Nya root runs file tools with an explicit workspace and narrow image port', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anybox-tools-independent-')))
  const root = new Context()
  try {
    await root.installComponent({ name: 'example-images', apply(ctx) {
      ctx.provide(toolImagesServiceKey, { importImage() { throw new Error('images unused') } })
    } })
    await root.installComponent(createApplyPatchComponent())
    await root.installComponent(createFileToolsComponent())
    const files = root.get(fileToolsServiceKey)
    const call = files.execute({ scopeId: 'caller-owned-scope', workspacePath: directory, imageInput: false,
      request: adaptFileToolCall('claude_code_Write', { file_path: 'hello.txt', content: 'independent tools\n' }) })
    assert.equal((await call.result).result.status, 'applied')
    await call.done
    assert.equal(await readFile(join(directory, 'hello.txt'), 'utf8'), 'independent tools\n')
    const read = files.execute({ scopeId: 'another-caller', workspacePath: directory, imageInput: false,
      request: adaptFileToolCall('deepseek_harness_read', { file_path: 'hello.txt' }) })
    assert.match((await read.result).result.text, /independent tools/)
    await read.done
    assert.throws(() => files.execute({ scopeId: 'caller', imageInput: false,
      request: adaptFileToolCall('deepseek_harness_read', { file_path: 'hello.txt' }) }))
  } finally { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('process scopes and foreground Bash need no Agent, Project or Session services', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'anybox-process-independent-')))
  const root = new Context()
  try {
    await root.installComponent(createBashComponent())
    await root.installComponent(createProcessToolsComponent())
    const bash = root.get(bashServiceKey).execute({ workspacePath: directory, command: 'printf independent' })
    assert.equal((await bash.result).stdout, 'independent')
    await bash.done
    const scope = root.get(processToolsServiceKey).openScope({ scopeId: 'arbitrary-owner', workspacePath: directory })
    const started = scope.execute({ command: 'printf ready; sleep 30', shell: 'bash', login: false, yieldTimeMs: 0 })
    assert.ok((await started.result).session_id)
    await started.done
    const close = scope.close()
    assert.equal((await close.result).cleanup, 'completed')
    await close.done
    assert.throws(() => scope.execute({ command: 'printf forbidden' }))
  } finally { await root.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
})

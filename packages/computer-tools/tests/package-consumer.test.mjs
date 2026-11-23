import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { stageProductionClosure } from '../../../scripts/application-artifacts.mjs'

const repository = fileURLToPath(new URL('../../..', import.meta.url))

test('packed Computer tools run in an isolated consumer without Harness, Models or host packages', { timeout: 60000 }, async t => {
  const consumer = await realpath(await mkdtemp(join(tmpdir(), 'anybox-independent-tools-')))
  t.after(() => rm(consumer, { recursive: true, force: true }))
  const closure = await stageProductionClosure(repository, consumer, ['@anybox/computer-tools'])
  const names = closure.packages.map(value => value.name)
  for (const forbidden of ['@anybox/app-harness', '@anybox/host', '@anybox/models', '@anybox/distribution']) assert.equal(names.includes(forbidden), false)
  assert.ok(names.includes('@anybox/tool-api')); assert.ok(names.includes('@nya/core'))
  const native = join(consumer, 'node_modules/@anybox/computer-tools/dist/platform/native')
  const metadata = JSON.parse(await readFile(join(native, 'process-host.json'), 'utf8'))
  assert.equal(metadata.platform, process.platform); assert.equal(metadata.arch, process.arch)
  const main = join(consumer, 'main.mjs')
  await writeFile(main, `
import assert from 'node:assert/strict'
import { Context } from '@nya/core'
import { createApplyPatchComponent } from '@anybox/computer-tools/apply-patch'
import { createFileToolsComponent } from '@anybox/computer-tools/files'
import { adaptFileToolCall } from '@anybox/computer-tools/adapters'
import { createComputerToolEnvironment } from '@anybox/computer-tools/environment'
import { spawnManagedProcess, processRuntimeAvailable } from '@anybox/computer-tools/platform/process-runtime'
const root = new Context()
const joinCall = async call => { try { return await call.result } finally { await call.done } }
try {
  await root.installComponent({ name: 'consumer-image-capability', apply(ctx) {
    ctx.provide('tools.images', { importImage() { throw new Error('unexpected image request') } })
  } })
  await root.installComponent(createApplyPatchComponent())
  await root.installComponent(createFileToolsComponent())
  const patched = await joinCall(root.get('tools.apply-patch').execute({ workspacePath: process.cwd(),
    patch: '*** Begin Patch\\n*** Add File: independent.txt\\n+Independent tools\\n*** End Patch' }))
  assert.equal(patched.status, 'applied')
  const request = { name: 'claude_code_Read', arguments: { file_path: 'independent.txt' } }
  const environment = createComputerToolEnvironment({
    async getAcceptedOperation(scopeId, operationId) {
      assert.equal(scopeId, 'consumer')
      return operationId === 'read' ? { request } : undefined
    },
    async openRunScope({ scopeId }) {
      return {
        execute(operationId) {
          assert.equal(operationId, 'read')
          return root.get('tools.files').execute({ scopeId, workspacePath: process.cwd(), imageInput: false,
            request: adaptFileToolCall(request.name, request.arguments) })
        },
        async cancel() {},
        close: () => ({ result: Promise.resolve({ processes: [] }), done: Promise.resolve(), cancel() {} }),
      }
    },
    async hasRunResources() { return false },
  })
  const descriptor = environment.tools.find(tool => tool.definition.name === request.name)
  assert.ok(descriptor)
  const scope = environment.openScope({ scopeId: 'consumer', ownerEpoch: 1, signal: new AbortController().signal })
  const call = { operationId: 'read', toolId: descriptor.toolId, version: descriptor.version, arguments: request.arguments, resuming: false }
  await assert.rejects(joinCall(scope.execute({ ...call, arguments: { file_path: 'other.txt' } })), { category: 'unavailable' })
  assert.equal(scope.hasResources(), false)
  const read = await joinCall(scope.execute(call))
  assert.match(read.result.text, /Independent tools/)
  await joinCall(scope.close())
  assert.equal(processRuntimeAvailable(), true)
  const child = spawnManagedProcess({ executable: process.execPath, args: ['-e', 'process.stdout.write("independent process")'],
    cwd: process.cwd(), env: process.env, stdin: 'ignore' })
  let output = ''
  child.stdout.on('data', bytes => { output += bytes.toString('utf8') }); child.stderr.resume()
  assert.equal((await child.exited).exitCode, 0); await child.done
  assert.equal(output, 'independent process')
  process.stdout.write('independent tools verified\\n')
} finally { await root.fiber.dispose() }
`)
  const { stdout } = await promisify(execFile)(process.execPath, [main], { cwd: consumer, windowsHide: true, timeout: 20000 })
  assert.equal(stdout, 'independent tools verified\n')
})

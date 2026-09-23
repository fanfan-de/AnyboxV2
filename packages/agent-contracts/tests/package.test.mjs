import assert from 'node:assert/strict'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { KernelFault } from '@anybox/agent-contracts/api'

test('standalone consumers need neither the kernel, Nya nor Node type declarations', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-contracts-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const destination = join(directory, 'node_modules/@anybox/agent-contracts')
  await cp(new URL('../dist/', import.meta.url), join(destination, 'dist'), { recursive: true })
  await cp(new URL('../package.json', import.meta.url), join(destination, 'package.json'))
  await cp(new URL('./consumer.ts', import.meta.url), join(directory, 'consumer.ts'))
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(join(directory, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, module: 'NodeNext', target: 'ES2022', lib: ['ES2022', 'DOM'], types: [] },
    files: ['consumer.ts'],
  }))
  execFileSync(process.execPath, [fileURLToPath(import.meta.resolve('typescript/bin/tsc')), '-p', directory])
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import * as data from '@anybox/agent-contracts'
    import { KernelFault } from '@anybox/agent-contracts/api'
    import * as spi from '@anybox/agent-contracts/spi'
    assert.deepEqual(Object.keys(data), [])
    assert.deepEqual(Object.keys(spi), [])
    assert.equal(new KernelFault({ code: 'CLOSED', message: 'closed' }).error.code, 'CLOSED')
  `], { cwd: directory })
})

test('public faults preserve cause and isolate error data', () => {
  const data = { code: 'MODEL_FAILED', message: 'failed', details: { attempt: { id: 'one' } } }
  const cause = new Error('private provider error')
  const error = new KernelFault(data, { cause })
  data.details.attempt.id = 'changed'
  assert.ok(error instanceof Error)
  assert.equal(error.name, 'KernelFault')
  assert.equal(error.message, 'failed')
  assert.equal(error.cause, cause)
  assert.equal(error.error.details.attempt.id, 'one')
})

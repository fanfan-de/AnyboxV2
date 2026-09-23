import assert from 'node:assert/strict'
import test from 'node:test'
import { KernelFault } from '@anybox/agent-contracts/api'
import { KernelFault as LegacyKernelFault, createRunCoordinator, createMemoryState, createMockModel } from '@anybox/agent-kernel'

test('legacy exports share the public fault constructor and kernel rejections', async t => {
  assert.strictEqual(LegacyKernelFault, KernelFault)
  assert.deepEqual(Object.keys(await import('@anybox/agent-kernel/contracts')), [])
  assert.deepEqual(Object.keys(await import('@anybox/agent-kernel/spi')), [])
  const state = createMemoryState()
  const model = createMockModel()
  const kernel = createRunCoordinator({ state: state.service, model: model.service })
  t.after(async () => {
    try { await kernel.close() }
    finally { await Promise.all([model.close(), state.close()]) }
  })
  await assert.rejects(kernel.service.sessions.create(), error => error instanceof KernelFault && error.error.code === 'NOT_READY')
})

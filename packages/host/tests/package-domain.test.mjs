import assert from 'node:assert/strict'
import { test } from 'node:test'
import { identity, identityKey, receipt, captureCommand, assertTransition } from '../dist/package-management/domain.js'

const sample = () => ({ appId: 'notes', version: '1.2.3', digest: 'a'.repeat(64), target: { os: 'darwin', arch: 'arm64' } })
test('package identity is exact and immutable while equivalent input ordering keeps the same key', () => {
  const input = sample(), value = identity(input), reordered = { target: { arch: 'arm64', os: 'darwin' }, digest: input.digest, version: input.version, appId: input.appId }
  assert.equal(identityKey(input), identityKey(reordered))
  input.target.arch = 'x64'; assert.equal(value.target.arch, 'arm64')
  assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value.target))
  for (const invalid of [{ ...sample(), appId: '../notes' }, { ...sample(), version: '^1' }, { ...sample(), digest: 'bad' }]) assert.throws(() => identity(invalid), { code: 'invalid-input' })
})
test('recovery receipts are copied, canonical and bounded JSON without executable accessors', () => {
  const input = { z: ['one'], a: { phase: 'prepared' } }, result = receipt(input)
  input.z.push('late'); assert.deepEqual(result.z, ['one'])
  assert.equal(JSON.stringify(result), JSON.stringify(receipt({ a: { phase: 'prepared' }, z: ['one'] })))
  assert.ok(Object.isFrozen(result.a)); assert.ok(Object.isFrozen(result.z))
  const cycle = {}; cycle.self = cycle
  for (const invalid of [cycle, { value: NaN }, { value: undefined }, { get run() { throw new Error('must not execute') } }, { large: 'x'.repeat(70_000) }]) assert.throws(() => receipt(invalid), { code: 'invalid-input' })
})
test('unknown or irreversible package effects require reconciliation rather than ordinary retry', () => {
  assertTransition('accepted', 'preparing'); assertTransition('preparing', 'prepared'); assertTransition('committing', 'recovery-required')
  for (const [from, to] of [['committing', 'cancelled'], ['completed', 'preparing'], ['recovery-required', 'preparing']]) assert.throws(() => assertTransition(from, to), { code: 'transition-invalid' })
})

test('command capture permits optional fields while rejecting accessors without executing them', () => {
  let called = false
  assert.throws(() => captureCommand({ nested: { get receipt() { called = true; return 'unexpected' } } }), { code: 'invalid-input' })
  assert.equal(called, false)
  const input = { identity: sample(), optional: undefined }, captured = captureCommand(input)
  input.identity.target.arch = 'x64'
  assert.equal(captured.identity.target.arch, 'arm64'); assert.equal(captured.optional, undefined)
})

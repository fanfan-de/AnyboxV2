import assert from 'node:assert/strict'
import test from 'node:test'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseApplicationTrustPolicy, readApplicationTrustPolicy, currentApplicationRuntimeProfile } from '../dist/package-management/policy.js'

const pem = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
const input = () => ({ schemaVersion: 1, publishers: [{ publisher: 'fixture', keyId: 'key-one', publicKey: pem, appIds: ['calculator'] }], applications: { calculator: { assetPrefixes: ['/legacy/calculator'], webLegacyRoutes: ['#/calculator/'] } } })

test('administrative policy is an immutable external publisher and alias snapshot', () => {
  const value = input(), result = parseApplicationTrustPolicy(value)
  value.publishers[0].appIds.push('untrusted'); value.applications.calculator.assetPrefixes[0] = '/'
  assert.deepEqual(result.trustedPublishers[0].appIds, ['calculator'])
  assert.deepEqual(result.trustedAliases.calculator.assetPrefixes, ['/legacy/calculator'])
  assert.deepEqual(result.trustedAliases.calculator.webLegacyRoutes, ['#/calculator/'])
  assert.throws(() => result.trustedPublishers.push({}), TypeError)
  assert.throws(() => result.trustedAliases.calculator.assetPrefixes.push('/'), TypeError)
  assert.equal(result.trustedPublishers[0].publicKey, pem)
  assert.deepEqual(parseApplicationTrustPolicy({ schemaVersion: 1, publishers: [] }), { trustedPublishers: [] })
})

test('policy rejects ambiguous, executable and unsupported key declarations', () => {
  for (const change of [
    value => { value.download = 'https://example.invalid/policy' },
    value => { value.publishers[0].privateKey = 'never accepted' },
    value => { value.publishers[0].appIds = ['../other'] },
    value => { value.publishers.push({ ...value.publishers[0] }) },
    value => { value.publishers[0].publicKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    value => { value.applications.calculator.factory = 'payload/install.js' },
  ]) { const value = input(); change(value); assert.throws(() => parseApplicationTrustPolicy(value)) }
})

test('bounded policy file parsing rejects duplicate keys and cancellation closes the read', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-policy-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'policy.json')
  await writeFile(path, JSON.stringify(input()))
  assert.equal((await readApplicationTrustPolicy(path)).trustedPublishers.length, 1)
  await writeFile(path, '{"schemaVersion":1,"schemaVersion":1,"publishers":[]}')
  await assert.rejects(readApplicationTrustPolicy(path))
  await writeFile(path, ' '.repeat(1024 * 1024 + 1))
  await assert.rejects(readApplicationTrustPolicy(path))
  const controller = new AbortController(); controller.abort(new Error('cancelled before read'))
  await assert.rejects(readApplicationTrustPolicy(path, controller.signal), /cancelled before read/)
  const profile = currentApplicationRuntimeProfile()
  assert.equal(profile.node, process.versions.node); assert.equal(profile.platform, process.platform)
})

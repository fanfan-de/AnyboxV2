/** Disposable test manager: its only resource is a preparation work anchor. */
import { verifyApplicationArchive } from '../../dist/package-management/archive.js'
import { prepareApplicationArchive } from '../../dist/package-management/preparation.js'
import { acquirePackageUsageLock } from '../../dist/package-management/usage-locks.js'

const input = await new Promise(resolve => process.once('message', resolve))
let held
try {
  const runtime = { profile: 'anybox-node-runtime-1', sharedRuntime: 'nya-runtime-1', node: process.versions.node }
  const archive = verifyApplicationArchive(Buffer.from(input.archive, 'base64'), {
    target: { os: process.platform, arch: process.arch }, applicationApiVersion: '0.1.0', runtimeProfiles: { client: runtime },
    trustedPublishers: [{ publisher: 'lifetime-fixture', keyId: 'lifetime-key', publicKey: input.publicKey, appIds: ['lifetime-fixture'] }],
  })
  held = acquirePackageUsageLock(input.lifetime.directory, { usageId: input.lifetime.usageId, secret: input.lifetime.secret })
  process.send({ type: 'manager-locked', pid: process.pid })
  const result = await prepareApplicationArchive(archive, { lifetime: input.lifetime, timeoutMs: 120_000 })
  process.send({ type: 'prepared', status: result.roles.client.status })
} catch (error) {
  process.send?.({ type: 'failed', code: error?.code ?? 'unknown' })
} finally {
  await held?.release()
  if (process.connected) process.disconnect()
}

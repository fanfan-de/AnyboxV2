import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectComputerEnvironments } from '../packages/app-harness/dist/core/computer/environments.js'
import { createComputerToolManifest } from '../packages/app-harness/dist/core/computer/tool-support.js'

test('environment views preserve attachment identities and lifecycle states without exposing credential or grant records', () => {
  const attachment = (attachmentId, state = 'approved') => ({ attachmentId, unitKind: 'computer', origin: 'remote', state,
    unitId: 'worker-' + attachmentId, capabilities: { platform: 'linux', architecture: 'arm64', privateExtension: 'hidden' },
    requestedScope: { kind: 'computer', projects: ['/secret/project'], tools: 'all' }, credential: 'issued' })
  const views = projectComputerEnvironments([
    attachment('remote-one'), { ...attachment('local:models'), unitKind: 'models', origin: 'local' },
    { ...attachment('local:computer'), origin: 'local' }, attachment('remote-two'), attachment('pending', 'pending'), attachment('revoked', 'revoked'),
  ], { platform: 'darwin', architecture: 'x64' }, new Map([['remote-one', true], ['revoked', true]]))
  assert.equal(views.defaultEnvironmentId, 'local:computer')
  assert.deepEqual(views.environments.map(view => [view.environmentId, view.connectionState]), [
    ['local:computer', 'on-demand'], ['remote-one', 'connected'], ['remote-two', 'offline'], ['pending', 'pending'], ['revoked', 'revoked'],
  ])
  assert.equal(views.environments[0].platform, 'darwin')
  assert.equal(views.environments[0].architecture, 'x64')
  assert.equal(views.environments[1].platform, 'linux')
  assert.equal(JSON.stringify(views).includes('/secret/project'), false)
  assert.equal(JSON.stringify(views).includes('credential'), false)
  assert.equal(JSON.stringify(views).includes('privateExtension'), false)
  assert.equal(Object.isFrozen(views), true)
  assert.equal(Object.isFrozen(views.environments), true)
  assert.equal(Object.isFrozen(views.environments[0]), true)
  assert.ok(views.environments.every(view => view.toolSupport.state === 'unknown'), 'identity and an attachment capability hint cannot establish current tool support')
})

test('environment tools describe an observed worker boot independently of connection readiness or grants', () => {
  const local = { platform: 'darwin', architecture: 'arm64' }
  const attachment = (id, origin = 'remote') => ({ attachmentId: id, unitKind: 'computer', origin, state: 'approved',
    unitId: origin === 'local' ? 'computer-local' : id, capabilities: { platform: 'linux', architecture: 'x64', tools: 'all' },
    scope: { kind: 'computer', projects: [], tools: [] } })
  const localInfo = { workerId: 'local-worker', bootId: 'local-boot', ...local, toolManifest: createComputerToolManifest() }
  const manifest = createComputerToolManifest(['claude-code.Read'])
  const connection = { attachmentId: 'remote', unitId: 'remote', bootId: 'remote-boot', platform: 'linux', architecture: 'x64',
    lastSeenAt: 'now', polling: false, connected: false, capabilities: { computerTools: manifest, privateExtension: 'hidden' } }
  const views = projectComputerEnvironments([attachment('local:computer', 'local'), attachment('remote')], local, new Map([['remote', connection]]), localInfo)
  const [localView, remote] = views.environments
  assert.deepEqual(localView.toolSupport, { state: 'reported', workerId: localInfo.workerId, bootId: localInfo.bootId, manifest: localInfo.toolManifest })
  assert.equal(localView.connectionState, 'on-demand')
  assert.deepEqual(remote.toolSupport, { state: 'reported', workerId: 'remote', bootId: 'remote-boot', manifest })
  assert.equal(remote.connectionState, 'offline', 'a cached support report is not a current execution guarantee')
  assert.equal(JSON.stringify(views).includes('privateExtension'), false)
  assert.ok(Object.isFrozen(remote.toolSupport.manifest.tools))
  assert.equal(remote.toolSupport.manifest.tools.length, 1, 'an empty grant does not rewrite a support report')
})

test('old, mismatched and incompatible worker reports stay unknown instead of inheriting a previous contract', () => {
  const attachment = { attachmentId: 'remote', unitKind: 'computer', origin: 'remote', state: 'approved', unitId: 'worker',
    capabilities: { platform: 'linux', architecture: 'x64', computerTools: createComputerToolManifest() } }
  const connection = { attachmentId: 'remote', unitId: 'worker', bootId: 'new-boot', platform: 'linux', architecture: 'x64',
    lastSeenAt: 'now', polling: true, connected: true }
  const view = (record, current = attachment) => projectComputerEnvironments([current], { platform: 'darwin', architecture: 'arm64' }, new Map([['remote', record]])).environments[0]
  assert.deepEqual(view(connection).toolSupport, { state: 'unknown' }, 'an old worker cannot reuse the attach-time manifest')
  assert.deepEqual(view({ ...connection, unitId: 'another-worker', capabilities: { computerTools: createComputerToolManifest() } }).toolSupport, { state: 'unknown' })
  const bad = structuredClone(createComputerToolManifest()); bad.tools[0].definitionHash = '0'.repeat(64)
  assert.deepEqual(view({ ...connection, capabilities: { computerTools: bad } }).toolSupport, { state: 'unknown' })
  assert.deepEqual(view({ ...connection, capabilities: { computerTools: createComputerToolManifest() } }, { ...attachment, state: 'revoked' }).toolSupport, { state: 'unknown' })
})

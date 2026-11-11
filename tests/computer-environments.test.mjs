import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectComputerEnvironments } from '../packages/app-harness/dist/core/computer/environments.js'

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
})

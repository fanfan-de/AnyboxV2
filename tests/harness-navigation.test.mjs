import assert from 'node:assert/strict'
import { test } from 'node:test'
import { harnessHash, parseHarnessRoute, harnessTargetRoute } from '../dist/applications/harness/web/harness-navigation.js'
import { resolveLegacyRoute, restoreLegacyRoute } from '../dist/applications/harness/web/harness-app.js'

test('Harness routes retain one workspace, its selected device and conversation location', () => {
  const route = { hostId: 'server-id', inner: '#/projects/p/sessions/s' }
  assert.match(harnessHash(route), /^#\/harness\/workspace\?/)
  assert.deepEqual(parseHarnessRoute(harnessHash(route)), route)
  assert.deepEqual(parseHarnessRoute('#/projects/p/sessions/s'), { inner: '#/projects/p/sessions/s' })
  assert.equal(harnessHash({ inner: '#' }), '#/harness/workspace')
  const escaped = { hostId: 'server?branch&1', inner: '#/projects/scoped%2Fproject/sessions/scoped%2Fsession?node=root' }
  assert.deepEqual(parseHarnessRoute(harnessHash(escaped)), escaped)
  assert.equal(parseHarnessRoute('#/products/custom/pages/models'), undefined)
  assert.equal(parseHarnessRoute('#/harness/components'), undefined)
})

test('old workspace routes keep their location while removed feature pages return to the workspace', () => {
  const inner = '#/projects/p/sessions/s'
  const query = new URLSearchParams({ host: 'server-id', view: inner })
  for (const prefix of ['#/harness/workspace', '#/products/agent', '#/products/agent/pages/workspace']) {
    assert.deepEqual(parseHarnessRoute(`${prefix}?${query}`), { hostId: 'server-id', inner })
  }
  for (const page of ['models', 'prompts']) {
    for (const prefix of [`#/harness/${page}`, `#/products/agent/pages/${page}`]) {
      assert.deepEqual(parseHarnessRoute(`${prefix}?${query}`), { hostId: 'server-id', inner: '#' })
      assert.equal(resolveLegacyRoute(`${prefix}?${query}`), 'workspace?host=server-id')
    }
  }
})

test('selecting a device preserves the open conversation because the workspace spans devices', () => {
  const local = { hostId: 'local', inner: '#/projects/local-project/sessions/local-session' }
  const remote = parseHarnessRoute(harnessHash(harnessTargetRoute(local, 'remote')))
  assert.deepEqual(remote, { hostId: 'remote', inner: local.inner })
  assert.deepEqual(harnessTargetRoute(local, 'local'), local)
  assert.deepEqual(harnessTargetRoute({ inner: local.inner }, 'remote'), { hostId: 'remote', inner: local.inner })
  assert.deepEqual(harnessTargetRoute(undefined, 'remote'), { hostId: 'remote', inner: '#' })
})

test('stored legacy routes restore to the unified app route and unavailable storage is optional', () => {
  const inner = '#/projects/p/sessions/s'
  const stored = `#/products/agent/pages/workspace?${new URLSearchParams({ host: 'server-id', view: inner })}`
  const expected = harnessHash({ hostId: 'server-id', inner }).replace('#/harness/', '')
  assert.equal(restoreLegacyRoute({ getItem: key => key === 'anybox.harness.route.v1' ? stored : null }), expected)
  assert.equal(restoreLegacyRoute({ getItem: () => '#/harness/prompts?host=server-id&view=obsolete' }), 'workspace?host=server-id')
  assert.equal(restoreLegacyRoute({ getItem: () => '#/products/custom' }), undefined)
  assert.equal(restoreLegacyRoute({ getItem: () => null }), undefined)
  assert.equal(restoreLegacyRoute({ getItem: () => { throw new Error('Storage unavailable') } }), undefined)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../packages/storage-sqlite/dist/sqlite.js'
import { createHostAccessComponent, hostAccessServiceKey } from '../packages/host/dist/access.js'
import { createProjectComponent, projectServiceKey } from '../packages/app-harness/dist/core/project/component.js'
import { startHarnessServerHttp } from './helpers/harness-server-http.mjs'
import { startClientGateway } from './helpers/client-gateway.mjs'

test('local and multiple remote execution environments coexist while new projects keep an explicit binding', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-environment-directory-')), root = new Context()
  let server, gateway, pickerCalls = 0, next = 0, online = true
  const queries = [], environments = { defaultEnvironmentId: 'local:computer', environments: [
    { environmentId: 'local:computer', origin: 'local', state: 'approved', unitId: 'computer-local', platform: process.platform, architecture: process.arch, connectionState: 'on-demand' },
    { environmentId: 'remote-one', origin: 'remote', state: 'approved', unitId: 'worker-one', platform: 'linux', architecture: 'x64', connectionState: 'connected' },
    { environmentId: 'remote-two', origin: 'remote', state: 'approved', unitId: 'worker-two', platform: 'win32', architecture: 'arm64', connectionState: 'offline' },
  ] }
  try {
    await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
    await root.installComponent(createHostAccessComponent('Environment Authority'))
    await root.installComponent(createProjectComponent({ newId: () => `id-${++next}`, now: () => 'now' }, {
      directoryHome: directory, computerQuery: async (attachmentId, query) => {
        queries.push({ attachmentId, query })
        if (!online) throw new Error('offline')
        return { kind: 'stat', directory: true, canonical: query.path }
      },
    }))
    const projects = root.get(projectServiceKey), access = root.get(hostAccessServiceKey), issued = await access.issue('Browser')
    server = await startHarnessServerHttp({
      localDirectorySelectionSupported: () => projects.localDirectorySelectionSupported,
      directoryBrowsingSupported: () => projects.directoryBrowsingSupported,
      directoryCreationSupported: () => projects.directoryCreationSupported,
      directoryPickerSupported: () => true,
      openDirectoryBrowse: (...args) => projects.openDirectoryBrowse(...args),
      readDirectoryPage: (...args) => projects.readDirectoryPage(...args),
      closeDirectoryBrowse: (...args) => projects.closeDirectoryBrowse(...args),
      createDirectory: (...args) => projects.createDirectory(...args),
      listComputerEnvironments: async () => environments,
      openProject: (...args) => projects.openProject(...args),
      pickProject: async () => { pickerCalls++; return null },
    }, 0, { access })
    const headers = { Authorization: `Bearer ${issued.token}`, 'X-Anybox-Instance-Id': access.instance.instanceId }
    const request = async (path, body) => {
      const prefix = path === '/computer-environments' ? '/api/v1/apps/agent' : '/api/v1'
      const response = await fetch(server.url + prefix + path, { method: body ? 'POST' : 'GET',
        headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
      return { status: response.status, data: await response.json() }
    }
    assert.deepEqual((await request('/computer-environments')).data, environments)
    const info = (await request('/instance')).data
    for (const capability of ['projects.browse', 'projects.create-directory', 'projects.local-directories', 'computer-environments']) {
      assert.equal(info.capabilities.includes(capability), true, `local capability ${capability} remains available alongside remote environments`)
    }
    const local = await request('/projects', { path: directory })
    assert.equal(local.status, 200); assert.equal(local.data.computerAttachmentId, 'local:computer')
    assert.deepEqual(queries, [], 'default local registration does not contact any remote worker')
    const remote = await request('/projects', { path: directory, computerAttachmentId: 'remote-one' })
    const second = await request('/projects', { path: directory, computerAttachmentId: 'remote-two' })
    assert.equal(remote.status, 200); assert.equal(remote.data.computerAttachmentId, 'remote-one')
    assert.equal(second.status, 200); assert.equal(second.data.computerAttachmentId, 'remote-two')
    assert.equal(new Set([local.data.id, remote.data.id, second.data.id]).size, 3, 'the same path has a different identity on each environment')
    assert.deepEqual(queries, [
      { attachmentId: 'remote-one', query: { kind: 'stat', path: directory } },
      { attachmentId: 'remote-two', query: { kind: 'stat', path: directory } },
    ])
    assert.equal(pickerCalls, 0, 'explicit remote registration never asks for a host-native picker')
    online = false
    const rejected = await request('/projects', { path: '/must-stay-remote', computerAttachmentId: 'remote-one' })
    assert.equal(rejected.status, 409); assert.equal(rejected.data.error.code, 'project-unavailable')
    assert.equal((await projects.listProjects()).length, 3, 'an unavailable remote request cannot create a local replacement')
    const browsing = await request('/projects/directories/browse', { action: 'open', path: directory })
    assert.equal(browsing.status, 200)
    const firstPage = await request('/projects/directories/browse', { action: 'page', browseId: browsing.data.browseId, page: 0 })
    assert.equal(firstPage.status, 200)
    const created = await request('/projects/directories/create', { browseId: browsing.data.browseId, name: 'local-child' })
    assert.equal(created.status, 201); assert.equal((await stat(join(directory, 'local-child'))).isDirectory(), true)
    await request('/projects/directories/close', { browseId: browsing.data.browseId })
    const connection = { id: 'local', instanceId: access.instance.instanceId, revision: 1 }
    gateway = await startClientGateway({ list: async () => [connection], check: async () => info },
      { localInstanceId: connection.instanceId, picker: { supported: true, async pick() { pickerCalls++; return directory } } })
    const picked = await fetch(gateway.url + '/api/client/v1/connections/local/pick', { method: 'POST',
      headers: { Origin: gateway.url, 'Content-Type': 'application/json', 'X-Anybox-Expected-Instance-Id': connection.instanceId, 'X-Anybox-Connection-Revision': '1' }, body: '{}' })
    assert.equal(picked.status, 200); assert.equal(pickerCalls, 1, 'trusted local native selection remains available')
  } finally {
    try { await gateway?.close(); await server?.close(); await root.fiber.dispose() }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
})

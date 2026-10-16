import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '../dist/storage/sqlite.js'
import { createHostAccessComponent, hostAccessServiceKey } from '../dist/host/access.js'
import { createProjectComponent, projectServiceKey } from '../dist/applications/harness/core/project/component.js'
import { startHarnessServerHttp } from './helpers/harness-server-http.mjs'
import { startClientGateway } from './helpers/client-gateway.mjs'

test('remote-default HTTP advertises manual selection and rejects host browsing, creation and both native picker routes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-remote-directory-')), root = new Context()
  let server, gateway, pickerCalls = 0, next = 0
  const queries = []
  try {
    await root.installComponent(createLocalSqliteComponent(join(directory, 'state.sqlite')))
    await root.installComponent(createHostAccessComponent('Remote-default Authority'))
    await root.installComponent(createProjectComponent({ newId: () => `id-${++next}`, now: () => 'now' }, {
      directoryHome: directory, defaultComputerAttachmentId: 'remote-computer', computerQuery: async (attachmentId, query) => {
        queries.push({ attachmentId, query }); return { kind: 'stat', directory: true, canonical: query.path }
      },
    }))
    const projects = root.get(projectServiceKey), access = root.get(hostAccessServiceKey), issued = await access.issue('Browser')
    server = await startHarnessServerHttp({
      localDirectorySelectionSupported: () => projects.localDirectorySelectionSupported,
      directoryBrowsingSupported: () => projects.directoryBrowsingSupported,
      directoryCreationSupported: () => projects.directoryCreationSupported,
      directoryPickerSupported: () => true,
      openDirectoryBrowse: (...args) => projects.openDirectoryBrowse(...args),
      createDirectory: (...args) => projects.createDirectory(...args),
      openProject: (...args) => projects.openProject(...args),
      pickProject: async () => { pickerCalls++; return null },
    }, 0, { access })
    const headers = { Authorization: `Bearer ${issued.token}`, 'X-Anybox-Instance-Id': access.instance.instanceId }
    const request = async (path, body) => {
      const response = await fetch(server.url + '/api/v1' + path, { method: body ? 'POST' : 'GET',
        headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
      return { status: response.status, data: await response.json() }
    }
    const info = (await request('/instance')).data
    assert.equal(info.capabilities.includes('projects.browse'), false)
    assert.equal(info.capabilities.includes('projects.create-directory'), false)
    assert.equal(info.capabilities.includes('projects.local-directories'), false)
    assert.deepEqual((await request('/projects/picker')).data, { supported: false })
    assert.equal((await request('/projects/pick', {})).data.error.code, 'picker-unsupported')
    assert.equal((await request('/projects/directories/browse', { action: 'open', path: directory })).data.error.code, 'directory-browse-unsupported')
    assert.equal((await request('/projects/directories/create', { browseId: 'none', name: 'must-not-create' })).data.error.code, 'directory-create-unsupported')
    const connection = { id: 'local', instanceId: access.instance.instanceId, revision: 1 }
    gateway = await startClientGateway({ list: async () => [connection], check: async () => (await request('/instance')).data },
      { localInstanceId: connection.instanceId, picker: { supported: true, async pick() { pickerCalls++; return directory } } })
    const rejected = await fetch(gateway.url + '/api/client/v1/connections/local/pick', { method: 'POST',
      headers: { Origin: gateway.url, 'Content-Type': 'application/json', 'X-Anybox-Expected-Instance-Id': connection.instanceId, 'X-Anybox-Connection-Revision': '1' }, body: '{}' })
    assert.equal(rejected.status, 403)
    assert.equal((await rejected.json()).error.code, 'picker-unavailable')
    assert.equal(pickerCalls, 0)
    await assert.rejects(stat(join(directory, 'must-not-create')), { code: 'ENOENT' })
    const registered = await request('/projects', { path: '/remote/project' })
    assert.equal(registered.status, 200)
    assert.equal(registered.data.computerAttachmentId, 'remote-computer')
    assert.deepEqual(queries, [{ attachmentId: 'remote-computer', query: { kind: 'stat', path: '/remote/project' } }])
  } finally {
    try { await gateway?.close(); await server?.close(); await root.fiber.dispose() }
    finally { await rm(directory, { recursive: true, force: true }) }
  }
})

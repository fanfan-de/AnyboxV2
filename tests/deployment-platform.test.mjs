import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { createSystemKeyringStore } from '@anybox/api-key-manager'
import { createHarnessHost } from '../dist/host/harness-main.js'
import { parseWebStartupConfig } from '../dist/host/startup-config.js'
import { createClientHost } from '../dist/host/client-main.js'

test('real deployment platform: native credentials, headless host, Bash, image bytes and clean shutdown', { skip: process.env.ANYBOX_DEPLOYMENT_TESTS !== '1' }, async () => {
  assert.ok(['darwin', 'linux'].includes(process.platform), 'execution hosts support macOS/Linux')
  const dir = await mkdtemp(join(tmpdir(), 'anybox-platform-')), namespace = `anybox.platform.${randomUUID()}`
  const vault = createSystemKeyringStore({ namespace }), id = randomUUID(); let h, c
  try {
    await vault.write(id, 'test-only-value'); assert.equal(await vault.read(id), 'test-only-value')
    const config = parseWebStartupConfig({ ANYBOX_WEB_PORT: '0', ANYBOX_HARNESS_DATABASE: join(dir, 'harness.sqlite'), ANYBOX_MODELS_DATABASE: join(dir, 'models.sqlite'), ANYBOX_MODELS_NAMESPACE: namespace })
    h = await createHarnessHost(config, { models: { catalogAutoRefresh: false, readLegacyCredential: async () => undefined } })
    const issued = await h.root.get('host.access').issue('platform client')
    c = await createClientHost({ path: join(dir, 'client.sqlite'), namespace: namespace + '.client' })
    const connection = await c.root.get('client.connections').save({ name: 'platform', endpoint: h.url, token: issued.token })
    assert.equal((await c.root.get('client.connections').check(connection.id)).instanceId, h.instance.instanceId)
    const project = await h.harness.openProject(dir), session = await h.harness.createSession(project.id, 'assistant')
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer()
    const response = await fetch(`${c.url}/api/connections/${connection.id}/v1/sessions/${session.id}/images`, { method: 'POST', headers: { Origin: c.url, 'Content-Type': 'image/png' }, body: bytes })
    assert.equal(response.status, 201)
    const image = await response.json()
    const downloaded = await fetch(`${c.url}/api/connections/${connection.id}/v1/sessions/${session.id}/images/${image.assetId}/content`)
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes)
    const operation = h.root.get('tools.bash').execute({ projectId: project.id, command: 'printf platform-ok' }); assert.equal((await operation.result).stdout, 'platform-ok'); await operation.done
    await c.root.get('client.connections').remove(connection.id, connection.revision)
  } finally { if (c) for (const connection of await c.root.get('client.connections').list()) await c.root.get('client.connections').remove(connection.id, connection.revision); await c?.close(); await h?.close(); await vault.delete(id); await vault.close(); await rm(dir, { recursive: true, force: true }) }
})

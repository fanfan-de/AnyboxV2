import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import sharp from 'sharp'
import { modelsVaultServiceKey } from '@anybox/models'
import { createHarnessServer } from '../dist/entrypoints/harness-server-main.js'
import { parseHarnessServerConfig } from '../dist/applications/harness/server-config.js'
import { createClientHost } from '../dist/entrypoints/client-main.js'
import { connectLocalComputerWorker } from '../dist/applications/harness/core/computer/worker-client.js'
import { computerDeclarationDigest } from '../dist/applications/harness/core/computer/operations-domain.js'
import { getToolById } from '../dist/applications/harness/core/tool/catalog.js'

test('real deployment platform: native credentials, headless pairing, independent worker tools, image bytes and clean shutdown', { skip: process.env.ANYBOX_DEPLOYMENT_TESTS !== '1', timeout: 120_000 }, async () => {
  assert.ok(['win32', 'darwin', 'linux'].includes(process.platform), 'execution hosts support Windows, macOS and Linux')
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'anybox-platform-中文 '))), namespace = `anybox.platform.${randomUUID()}`
  const id = randomUUID(), workerDirectory = join(dir, 'harness.sqlite.computer-worker')
  const observer = connectLocalComputerWorker({ directory: workerDirectory, autoStart: false })
  let h, c, vault, workerPid
  try {
    const config = parseHarnessServerConfig({ ANYBOX_HARNESS_PORT: '0', ANYBOX_HARNESS_DATABASE: join(dir, 'harness.sqlite'), ANYBOX_MODELS_DATABASE: join(dir, 'models.sqlite'), ANYBOX_MODELS_NAMESPACE: namespace })
    h = await createHarnessServer(config, { models: { catalogAutoRefresh: false, readLegacyCredential: async () => undefined } })
    const issued = await h.root.get('host.access').issue('platform client')
    c = await createClientHost({ path: join(dir, 'client.sqlite'), namespace: namespace + '.client', computer: { directory: workerDirectory } })
    await c.products.open('agent'); await h.products.open('agent')
    vault = h.root.get(modelsVaultServiceKey)
    assert.equal(await vault.read(id), undefined)
    await vault.write(id, 'test-only-value'); assert.equal(await vault.read(id), 'test-only-value')
    const connection = await c.root.get('client.connections').save({ name: 'platform', endpoint: h.url, token: issued.token })
    assert.equal((await c.root.get('client.connections').check(connection.id)).instanceId, h.instance.instanceId)
    const project = await h.api.openProject(dir), session = await h.api.createSession(project.id, 'assistant')
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer()
    const response = await fetch(`${c.url}/api/connections/${connection.id}/v1/sessions/${session.id}/images`, { method: 'POST', headers: { Origin: c.url, 'Content-Type': 'image/png' }, body: bytes })
    assert.equal(response.status, 201)
    const image = await response.json()
    const downloaded = await fetch(`${c.url}/api/connections/${connection.id}/v1/sessions/${session.id}/images/${image.assetId}/content`)
    assert.equal(downloaded.status, 200)
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes)

    // The headless harness owns only a worker client; tools live in a separate
    // worker process and are admitted through its durable declaration protocol.
    assert.equal(h.root.get('tools.bash'), undefined)
    const worker = h.root.get('computer.worker'), info = await worker.info()
    const status = await observer.status(); workerPid = status.pid
    assert.equal(status.state, 'running'); assert.equal(info.platform, process.platform)
    assert.notEqual(workerPid, process.pid)
    const owner = { runId: `platform-${randomUUID()}`, runOwnerEpoch: 1, attachmentId: 'local:computer' }
    await worker.claimRun(owner)
    const completed = async operationId => {
      for (let attempt = 0; attempt < 1500; attempt++) {
        const fact = await worker.get({ ...owner, operationId })
        if (fact && ['succeeded', 'failed', 'cancelled', 'outcome-unknown'].includes(fact.state)) {
          assert.equal(fact.state, 'succeeded', JSON.stringify(fact.error)); return fact
        }
        await delay(20)
      }
      assert.fail(`Worker operation did not settle: ${operationId}`)
    }
    const preparedAt = new Date().toISOString()
    let number = 0
    const tool = async (toolId, args) => {
      const operationId = `platform-tool-${++number}`, entry = getToolById(toolId)
      const declaration = { schemaVersion: 1, operationId, runId: owner.runId, sessionId: session.id, projectId: project.id,
        tool: { toolId, version: entry.version, definition: entry.definition }, request: { id: operationId, name: entry.definition.name, arguments: args },
        workspaceId: 'platform-workspace', workspaceRevision: 0, computerId: 'local', spec: { providerId: 'local', platform: process.platform, architecture: process.arch } }
      const binding = { bindingId: 'platform-binding', reservationId: 'platform-reservation', workspaceId: declaration.workspaceId, projectId: project.id, scopeId: owner.runId,
        computerId: 'local', computerInstanceId: `${info.workerId}:${info.bootId}`, instanceGeneration: 1, workspaceEpoch: 1, revision: 0, path: project.path, preparedAt }
      await worker.submit({ ...owner, operationId, kind: 'tool', declaration, declarationDigest: computerDeclarationDigest(declaration), binding, workerBootId: info.bootId })
      return (await completed(operationId)).observation.result
    }
    const bash = await tool('anybox.bash', { command: 'printf platform-ok' })
    assert.equal(bash.exitCode, 0); assert.equal(bash.stdout, 'platform-ok')
    const native = await tool('codex.exec_command', { cmd: process.platform === 'win32' ? "Write-Output 'native-shell-ok'" : "printf 'native-shell-ok'", yield_time_ms: 30_000 })
    assert.equal(native.exit_code, 0); assert.equal(native.output.trim(), 'native-shell-ok')
    await worker.submit({ ...owner, operationId: 'platform-close', kind: 'close-scope', declarationDigest: 'platform-close' })
    await completed('platform-close')
    await c.root.get('client.connections').remove(connection.id, connection.revision)
    assert.deepEqual(await c.root.get('client.connections').list(), [])
    await vault.delete(id); assert.equal(await vault.read(id), undefined)
  } finally {
    const errors = [], attempt = async work => { try { await work() } catch (error) { errors.push(error) } }
    await attempt(async () => { if (c) for (const connection of await c.root.get('client.connections')?.list() ?? []) await c.root.get('client.connections').remove(connection.id, connection.revision) })
    await attempt(async () => { if (vault) await vault.delete(id) })
    await attempt(() => c?.close()); await attempt(() => h?.close())
    await attempt(() => observer.shutdown())
    if ((await observer.status()).state !== 'stopped' && workerPid) {
      await attempt(async () => { process.kill(workerPid, 'SIGKILL'); for (let i = 0; i < 100; i++) { try { process.kill(workerPid, 0) } catch { return }; await delay(20) }; throw new Error('Fixture worker did not exit') })
    }
    await attempt(() => observer.closeObserver())
    await attempt(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
    if (errors.length) throw new AggregateError(errors, 'Deployment fixture cleanup failed')
  }
})

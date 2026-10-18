import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createExecutionHost } from '../packages/host/dist/execution.js'
import { harnessServerApplication } from '../packages/app-harness/dist/registration.js'
import { parseHarnessServerConfig } from '../packages/app-harness/dist/server-config.js'
import { createStandaloneHarnessServer } from '../packages/app-harness/dist/server.js'
import { claudeAgentServerApplication } from '../packages/app-claude-agent/dist/registration.js'
import { createClaudeAgentServer } from '../packages/app-claude-agent/dist/server.js'
import { parseClaudeAgentServerConfig } from '../packages/app-claude-agent/dist/server-config.js'
import { hostAccessServiceKey as claudeAccessKey } from '../packages/app-claude-agent/dist/server-access.js'
import { fakeSdk } from './helpers/claude-agent.mjs'

test('Anybox and standalone applications reopen the same data, identity and tokens without a second database owner', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-standalone-compatibility-'))
  const projectPath = join(directory, 'project'); await mkdir(projectPath)
  const env = { ANYBOX_HARNESS_DATABASE: join(directory, 'harness.sqlite'), ANYBOX_MODELS_DATABASE: join(directory, 'models.sqlite') }
  const config = parseHarnessServerConfig(env), claudeConfig = parseClaudeAgentServerConfig(env)
  const secrets = new Map(), models = { catalogAutoRefresh: false, readLegacyCredential: async () => undefined,
    openEntry(namespace, id) { const key = `${namespace}:${id}`; return {
      getPassword: async () => secrets.get(key), setPassword: async value => { secrets.set(key, value) }, deleteCredential: async () => secrets.delete(key),
    } },
  }
  const sdkComponent = { name: 'compatibility-sdk', apply(ctx) { ctx.provide('claude-agent.sdk', fakeSdk().port) } }
  const applications = [harnessServerApplication(config, { models }), claudeAgentServerApplication({}, { sdkComponent })]
  let host, harness, claude
  t.after(async () => { try { await Promise.all([host?.close(), harness?.close(), claude?.close()]) } finally { await rm(directory, { recursive: true, force: true }) } })
  const startHost = async () => {
    const current = await createExecutionHost({ databasePath: config.harnessDatabasePath, applications })
    await current.ready
    await Promise.all(['agent', 'claude-agent'].map(id => current.products.open(id)))
    return current
  }
  const targets = root => root.get('local-storage').read(reader => reader.all('SELECT id,desired_enabled FROM app_product_targets ORDER BY id'))
  const call = async (server, token, path) => {
    const response = await fetch(server.url + path, { headers: { authorization: `Bearer ${token}`, 'x-anybox-instance-id': server.instance.instanceId } })
    return { status: response.status, data: await response.json() }
  }

  host = await startHost()
  const issued = await host.root.get('host.access').issueManaged('desktop-compatibility', 'Old device')
  const instanceId = host.instance.instanceId
  const project = await host.root.get('harness.projects').openProject(projectPath)
  const session = await host.root.get('harness.sessions').createSession(project.id, 'assistant')
  const thread = await host.root.get('claude-agent.runs').createThread({ projectPath, title: 'Existing Claude thread' })
  const savedTargets = await targets(host.root)
  await host.close(); host = undefined

  harness = await createStandaloneHarnessServer(config, { models })
  assert.equal(harness.instance.instanceId, instanceId)
  assert.equal(harness.access.authenticate(`Bearer ${issued.token}`), issued.record.id)
  await harness.access.reconcileManaged('desktop-compatibility', issued.token)
  assert.equal((await call(harness, issued.token, `/api/v1/apps/agent/sessions/${session.id}`)).data.id, session.id)
  assert.equal((await call(harness, issued.token, '/api/v1/projects')).status, 200, 'existing Harness aliases remain available')
  assert.equal((await call(harness, issued.token, '/api/v1/products')).status, 404, 'standalone serves no Anybox management API')
  assert.deepEqual(await targets(harness.root), savedTargets, 'standalone does not restore or change Anybox targets')
  await assert.rejects(createClaudeAgentServer(claudeConfig, { sdkComponent }), 'another application cannot open the owned file')
  await assert.rejects(createExecutionHost({ databasePath: config.harnessDatabasePath, applications: [] }), 'Anybox cannot open the owned file')
  const standaloneSession = await harness.api.createSession(project.id, 'assistant')
  await harness.close(); harness = undefined

  claude = await createClaudeAgentServer(claudeConfig, { sdkComponent })
  assert.equal(claude.instance.instanceId, instanceId)
  const claudeAccess = claude.root.get(claudeAccessKey)
  assert.equal(claudeAccess.authenticate(`Bearer ${issued.token}`), issued.record.id)
  assert.equal((await call(claude, issued.token, `/api/v1/apps/claude-agent/threads/${thread.id}`)).data.title, 'Existing Claude thread')
  assert.equal((await call(claude, issued.token, '/api/v1/apps/agent/projects')).status, 404)
  assert.deepEqual(await targets(claude.root), savedTargets)
  const newThread = await claude.root.get('claude-agent.runs').createThread({ projectPath, title: 'Standalone thread' })
  const newToken = await claudeAccess.issue('Standalone device')
  await claude.close(); claude = undefined

  host = await startHost()
  assert.equal(host.instance.instanceId, instanceId)
  assert.equal(host.root.get('host.access').authenticate(`Bearer ${newToken.token}`), newToken.record.id)
  assert.equal((await host.root.get('harness.sessions').getSession(standaloneSession.id)).id, standaloneSession.id)
  assert.equal((await host.root.get('claude-agent.runs').getThread(newThread.id)).title, 'Standalone thread')
  assert.deepEqual(await targets(host.root), savedTargets)
  await host.close(); host = undefined
  const bytes = await readFile(config.harnessDatabasePath)
  for (const token of [issued.token, newToken.token]) assert.equal(bytes.includes(Buffer.from(token.split('.')[1])), false, 'only digests enter the business file')
})

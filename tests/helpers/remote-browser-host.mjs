import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@nya/core'
import { createHarness } from '../../dist/harness/index.js'
import { createImageAssetsComponent } from '../../dist/harness/image/component.js'
import { createLocalSqliteComponent } from '../../dist/storage/sqlite.js'
import { createHostAccessComponent } from '../../dist/host/access.js'
import { createHarnessApiComponent } from '../../dist/host/component.js'
import { createClientHost } from '../../dist/host/client-main.js'
import { installManagedModels } from './managed-models.mjs'
const dir = await mkdtemp(join(tmpdir(), 'anybox-browser-')), hosts = [], values = new Map()
const client = await createClientHost({ path: join(dir, 'client.sqlite'), openEntry: (_ns,id) => ({ async getPassword(){ return values.get(id) }, async setPassword(value){ values.set(id,value) }, async deleteCredential(){ return values.delete(id) } }) })
for (const name of ['Local laptop', 'Cloud server', 'Other computer']) {
  const path = join(dir, name); await mkdir(path)
  const root = new Context(), models = await installManagedModels(root, path)
  await root.installComponent(createLocalSqliteComponent(join(path, 'harness.sqlite')))
  await root.installComponent(createHostAccessComponent(name))
  await root.installComponent(createImageAssetsComponent({ directory: join(path, 'images') }))
  const harness = await createHarness(root, { agents: [{ id: 'assistant', modelId: 'default', instructions: 'Test' }] }); hosts.push(harness)
  const project = await harness.openProject(path)
  for (let i = 0; i < 2; i++) {
    const session = await harness.createSession(project.id, 'assistant')
    const run = await harness.startRun({ sessionId: session.id, parentNodeId: null, input: `Hello from ${name} ${i + 1}`, idempotencyKey: 'init' })
    const call = models.controlled.calls.at(-1); call.result.resolve(`Reply from ${name}.`); call.done.resolve(); await harness.waitRun(run.id)
  }
  await root.installComponent(createHarnessApiComponent(harness.listAgents(), 0, { authenticated: true }))
  const token = await root.get('host.access').issue('test browser')
  await client.root.get('client.connections').save({ name, endpoint: root.get('host.harness-api').url, token: token.token })
}
console.log(client.url)
const stop = async () => { await client.close(); for (const h of hosts) await h.close(); await rm(dir, { recursive: true, force: true }) }
process.once('SIGTERM', stop); process.once('SIGINT', stop)

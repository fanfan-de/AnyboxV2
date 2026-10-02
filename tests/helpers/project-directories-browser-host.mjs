// Real authenticated Harnesses and gateway; all data and credentials are disposable.
import { mkdtemp, mkdir, rm, symlink, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Context } from '@nya/core'
import { createTestHarnessHost } from './harness-host.mjs'
import { createImageAssetsComponent } from '../../dist/applications/harness/core/image/component.js'
import { createLocalSqliteComponent } from '../../dist/storage/sqlite.js'
import { createHostAccessComponent } from '../../dist/host/access.js'
import { createFixtureApplicationApiComponent } from './application-api.mjs'
import { createClientHost } from '../../dist/entrypoints/client-main.js'
import { installManagedModels } from './managed-models.mjs'

const directory = await mkdtemp(join(tmpdir(), 'anybox-directory-browser-'))
const shared = join(directory, 'shared-project')
await mkdir(shared)
const hosts = [], values = new Map()
let client
let stopping
async function stop() {
  if (stopping) return stopping
  stopping = (async () => {
    await client?.close()
    for (const host of hosts) await host.harness.close()
    for (const host of hosts) await chmod(join(host.home, 'restricted'), 0o700)
    await rm(directory, { recursive: true, force: true })
  })()
  return stopping
}
try {
  for (const [index, name] of ['目录测试 A', '目录测试 B', '旧版测试'].entries()) {
    const data = join(directory, `data-${index}`), home = join(directory, `home-${index}`)
    await mkdir(data); await mkdir(home)
    for (const child of ['projects', 'empty', '.hidden', 'large', 'restricted']) await mkdir(join(home, child))
    await mkdir(join(home, 'projects', `project-${index}`))
    for (let n = 0; n < 115; n++) await mkdir(join(home, 'large', `folder-${String(n).padStart(3, '0')}`))
    await writeFile(join(home, 'ordinary.txt'), 'Files never appear as directories.\n')
    await symlink(join(home, 'projects'), join(home, 'projects-link'))
    await symlink(join(home, 'missing'), join(home, 'broken-link'))
    await chmod(join(home, 'restricted'), 0)
    const root = new Context()
    await installManagedModels(root, data)
    await root.installComponent(createLocalSqliteComponent(join(data, 'harness.sqlite')))
    await root.installComponent(createHostAccessComponent(name))
    await root.installComponent(createImageAssetsComponent({ directory: join(data, 'images') }))
    const harness = await createTestHarnessHost(root, { agents: [{ id: 'assistant', modelId: 'default', instructions: 'Test' }],
      ...(index < 2 ? { projectDirectoryHome: home } : {}) })
    const host = { root, harness, home, name }; hosts.push(host)
    await root.installComponent(createFixtureApplicationApiComponent(root, harness.listAgents(), 0, { authenticated: true }))
    host.instanceId = root.get('host.access').instance.instanceId
  }
  client = await createClientHost({ path: join(directory, 'client.sqlite'), localInstanceId: hosts[0].instanceId,
    picker: { platform: 'darwin', runDialog: async () => shared },
    openEntry: (_namespace, id) => ({
      async getPassword() { return values.get(id) }, async setPassword(value) { values.set(id, value) },
      async deleteCredential() { return values.delete(id) },
    }),
  })
  await client.products.open('agent')
  for (const host of hosts) {
    const token = await host.root.get('host.access').issue('Disposable browser test')
    host.connection = await client.root.get('client.connections').save({ name: host.name,
      endpoint: host.root.get('host.http').url, token: token.token })
  }
  console.log(JSON.stringify({ url: client.url, shared,
    hosts: hosts.map(({ name, home, instanceId, connection }) => ({ name, home, instanceId, connectionId: connection.id })) }))
  const input = createInterface({ input: process.stdin })
  input.on('line', line => {
    if (line === 'stop-b') void hosts[1].harness.close().then(() => console.log('B stopped'))
    if (line === 'quit') { input.close(); void stop() }
  })
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { input.close(); void stop() })
} catch (error) { await stop(); throw error }

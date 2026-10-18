import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, mkdir, writeFile, readFile, cp, access, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { createClientHost } from '../dist/index.js'

const execFile = promisify(execFileCallback)
const exists = path => access(path).then(() => true, () => false)

test('the public host serves a pure interface without optional business providers and permits its import map through CSP', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-minimum-host-'))
  let host
  t.after(async () => { try { await host?.close() } finally { await rm(directory, { recursive: true, force: true }) } })
  const entry = join(directory, 'calculator.js')
  await writeFile(entry, 'export async function mount(container, context) { container.textContent = "Calculator"; return { setActive() {}, canClose: () => true, async dispose() {} } }')
  host = await createClientHost({ path: join(directory, 'control.sqlite'), applications: [{
    definition: { id: 'calculator', name: 'Calculator', icon: 'calculator', web: { entry: '/apps/calculator.js' } },
    assets: [{ path: '/apps/calculator.js', file: entry, type: 'text/javascript; charset=utf-8' }],
  }] })
  const view = await host.products.open('calculator')
  assert.equal(view.definition.runtime, false)
  assert.equal(view.definition.http, false)
  assert.equal(view.desiredEnabled, false)
  assert.equal(view.state, 'running')
  for (const key of ['client.connections', 'host.directory-picker', 'models', 'harness.runs', 'computer.worker']) assert.equal(host.root.get(key), undefined, `${key} must not be installed by the host`)
  const response = await fetch(host.url), html = await response.text()
  assert.equal(response.status, 200)
  const map = /<script\b[^>]*type="importmap"[^>]*>([\s\S]*?)<\/script>/.exec(html)
  assert.ok(map, 'the delivered shell must contain its actual import map')
  assert.deepEqual(JSON.parse(map[1]), { imports: { '@anybox/application-api/web': '/application-api/web.js' } })
  const csp = response.headers.get('content-security-policy')
  assert.ok(csp.includes(`'sha256-${createHash('sha256').update(map[1]).digest('base64')}'`), 'CSP must permit the exact delivered import-map bytes')
  assert.equal(csp.includes('unsafe-inline'), false)
  const api = await fetch(host.url + JSON.parse(map[1]).imports['@anybox/application-api/web'])
  assert.equal(api.status, 200)
  assert.match(api.headers.get('content-type'), /^text\/javascript/)
  assert.match(await api.text(), /requireApplicationHttp/)
  assert.equal((await fetch(host.url + '/apps/calculator.js')).status, 200)
  assert.equal((await fetch(host.url + '/api/client/v1/apps/calculator/value')).status, 404)
  const target = await host.root.get('local-storage').read(reader => reader.get('SELECT id FROM app_product_targets WHERE id=?', ['calculator']))
  assert.equal(target, undefined)
  await host.close()
  await assert.rejects(fetch(host.url))
})

async function packageDirectory(name, from) {
  let directory = await realpath(from)
  for (;;) {
    const own = join(directory, 'package.json')
    if (await exists(own) && JSON.parse(await readFile(own, 'utf8')).name === name) return directory
    const installed = join(directory, 'node_modules', name)
    if (await exists(join(installed, 'package.json'))) return realpath(installed)
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`Cannot locate installed package ${name}`)
    directory = parent
  }
}

/** Copy published payloads without symlinks or the monorepo's hoisted node_modules. */
async function copyRuntimeClosure(name, from, destination, copied = new Set()) {
  if (copied.has(name)) return copied
  copied.add(name)
  const directory = await packageDirectory(name, from), manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  const target = join(destination, 'node_modules', name)
  await mkdir(target, { recursive: true })
  await cp(join(directory, 'package.json'), join(target, 'package.json'))
  if (Array.isArray(manifest.files)) for (const path of manifest.files) {
    assert.equal(path.includes('*'), false, 'Extend the isolation fixture when a runtime payload gains a glob')
    if (await exists(join(directory, path))) await cp(join(directory, path), join(target, path), { recursive: true, dereference: true })
  } else {
    assert.equal(name.startsWith('@anybox/') || name === '@nya/core', false, `${name} must declare its published payload`)
    // Installed third-party packages may publish their payload without a files
    // allowlist. Copy that physical payload while traversing dependencies below.
    await cp(directory, target, { recursive: true, dereference: true,
      filter: path => path === directory || !path.slice(directory.length + 1).split(/[\\/]/).includes('node_modules') })
  }
  const dependencies = { ...manifest.dependencies, ...Object.fromEntries(Object.entries(manifest.peerDependencies ?? {}).filter(([id]) => !manifest.peerDependenciesMeta?.[id]?.optional)) }
  for (const dependency of Object.keys(dependencies)) await copyRuntimeClosure(dependency, directory, destination, copied)
  return copied
}

test('host runs from only its declared published dependency closure with no applications, Vault or device packages installed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-host-isolated-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const copied = await copyRuntimeClosure('@anybox/host', resolve(dirname(fileURLToPath(import.meta.url)), '..'), directory)
  assert.deepEqual([...copied].sort(), ['@anybox/application-api', '@anybox/host', '@anybox/storage-sqlite', '@nya/core', '@standard-schema/spec', 'acorn', 'semver'].sort())
  for (const dependency of ['@anybox/app-harness', '@anybox/app-claude-agent', '@anybox/execution-connections', '@anybox/directory-picker', '@anybox/models', '@anybox/api-key-manager', '@napi-rs/keyring']) assert.equal(await exists(join(directory, 'node_modules', dependency)), false)
  const code = `
    import assert from 'node:assert/strict';
    import { createClientHost } from '@anybox/host';
    const host = await createClientHost({ path: './control.sqlite', applications: [] });
    try {
      assert.deepEqual(host.products.list(), []);
      assert.equal(host.root.get('client.connections'), undefined);
      assert.equal((await fetch(host.url)).status, 200);
      assert.equal((await fetch(host.url + '/application-api/web.js')).status, 200);
    } finally { await host.close(); }
    process.stdout.write('minimum-host-ready');
  `
  const result = await execFile(process.execPath, ['--input-type=module', '--eval', code], { cwd: directory,
    env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' }, timeout: 30_000 })
  assert.equal(result.stdout, 'minimum-host-ready')
})

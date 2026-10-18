import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, lstat, symlink } from 'node:fs/promises'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stageProductionClosure, stageMinimalHost, currentArtifactTarget, buildApplicationArchive, buildApplicationDirectory } from '../scripts/application-artifacts.mjs'

async function fixture(t, packages) {
  const root = await mkdtemp(join(tmpdir(), 'anybox-artifact-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'artifact-fixture', private: true, type: 'module' }))
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }))
  for (const [name, metadata] of Object.entries(packages)) {
    const directory = join(root, 'node_modules', name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', main: './index.js', files: ['index.js', 'LICENSE'], ...metadata }))
    await writeFile(join(directory, 'index.js'), 'export const complete = true\n')
    await writeFile(join(directory, 'LICENSE'), 'Fixture license text\n')
  }
  return root
}
test('production staging copies physical closure and licenses, strips build scripts and excludes Claude platform executables', async t => {
  const root = await fixture(t, {
    '@anybox/app-fixture': { dependencies: { dependency: '1.0.0' }, devDependencies: { development: '1.0.0' },
      optionalDependencies: { '@anthropic-ai/claude-agent-sdk-darwin-arm64': '1.0.0' }, scripts: { postinstall: 'throw-away' } },
    dependency: {},
  })
  const output = join(root, 'output'), result = await stageProductionClosure(root, output, ['@anybox/app-fixture'])
  assert.deepEqual(result.packages.map(pkg => pkg.name).sort(), ['@anybox/app-fixture', 'dependency'])
  const metadata = JSON.parse(await readFile(join(output, 'node_modules/@anybox/app-fixture/package.json'), 'utf8'))
  assert.equal(metadata.scripts, undefined); assert.equal(metadata.devDependencies, undefined); assert.equal(metadata.optionalDependencies, undefined)
  assert.equal((await lstat(join(output, 'node_modules/dependency'))).isSymbolicLink(), false)
  assert.equal((await readFile(join(output, 'licenses/dependency@1.0.0/LICENSE'), 'utf8')).trim(), 'Fixture license text')
  assert.ok((await readdir(join(output, 'node_modules'))).includes('dependency'))
})
test('missing required production dependencies fail instead of asking the user to install at runtime', async t => {
  const root = await fixture(t, { application: { dependencies: { missing: '1.0.0' } } })
  await assert.rejects(stageProductionClosure(root, join(root, 'output'), ['application']), /Missing prebuilt production dependency missing/)
})
test('host-only closure rejects an accidentally introduced application dependency', async t => {
  const root = await fixture(t, { '@anybox/host': { dependencies: { '@anybox/app-fixture': '1.0.0' } }, '@anybox/app-fixture': {} })
  await assert.rejects(stageMinimalHost(root, join(root, 'output')), /unexpectedly includes: @anybox\/app-fixture/)
})
test('artifact native target must match the build machine', async t => {
  const root = await fixture(t, { application: {} }), current = currentArtifactTarget()
  await assert.rejects(stageProductionClosure(root, join(root, 'output'), ['application'], { target: { ...current, arch: current.arch === 'arm64' ? 'x64' : 'arm64' } }), /cross-copying native modules is refused/)
})
test('required peers and conflicting dependency versions remain resolvable in their owning closures', async t => {
  const root = await fixture(t, {
    application: { dependencies: { a: '1.0.0', b: '1.0.0' }, peerDependencies: { peer: '^1.0.0' } },
    a: { dependencies: { shared: '1.0.0' } }, b: { dependencies: { shared: '2.0.0' } }, shared: {}, peer: {},
  })
  const nested = join(root, 'node_modules/b/node_modules/shared')
  await mkdir(nested, { recursive: true })
  await writeFile(join(nested, 'package.json'), JSON.stringify({ name: 'shared', version: '2.0.0', type: 'module', main: './index.js', files: ['index.js'] }))
  await writeFile(join(nested, 'index.js'), 'export const version = 2\n')
  await writeFile(join(root, 'node_modules/shared/index.js'), 'export const version = 1\n')
  for (const name of ['a', 'b']) await writeFile(join(root, 'node_modules', name, 'index.js'), "export { version } from 'shared'\n")
  const output = join(root, 'output'), result = await stageProductionClosure(root, output, ['application'])
  assert.ok(result.packages.some(pkg => pkg.name === 'peer'))
  assert.ok(result.packages.some(pkg => pkg.directory === 'node_modules/b/node_modules/shared' && pkg.version === '2.0.0'))
  assert.equal((await import(pathToFileURL(join(output, 'node_modules/a/index.js')).href)).version, 1)
  assert.equal((await import(pathToFileURL(join(output, 'node_modules/b/index.js')).href)).version, 2)
})
test('physically installed versions must meet declared production dependency ranges', async t => {
  const root = await fixture(t, { application: { dependencies: { dependency: '^2.0.0' } }, dependency: {} })
  await assert.rejects(stageProductionClosure(root, join(root, 'output'), ['application']), /dependency@1.0.0 does not satisfy \^2.0.0/)
})
test('a symlink cannot redirect an artifact output onto its source root', async t => {
  const root = await fixture(t, { '@anybox/host': {} }), alias = join(root, 'alias')
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(stageMinimalHost(root, alias), /separate artifact output directory/)
})
test('unsupported signing keys fail before creating or staging application files', async t => {
  const root = await fixture(t, {}), output = join(root, 'output')
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
  await assert.rejects(buildApplicationArchive(root, output, 'app-harness', { privateKey, keyId: 'test' }), /Ed25519 private signing key/)
  await assert.rejects(buildApplicationDirectory(root, output, 'app-harness', { privateKey, keyId: 'test' }), /Ed25519 private signing key/)
  await assert.rejects(lstat(output), { code: 'ENOENT' })
})

test('directory signing is optional but partial signing and unsigned ZIP distribution fail before staging', async t => {
  const root = await fixture(t, {}), output = join(root, 'output')
  await assert.rejects(buildApplicationDirectory(root, output, 'app-harness', { keyId: 'test' }), /both an Ed25519 signing key/)
  await assert.rejects(buildApplicationArchive(root, output, 'app-harness'), /required for archive distribution/)
  await assert.rejects(lstat(output), { code: 'ENOENT' })
})

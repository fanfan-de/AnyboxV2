import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cp, mkdir, mkdtemp, readFile, rm, chmod, unlink, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPackageWithOptions } from '@electron/asar'
import { rgPath } from '@vscode/ripgrep'
import forgeConfig from '../forge.config.mjs'
import { verifySearchDependencyLock, verifyDesktopSearchBinary } from '../scripts/verify-staged-application.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

test('release search dependency graph pins portable binaries for target-platform npm ci', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
  const verified = verifySearchDependencyLock(manifest, lock)
  assert.equal(verified.ripgrep, manifest.dependencies['@vscode/ripgrep'])
  assert.equal(verified.picomatch, manifest.dependencies.picomatch)
  assert.ok(verified.platformBinaries >= 4)
  const missing = structuredClone(lock)
  delete missing.packages['node_modules/@vscode/ripgrep-linux-x64']
  assert.throws(() => verifySearchDependencyLock(manifest, missing), /platform dependency/)
  const wrongArchitecture = structuredClone(lock)
  wrongArchitecture.packages['node_modules/@vscode/ripgrep-darwin-arm64'].version = '0.0.0'
  assert.throws(() => verifySearchDependencyLock(manifest, wrongArchitecture), /platform dependency/)
  const unpinned = structuredClone(manifest)
  unpinned.dependencies.picomatch = '^' + unpinned.dependencies.picomatch
  assert.throws(() => verifySearchDependencyLock(unpinned, lock), /pinned/)
})

test('desktop ASAR configuration ships an executable physical ripgrep and rejects damaged packages',
  { skip: process.platform !== 'darwin' || process.arch !== 'arm64', timeout: 20_000 }, async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'anybox-search-release-'))
    const source = join(temporary, 'stage'), app = join(temporary, 'Anybox.app')
    const resources = join(app, 'Contents/Resources')
    const wrapper = join(source, 'node_modules/@vscode/ripgrep')
    const binary = join(source, 'node_modules/@vscode/ripgrep-darwin-arm64/bin/rg')
    try {
      await mkdir(join(wrapper, 'lib'), { recursive: true }); await mkdir(dirname(binary), { recursive: true })
      await cp(join(root, 'node_modules/@vscode/ripgrep/package.json'), join(wrapper, 'package.json'))
      await cp(join(root, 'node_modules/@vscode/ripgrep/lib/index.js'), join(wrapper, 'lib/index.js'))
      await cp(rgPath, binary); await chmod(binary, 0o755)
      await mkdir(resources, { recursive: true })
      await createPackageWithOptions(source, join(resources, 'app.asar'), forgeConfig.packagerConfig.asar)
      assert.deepEqual(await verifyDesktopSearchBinary(app), { ripgrep: true })
      const unpacked = join(resources, 'app.asar.unpacked/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg')
      assert.deepEqual(await readFile(unpacked), await readFile(rgPath))
      await chmod(unpacked, 0o644)
      await assert.rejects(verifyDesktopSearchBinary(app), /executable arm64/)
      await chmod(unpacked, 0o755)
      const damaged = await readFile(unpacked)
      damaged.writeUInt32LE(0x01000007, 4)
      await writeFile(unpacked, damaged)
      await assert.rejects(verifyDesktopSearchBinary(app), /executable arm64/)
      await unlink(unpacked); await symlink(rgPath, unpacked)
      await assert.rejects(verifyDesktopSearchBinary(app), /regular unpacked/)
    } finally { await rm(temporary, { recursive: true, force: true }) }
  })

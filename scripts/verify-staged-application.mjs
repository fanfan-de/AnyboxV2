/** Verify the actual portable release against the shared Web resource catalog. */
import { readFile, readdir, stat, lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, relative, join, sep } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { verifyDefaultWebAssets } from './verify-web-assets.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const execute = promisify(execFile)

/** Releases preserve the platform binary packages so target-platform npm ci can select its own executable. */
export function verifySearchDependencyLock(manifest, lock) {
  for (const name of ['@vscode/ripgrep', 'picomatch']) {
    const version = manifest.dependencies?.[name], entry = lock.packages?.[`node_modules/${name}`]
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version) || entry?.version !== version || !entry.integrity) {
      throw new Error(`Search dependency must retain a pinned, integrity-checked release: ${name}`)
    }
  }
  const wrapper = lock.packages['node_modules/@vscode/ripgrep']
  const binaries = Object.entries(wrapper.optionalDependencies ?? {})
  if (!binaries.length || !binaries.some(([name]) => name === '@vscode/ripgrep-darwin-arm64') ||
    !binaries.some(([name]) => name === '@vscode/ripgrep-linux-x64')) throw new Error('Search release is missing target-platform optional dependencies')
  for (const [name, version] of binaries) {
    const entry = lock.packages[`node_modules/${name}`]
    if (version !== wrapper.version || entry?.version !== version || entry.optional !== true || !entry.integrity || !entry.os?.length || !entry.cpu?.length) {
      throw new Error(`Search platform dependency is missing or inconsistent: ${name}`)
    }
  }
  return { ripgrep: wrapper.version, picomatch: manifest.dependencies.picomatch, platformBinaries: binaries.length }
}
export async function verifyStagedApplication(root, output) {
  root = resolve(root); output = resolve(output)
  await verifyDefaultWebAssets(root, output)
  const base = pathToFileURL(root + sep)
  const [{ harnessClientApplication }, { shellAssets }, { createApplicationCatalog }] = await Promise.all([
    import(new URL('dist/applications/harness/registration.js', base)), import(new URL('dist/host/assets.js', base)),
    import(new URL('dist/host/applications/registration.js', base)),
  ])
  const catalog = createApplicationCatalog([harnessClientApplication()], shellAssets)
  for (const [url, asset] of catalog.assets) {
    const path = relative(root, asset.file)
    if (path.startsWith('..' + sep) || path === '..') throw new Error(`Shared Web asset is outside the application: ${url}`)
    const [source, copied] = await Promise.all([readFile(asset.file), readFile(join(output, path))])
    if (hash(source) !== hash(copied)) throw new Error(`Shared Web asset changed during release: ${url}`)
  }
  const source = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const manifest = JSON.parse(await readFile(join(output, 'package.json'), 'utf8'))
  const release = JSON.parse(await readFile(join(output, 'release.json'), 'utf8'))
  const lockBytes = await readFile(join(output, 'package-lock.json'))
  if (hash(lockBytes) !== release.lockSha256) throw new Error('Release lock integrity mismatch')
  const search = verifySearchDependencyLock(manifest, JSON.parse(lockBytes.toString('utf8')))
  for (const [name, spec] of Object.entries(source.dependencies)) {
    const copied = manifest.dependencies[name]
    if (!spec.startsWith('file:')) {
      if (copied !== spec) throw new Error(`Dependency changed during release: ${name}`)
      continue
    }
    if (typeof copied !== 'string' || !/^file:vendor\/[^/]+\.tgz$/.test(copied)) throw new Error(`Non-portable local dependency: ${name}`)
    const path = join(output, copied.slice(5))
    if (!(await stat(path)).isFile()) throw new Error(`Missing vendored dependency: ${name}`)
    const integrity = 'sha512-' + createHash('sha512').update(await readFile(path)).digest('base64')
    if (integrity !== release.artifacts[name]?.integrity) throw new Error(`Vendored dependency integrity mismatch: ${name}`)
  }
  return { assets: catalog.assets.size, vendoredPackages: Object.keys(release.artifacts).length, search }
}

export async function verifyDesktopSearchBinary(appPath) {
  const modules = join(appPath, 'Contents/Resources/app.asar.unpacked/node_modules')
  const binaryPath = join(modules, '@vscode/ripgrep-darwin-arm64/bin/rg')
  for (const path of [join(modules, '@vscode/ripgrep/package.json'), join(modules, '@vscode/ripgrep/lib/index.js'), binaryPath]) {
    if (!(await lstat(path)).isFile()) throw new Error('Desktop search requires regular unpacked package entries and binary')
  }
  const info = await lstat(binaryPath), binary = await readFile(binaryPath)
  if (!(info.mode & 0o111) || binary.length < 32 || binary.readUInt32LE(0) !== 0xfeedfacf || binary.readUInt32LE(4) !== 0x0100000c) {
    throw new Error('Desktop search requires an executable arm64 Mach-O ripgrep binary')
  }
  const { stdout } = await execute(binaryPath, ['--version'], { timeout: 10_000, maxBuffer: 65_536 })
  if (!/^ripgrep \d+\./.test(stdout)) throw new Error('Desktop search binary did not report its ripgrep version')
  return { ripgrep: true }
}

export async function verifyDesktopNativeFiles(appPath) {
  const modules = join(appPath, 'Contents/Resources/app.asar.unpacked/node_modules')
  const files = async directory => {
    const result = []
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`Native dependency has an unexpected symlink: ${entry.name}`)
      const path = join(directory, entry.name)
      if (entry.isDirectory()) result.push(...await files(path))
      else if (entry.isFile()) result.push(path)
    }
    return result
  }
  const [keyring, sharp, vips] = await Promise.all([
    files(join(modules, '@napi-rs/keyring-darwin-arm64')), files(join(modules, '@img/sharp-darwin-arm64')),
    files(join(modules, '@img/sharp-libvips-darwin-arm64')),
  ])
  if (!keyring.some(path => path.endsWith('.node')) || !sharp.some(path => path.endsWith('.node')) || !vips.some(path => path.endsWith('.dylib'))) {
    throw new Error('Desktop package is missing unpacked native binaries')
  }
  await Promise.all([stat(join(modules, '@napi-rs/keyring/index.js')), stat(join(modules, 'sharp/package.json'))])
  const dialog = join(appPath, 'Contents/Resources/app.asar.unpacked/dist/desktop/native/mac-dialog.node')
  if (!(await lstat(dialog)).isFile()) throw new Error('Desktop native dialog adapter is not a regular file')
  const binary = await readFile(dialog)
  if (binary.length < 32 || binary.readUInt32LE(0) !== 0xfeedfacf || binary.readUInt32LE(4) !== 0x0100000c) {
    throw new Error('Desktop native dialog adapter must be an arm64 Mach-O binary')
  }
  await verifyDesktopSearchBinary(appPath)
  return { keyring: true, sharp: true, libvips: true, macDialog: true, ripgrep: true }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Pass a portable release directory')
  process.stdout.write(JSON.stringify(await verifyStagedApplication(fileURLToPath(new URL('..', import.meta.url)), process.argv[2])) + '\n')
}

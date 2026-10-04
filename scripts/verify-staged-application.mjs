/** Verify the actual portable release against the shared Web resource catalog. */
import { readFile, readdir, stat, lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, relative, join, sep } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { verifyDefaultWebAssets } from './verify-web-assets.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
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
  if (hash(await readFile(join(output, 'package-lock.json'))) !== release.lockSha256) throw new Error('Release lock integrity mismatch')
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
  return { assets: catalog.assets.size, vendoredPackages: Object.keys(release.artifacts).length }
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
  return { keyring: true, sharp: true, libvips: true, macDialog: true }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Pass a portable release directory')
  process.stdout.write(JSON.stringify(await verifyStagedApplication(fileURLToPath(new URL('..', import.meta.url)), process.argv[2])) + '\n')
}

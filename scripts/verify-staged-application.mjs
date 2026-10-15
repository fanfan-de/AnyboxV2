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
    !binaries.some(([name]) => name === '@vscode/ripgrep-linux-x64') ||
    !binaries.some(([name]) => name === '@vscode/ripgrep-win32-x64')) throw new Error('Search release is missing target-platform optional dependencies')
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
    import(new URL('dist/applications/harness/client/registration.js', base)), import(new URL('dist/host/assets.js', base)),
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

const resourcesPath = (app, platform) => join(app, platform === 'darwin' ? 'Contents/Resources' : 'resources')
export function binaryMatchesTarget(binary, platform, architecture) {
  if (binary.length < 64) return false
  if (platform === 'darwin') return binary.readUInt32LE(0) === 0xfeedfacf && binary.readUInt32LE(4) === (architecture === 'arm64' ? 0x0100000c : 0x01000007)
  if (platform === 'linux') return binary.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && binary[4] === 2 && binary[5] === 1 && binary.readUInt16LE(18) === (architecture === 'arm64' ? 183 : 62)
  if (platform === 'win32') {
    if (binary.readUInt16LE(0) !== 0x5a4d) return false
    const offset = binary.readUInt32LE(0x3c)
    return offset + 6 <= binary.length && binary.readUInt32LE(offset) === 0x4550 && binary.readUInt16LE(offset + 4) === (architecture === 'arm64' ? 0xaa64 : 0x8664)
  }
  return false
}
async function verifyExecutable(path, platform, architecture, description) {
  const info = await lstat(path), binary = await readFile(path)
  if (!info.isFile()) throw new Error(`${description} must be a regular unpacked file`)
  if ((platform !== 'win32' && !(info.mode & 0o111)) || !binaryMatchesTarget(binary, platform, architecture)) throw new Error(`${description} must be an executable ${architecture} ${platform === 'darwin' ? 'Mach-O' : platform === 'win32' ? 'PE' : 'ELF'} binary`)
}
/** Inspect actual PE imports instead of relying on the build machine's VC redistributable. */
export function windowsImportedLibraries(binary) {
  if (!binaryMatchesTarget(binary, 'win32', 'x64') && !binaryMatchesTarget(binary, 'win32', 'arm64')) throw new Error('Expected a Windows PE binary')
  const pe = binary.readUInt32LE(0x3c), optional = pe + 24, optionalSize = binary.readUInt16LE(pe + 20)
  const directories = optional + (binary.readUInt16LE(optional) === 0x20b ? 112 : 96), sections = []
  for (let i = 0; i < binary.readUInt16LE(pe + 6); i++) {
    const section = optional + optionalSize + i * 40
    sections.push({ rva: binary.readUInt32LE(section + 12), size: Math.max(binary.readUInt32LE(section + 8), binary.readUInt32LE(section + 16)), file: binary.readUInt32LE(section + 20) })
  }
  const offset = rva => {
    const section = sections.find(section => rva >= section.rva && rva < section.rva + section.size)
    if (!section) throw new Error('Invalid PE import address')
    return section.file + rva - section.rva
  }
  const name = rva => {
    const start = offset(rva), end = binary.indexOf(0, start)
    if (end < start) throw new Error('Invalid PE import name')
    return binary.toString('ascii', start, end)
  }
  const libraries = []
  const imports = binary.readUInt32LE(directories + 8)
  if (imports) for (let entry = offset(imports); binary.readUInt32LE(entry + 12); entry += 20) libraries.push(name(binary.readUInt32LE(entry + 12)))
  const delayed = binary.readUInt32LE(directories + 13 * 8)
  if (delayed) for (let entry = offset(delayed); binary.readUInt32LE(entry + 4); entry += 32) {
    if (!(binary.readUInt32LE(entry) & 1)) throw new Error('Unsupported absolute-address PE delay import')
    libraries.push(name(binary.readUInt32LE(entry + 4)))
  }
  return [...new Set(libraries)]
}
export async function verifyWindowsHelperRuntime(path) {
  const imports = windowsImportedLibraries(await readFile(path))
  if (imports.some(name => /^(?:vcruntime|msvcp|msvcr|concrt)\d.*\.dll$/i.test(name))) {
    throw new Error('Windows native helpers must statically link the VC runtime: ' + path)
  }
  return imports
}
async function verifyWindowsKeyringRuntime(directory, architecture) {
  const addon = join(directory, `keyring.win32-${architecture}-msvc.node`)
  await verifyExecutable(addon, 'win32', architecture, 'Windows Keyring addon')
  const required = windowsImportedLibraries(await readFile(addon)).filter(name => /^(?:vcruntime|msvcp|msvcr|concrt)\d.*\.dll$/i.test(name))
  if (!required.length) return
  const metadata = JSON.parse(await readFile(join(directory, 'windows-runtime.json'), 'utf8'))
  if (metadata.formatVersion !== 1 || metadata.architecture !== architecture) throw new Error('Windows Keyring runtime metadata is invalid')
  if (hash(await readFile(join(directory, metadata.license.file))) !== metadata.license.sha256) throw new Error('VC runtime license integrity mismatch')
  for (const name of required) {
    const library = metadata.libraries.find(library => library.name.toLowerCase() === name.toLowerCase())
    if (!library) throw new Error('Windows Keyring has an unbundled VC runtime dependency: ' + name)
    const path = join(directory, library.name), binary = await readFile(path)
    await verifyExecutable(path, 'win32', architecture, 'App-local VC runtime')
    if (hash(binary) !== library.sha256) throw new Error('App-local VC runtime integrity mismatch')
    if (windowsImportedLibraries(binary).some(dependency => /^(?:vcruntime|msvcp|msvcr|concrt)\d.*\.dll$/i.test(dependency))) throw new Error('VC runtime dependency closure is incomplete')
  }
}
export async function verifyDesktopSearchBinary(appPath, { platform = process.platform, architecture = process.arch } = {}) {
  const modules = join(resourcesPath(appPath, platform), 'app.asar.unpacked/node_modules')
  const binaryPath = join(modules, `@vscode/ripgrep-${platform}-${architecture}/bin/${platform === 'win32' ? 'rg.exe' : 'rg'}`)
  for (const path of [join(modules, '@vscode/ripgrep/package.json'), join(modules, '@vscode/ripgrep/lib/index.js'), binaryPath]) {
    if (!(await lstat(path)).isFile()) throw new Error('Desktop search requires regular unpacked package entries and binary')
  }
  await verifyExecutable(binaryPath, platform, architecture, 'Desktop search ripgrep')
  const { stdout } = await execute(binaryPath, ['--version'], { timeout: 10_000, maxBuffer: 65_536 })
  if (!/^ripgrep \d+\./.test(stdout)) throw new Error('Desktop search binary did not report its ripgrep version')
  return { ripgrep: true }
}

export async function verifyDesktopNativeFiles(appPath, { platform = process.platform, architecture = process.arch } = {}) {
  const resources = resourcesPath(appPath, platform), runtime = join(resources, 'runtime')
  const executable = join(runtime, platform === 'win32' ? 'node.exe' : 'node')
  await verifyExecutable(executable, platform, architecture, 'Independent Node runtime')
  const manifest = JSON.parse(await readFile(join(runtime, 'runtime.json'), 'utf8'))
  if (manifest.platform !== platform || manifest.architecture !== architecture || hash(await readFile(executable)) !== manifest.artifacts.node.sha256) throw new Error('Bundled runtime integrity mismatch')
  const application = join(runtime, 'app')
  // Import the actual deployed native wrappers with the deployed Node. This
  // checks DLL/shared-library closure without touching the user's Vault.
  const probe = "const s=require('sharp');require('@napi-rs/keyring');require('@vscode/ripgrep');if(!s.versions.vips)process.exit(1);console.log('native-packages-ok')"
  const { stdout } = await execute(executable, ['-e', probe], { cwd: application, windowsHide: true, timeout: 30_000 })
  if (!stdout.includes('native-packages-ok')) throw new Error('Bundled native packages did not initialize')
  await execute(executable, [join(application, 'dist/entrypoints/anybox-main.js'), '--help'], { cwd: application, windowsHide: true, timeout: 30_000 })
  const helper = join(application, `dist/platform/native/anybox-process-host${platform === 'win32' ? '.exe' : ''}`)
  await verifyExecutable(helper, platform, architecture, 'Process supervisor')
  if (platform === 'win32') {
    const service = join(application, 'dist/platform/native/anybox-service-host.exe')
    const dialog = join(resources, 'app.asar.unpacked/dist/desktop/native/anybox-dialog-host.exe')
    await verifyExecutable(dialog, platform, architecture, 'Desktop native dialog host')
    const dialogVersion = await execute(dialog, ['--version'], { windowsHide: true, timeout: 10_000 })
    if (dialogVersion.stdout.trim() !== 'anybox-dialog-host 1') throw new Error('Desktop native dialog host protocol mismatch')
    await verifyExecutable(service, platform, architecture, 'SCM service host')
    await Promise.all([helper, service, dialog].map(verifyWindowsHelperRuntime))
    await Promise.all([
      join(resources, `app.asar.unpacked/node_modules/@napi-rs/keyring-win32-${architecture}-msvc`),
      join(application, `node_modules/@napi-rs/keyring-win32-${architecture}-msvc`),
    ].map(directory => verifyWindowsKeyringRuntime(directory, architecture)))
    await execute(service, ['--version'], { windowsHide: true, timeout: 10_000 })
    await execute(join(runtime, 'powershell/pwsh.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { windowsHide: true, timeout: 30_000 })
    await execute(join(runtime, 'bash/bin/bash.exe'), ['--version'], { windowsHide: true, timeout: 30_000 })
  }
  if (platform === 'darwin') await verifyExecutable(join(resources, 'app.asar.unpacked/dist/desktop/native/mac-dialog.node'), platform, architecture, 'Desktop native dialog adapter')
  await verifyDesktopSearchBinary(appPath, { platform, architecture })
  return { keyring: true, sharp: true, libvips: true, macDialog: platform === 'darwin', windowsDialog: platform === 'win32', ripgrep: true, runtime: true, processHost: true, serviceHost: platform === 'win32' }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('Pass a portable release directory')
  process.stdout.write(JSON.stringify(await verifyStagedApplication(fileURLToPath(new URL('..', import.meta.url)), process.argv[2])) + '\n')
}

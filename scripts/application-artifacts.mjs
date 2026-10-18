/** D1.2 production artifacts. Build-time tooling only; consumers never run npm. */
import { spawn } from 'node:child_process'
import { createHash, createPublicKey, createPrivateKey, KeyObject } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile, readdir, lstat, realpath, cp } from 'node:fs/promises'
import { dirname, join, resolve, relative, sep } from 'node:path'

const sharedPackages = Object.freeze(['@nya/core', '@anybox/application-api', '@anybox/storage-sqlite'])
// The builder consumes the same explicitly declared dependency as the host contract validator.
const { satisfies } = createRequire(new URL('../packages/host/package.json', import.meta.url))('semver')
const localPackages = new Set(['@anybox/host', '@anybox/application-api', '@anybox/storage-sqlite', '@anybox/directory-picker', '@anybox/models', '@anybox/api-key-manager', '@anybox/app-harness', '@anybox/app-claude-agent', '@nya/core'])
const excludedClaudeBinary = name => name.startsWith('@anthropic-ai/claude-agent-sdk-')
const safeRelative = value => typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.startsWith('/') && !value.split('/').some(part => !part || part === '.' || part === '..')
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const command = (executable, args, cwd) => new Promise((resolveCommand, reject) => {
  const child = spawn(executable, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' && executable === 'npm' })
  let stdout = '', stderr = ''
  child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
  child.once('error', reject)
  child.once('exit', code => code === 0 ? resolveCommand(stdout) : reject(new Error(`${executable} exited ${code}: ${stderr.slice(-2000)}`)))
})
function targetMatches(metadata, target) {
  const accepted = (values, value) => !Array.isArray(values) || (!values.includes(`!${value}`) && (!values.some(item => !item.startsWith('!')) || values.includes(value)))
  return accepted(metadata.os, target.os) && accepted(metadata.cpu, target.arch) && accepted(metadata.libc, target.libc)
}
export function currentArtifactTarget() {
  if (!['darwin', 'linux', 'win32'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) throw new Error('D1.2 artifacts currently require a native x64 or arm64 build machine')
  return Object.freeze({ os: process.platform, arch: process.arch, ...(process.platform === 'linux' ? { libc: process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl' } : {}) })
}
function checkNativeTarget(target) {
  const current = currentArtifactTarget()
  if (target.os !== current.os || target.arch !== current.arch || target.libc !== current.libc) throw new Error('Build each artifact on its target platform with that target’s prebuilt dependencies; cross-copying native modules is refused')
}
async function emptyDirectory(directory, root) {
  directory = resolve(directory); root = resolve(root)
  if (directory === root || root.startsWith(directory + sep)) throw new Error('Choose a separate artifact output directory')
  await mkdir(directory, { recursive: true })
  const [physicalOutput, physicalRoot] = await Promise.all([realpath(directory), realpath(root)])
  if (physicalOutput === physicalRoot || physicalRoot.startsWith(physicalOutput + sep)) throw new Error('Choose a separate artifact output directory')
  if ((await readdir(directory)).length) throw new Error('Artifact output directory must be empty')
  return directory
}
async function locatePackage(name, from) {
  for (let cursor = resolve(from); ; cursor = dirname(cursor)) {
    const candidate = join(cursor, 'node_modules', name)
    try {
      const source = await realpath(candidate)
      const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
      if (manifest.name !== name) throw new Error(`Dependency ${name} resolved to a different package`)
      return { source, manifest }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (dirname(cursor) === cursor) break
  }
  return undefined
}
async function publishedFiles(source) {
  const result = JSON.parse(await command('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], source))
  if (!Array.isArray(result) || result.length !== 1 || !Array.isArray(result[0].files)) throw new Error('npm pack did not report one package file list')
  return result[0].files.map(file => file.path)
}
/** Copy the physically installed production graph, retaining real version conflicts as nested dependencies. */
export async function stageProductionClosure(root, output, entryPackages, { target = currentArtifactTarget() } = {}) {
  root = resolve(root); output = resolve(output); checkNativeTarget(target)
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
  const installed = new Map(), rootNames = new Map(), packages = [], licenses = []
  const metadataFor = name => lock.packages?.[`node_modules/${name}`]
  await mkdir(join(output, 'node_modules'), { recursive: true })
  const add = async (name, from, callerDestination = output, { optional = false, range } = {}) => {
    if (name === 'electron' || name.startsWith('@types/') || excludedClaudeBinary(name)) return undefined
    const found = await locatePackage(name, from)
    if (!found) {
      if (optional && metadataFor(name) && !targetMatches(metadataFor(name), target)) return undefined
      throw new Error(`Missing prebuilt production dependency ${name}; install/build dependencies before creating artifacts`)
    }
    const { source, manifest } = found
    if (range !== undefined && !satisfies(manifest.version, range)) throw new Error(`Installed production dependency ${name}@${manifest.version} does not satisfy ${range}`)
    if (!targetMatches(manifest, target)) {
      if (optional) return undefined
      throw new Error(`Required dependency ${name} does not support ${target.os}/${target.arch}`)
    }
    let destination = join(output, 'node_modules', name)
    const rootPlacement = rootNames.get(name)
    if (rootPlacement && rootPlacement !== source) destination = join(callerDestination, 'node_modules', name)
    else rootNames.set(name, source)
    const already = installed.get(destination)
    if (already) {
      if (already !== source) throw new Error(`Conflicting production dependency placement: ${name}`)
      return { source, destination, manifest }
    }
    installed.set(destination, source)
    await mkdir(destination, { recursive: true })
    const files = await publishedFiles(source)
    for (const file of files) {
      if (!safeRelative(file)) throw new Error(`Unsafe package file path in ${name}`)
      if (file === 'package.json') continue
      if (/\.(?:ts|mts|cts)$/.test(file) && !/\.d\.(?:ts|mts|cts)$/.test(file)) {
        if (localPackages.has(name)) throw new Error(`Unbuilt TypeScript is not a production file: ${name}/${file}`)
        // Upstream source conditions are not part of the normal JavaScript runtime profile.
        continue
      }
      if (file.split('/').includes('node_modules')) throw new Error(`Nested dependencies must be traversed explicitly: ${name}/${file}`)
      const info = await lstat(join(source, file))
      if (!info.isFile() || info.nlink !== 1) throw new Error(`Only ordinary package files are distributable: ${name}/${file}`)
      const copied = join(destination, file)
      await mkdir(dirname(copied), { recursive: true }); await cp(join(source, file), copied)
      const referencedLicense = typeof manifest.license === 'string' ? /^SEE LICEN[CS]E IN (.+)$/i.exec(manifest.license)?.[1] : undefined
      if (/^(?:licen[sc]e|copying|notice)(?:\.|$)/i.test(file) || file === referencedLicense) licenses.push({ name, version: manifest.version, file, source: copied })
    }
    const selectedDependencies = {}, selectedOptional = {}, selectedPeers = {}
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
      if (Object.hasOwn(manifest.optionalDependencies ?? {}, dependency)) continue
      const selected = await add(dependency, source, destination, { range: manifest.dependencies[dependency] })
      if (selected) selectedDependencies[dependency] = selected.manifest.version
    }
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {}).sort()) {
      const selected = await add(dependency, source, destination, { optional: true, range: manifest.optionalDependencies[dependency] })
      if (selected) selectedOptional[dependency] = selected.manifest.version
    }
    for (const dependency of Object.keys(manifest.peerDependencies ?? {}).sort()) {
      if (manifest.peerDependenciesMeta?.[dependency]?.optional) continue
      const selected = await add(dependency, source, destination, { range: manifest.peerDependencies[dependency] })
      if (selected) selectedPeers[dependency] = manifest.peerDependencies[dependency]
    }
    const { devDependencies: _development, scripts: _scripts, dependencies: _dependencies, optionalDependencies: _optional,
      peerDependencies: _peers, ...production } = manifest
    await writeFile(join(destination, 'package.json'), jsonBytes({ ...production,
      ...(Object.keys(selectedDependencies).length ? { dependencies: selectedDependencies } : {}),
      ...(Object.keys(selectedOptional).length ? { optionalDependencies: selectedOptional } : {}),
      ...(Object.keys(selectedPeers).length ? { peerDependencies: selectedPeers } : {}) }))
    const lockMetadata = lock.packages?.[relative(root, source).split(sep).join('/')]
    packages.push({ name, version: manifest.version, directory: relative(output, destination).split(sep).join('/'),
      license: manifest.license ?? null, ...(lockMetadata?.version === manifest.version && lockMetadata.integrity ? { lockfileIntegrityMetadata: lockMetadata.integrity } : {}),
      ...(localPackages.has(name) ? { source: 'workspace-built-product' } : { source: 'installed-production-package' }) })
    return { source, destination, manifest }
  }
  for (const name of entryPackages) await add(name, root)
  packages.sort((a, b) => a.directory < b.directory ? -1 : 1)
  await mkdir(join(output, 'licenses'), { recursive: true })
  for (const entry of licenses) {
    const licensePath = join(output, 'licenses', `${entry.name.replaceAll('/', '+')}@${entry.version}`, entry.file)
    await mkdir(dirname(licensePath), { recursive: true }); await cp(entry.source, licensePath)
  }
  await writeFile(join(output, 'licenses', 'package-attributions.json'), jsonBytes({ schemaVersion: 1, packages: packages.map(({ name, version, license }) => ({ name, version, license })) }))
  await writeFile(join(output, 'licenses', 'NOTICE.txt'), 'Package license texts and metadata are copied from their installed production sources.\nAnybox workspace package metadata currently does not declare an SPDX license. This notice grants no additional redistribution rights.\nClaude Agent uses the user-provided Claude executable; unused SDK platform executable packages are intentionally excluded.\n')
  return { packages, target }
}
export async function stageMinimalHost(root, directory, { target = currentArtifactTarget() } = {}) {
  root = resolve(root); const output = await emptyDirectory(directory, root)
  const closure = await stageProductionClosure(root, output, ['@anybox/host'], { target })
  const forbidden = closure.packages.filter(pkg => !['@anybox/host', '@anybox/application-api', '@anybox/storage-sqlite', '@nya/core', '@standard-schema/spec', 'semver', 'acorn'].includes(pkg.name))
  if (forbidden.length) throw new Error(`Host-only production closure unexpectedly includes: ${forbidden.map(pkg => pkg.name).join(', ')}`)
  await writeFile(join(output, 'anybox.mjs'), "import { main } from '@anybox/host/main'\nawait main()\n")
  const desktopEntry = 'node_modules/@anybox/host/dist/desktop/main.js'
  const desktopAvailable = await lstat(join(output, desktopEntry)).then(info => info.isFile(), error => { if (error.code === 'ENOENT') return false; throw error })
  if (desktopAvailable) await writeFile(join(output, 'desktop.mjs'), "import '@anybox/host/desktop/main'\n")
  await writeFile(join(output, 'package.json'), jsonBytes({ name: 'anybox-host-portable', private: true, type: 'module',
    version: JSON.parse(await readFile(join(root, 'packages/host/package.json'), 'utf8')).version,
    ...(desktopAvailable ? { main: 'desktop.mjs' } : {}), engines: { node: '>=22.15.0' }, scripts: { start: 'node anybox.mjs', ...(desktopAvailable ? { desktop: 'electron .' } : {}) } }))
  await writeFile(join(output, 'runtime-closure.json'), jsonBytes({ schemaVersion: 1, kind: 'host-only', target,
    runtime: 'Externally provisioned Node.js >=22.15.0 with node:sqlite, or the declared Electron runtime for desktop.mjs; no npm installation is required. Standard JavaScript import/require conditions only; TypeScript source conditions are excluded.',
    sharedRuntime: { id: 'nya-runtime-1', strategy: 'host-canonical-public-exports', packages: sharedPackages }, packages: closure.packages }))
  return { output, ...closure }
}
async function walkFiles(directory, prefix = '') {
  const files = []
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name, absolute = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walkFiles(absolute, path))
    else {
      const info = await lstat(absolute)
      if (!info.isFile() || info.nlink !== 1) throw new Error(`Archive staging contains a non-regular file: ${path}`)
      files.push({ path, bytes: await readFile(absolute), mode: info.mode & 0o111 ? 0o755 : 0o644 })
    }
  }
  return files
}
export async function stageApplicationPackage(root, directory, appName, { target = currentArtifactTarget() } = {}) {
  root = resolve(root); const output = await emptyDirectory(directory, root)
  if (!['app-harness', 'app-claude-agent'].includes(appName)) throw new Error('Choose app-harness or app-claude-agent')
  if (target.os === 'darwin' && target.arch === 'arm64') {
    const native = join(root, 'packages/directory-picker/dist/native/mac-dialog.node')
    const ready = await lstat(native).then(info => info.isFile(), error => { if (error.code === 'ENOENT') return false; throw error })
    if (!ready) throw new Error('Complete macOS arm64 application artifacts require the prebuilt directory adapter; run node scripts/build-desktop-native.mjs after the JavaScript build')
  }
  const source = join(root, 'packages', appName), recipe = JSON.parse(await readFile(join(source, 'anybox.app.json'), 'utf8'))
  const packageMetadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  if (recipe.version !== packageMetadata.version) throw new Error('Application manifest version differs from its package product')
  const payload = join(output, 'payload'); await mkdir(payload)
  const closure = await stageProductionClosure(root, payload, [packageMetadata.name], { target })
  // Attribution paths are archive-level fixed metadata, not executable resources.
  await cp(join(payload, 'licenses'), join(output, 'licenses'), { recursive: true })
  const packagePrefix = `payload/node_modules/${packageMetadata.name}`
  const assetsModule = appName === 'app-harness' ? '@anybox/app-harness/assets' : '@anybox/app-claude-agent/client/assets'
  const assetExport = appName === 'app-harness' ? 'harnessAssets' : 'claudeAgentAssets'
  const assets = (await import(assetsModule))[assetExport].map(asset => {
    const file = relative(source, asset.file).split(sep).join('/')
    if (!safeRelative(file)) throw new Error('Application asset is outside its own built product')
    return { path: asset.path, file: `${packagePrefix}/${file}`, type: asset.type }
  })
  await writeFile(join(payload, 'assets.json'), jsonBytes({ schemaVersion: 1, assets }))
  await writeFile(join(payload, 'data-compatibility.json'), jsonBytes({ schemaVersion: 1, appId: recipe.appId,
    owner: 'application', uninstall: 'preserve', preparation: 'No business resources, migrations, credentials or network are opened during package preparation.',
    existingData: 'Existing application-owned paths, identities and migration ledgers remain unchanged.' }))
  await writeFile(join(payload, 'runtime-closure.json'), jsonBytes({ schemaVersion: 1, kind: 'application', target,
    sharedRuntime: { id: 'nya-runtime-1', strategy: 'host-canonical-public-exports', packages: sharedPackages,
      hosted: 'Trusted host resolve hook maps these exact bare names and public subpaths to the host canonical packages before imports.',
      standalone: 'Separate application processes resolve the complete private physical dependency closure in payload/node_modules.' },
    conditions: 'Standard JavaScript import/require conditions only; upstream TypeScript source conditions are excluded.',
    externalUserEnvironment: appName === 'app-claude-agent' ? ['User-installed Claude executable and its authentication/settings'] : [], packages: closure.packages }))
  if (recipe.entries?.computerWorker && recipe.lifecycleVersion !== 1) throw new Error('An independent worker package must declare lifecycleVersion 1')
  const manifest = { ...recipe, target: { os: target.os, arch: target.arch },
    entries: Object.fromEntries(Object.entries(recipe.entries).map(([role, file]) => [role, `${packagePrefix}/${file}`])),
    web: { entry: `${packagePrefix}/${recipe.web.entry}`, styles: recipe.web.styles.map(file => `${packagePrefix}/${file}`), assets: 'payload/assets.json' }, dataCompatibility: 'payload/data-compatibility.json',
    runtimeRequirements: Object.fromEntries(Object.entries(recipe.runtimeRequirements).map(([role, requirements]) => [role, { ...requirements, ...(target.libc ? { libc: target.libc } : {}) }])) }
  await writeFile(join(output, 'manifest.json'), jsonBytes(manifest))
  return { output, manifest, ...closure }
}
export async function buildApplicationDirectory(root, directory, appName, { privateKey, keyId, target = currentArtifactTarget() } = {}) {
  if ((privateKey || keyId !== undefined) && (!privateKey || typeof keyId !== 'string' || !keyId.trim())) throw new Error('Provide both an Ed25519 signing key and trusted key ID, or neither for a local application directory')
  const key = privateKey ? privateKey instanceof KeyObject ? privateKey : createPrivateKey(privateKey) : undefined
  if (key && (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519')) throw new Error('Application packages require an Ed25519 private signing key')
  const staged = await stageApplicationPackage(root, directory, appName, { target })
  const { createApplicationDirectory } = await import('@anybox/host/package-management/archive')
  const { readApplicationDirectory } = await import('@anybox/host/package-management/directory')
  const stagedFiles = await walkFiles(staged.output)
  const files = stagedFiles.filter(file => file.path !== 'manifest.json')
  // Production closures can contain executables. Unlike minimal Agent folders,
  // they carry an explicit index even without a publisher signature.
  const entries = key ? createApplicationDirectory({ manifest: staged.manifest, files, keyId, privateKey: key }) : [
    ...stagedFiles,
    { path: 'files.json', bytes: jsonBytes({ schemaVersion: 1, files: files.map(file => ({ path: file.path, size: file.bytes.length, sha256: sha256(file.bytes), mode: file.mode })) }), mode: 0o644 },
  ]
  for (const entry of entries) await writeFile(join(staged.output, entry.path), entry.bytes, { mode: entry.mode ?? 0o644 })
  const bytes = await readApplicationDirectory(staged.output)
  return { ...staged, entries, bytes, sha256: sha256(bytes), ...(key ? { publicKey: createPublicKey(key).export({ type: 'spki', format: 'pem' }) } : {}) }
}
/** ZIP is an optional distribution encoding of the same signed application directory. */
export async function buildApplicationArchive(root, directory, appName, options = {}) {
  if (!options.privateKey || typeof options.keyId !== 'string' || !options.keyId.trim()) throw new Error('An explicit Ed25519 signing key and trusted key ID are required for archive distribution')
  const staged = await buildApplicationDirectory(root, directory, appName, options)
  const { createApplicationArchiveZip } = await import('@anybox/host/package-management/archive')
  const bytes = createApplicationArchiveZip(staged.entries)
  return { ...staged, bytes, sha256: sha256(bytes) }
}

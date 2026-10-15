/** Build-time only: bundle a separate runtime; installed products never download it. */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, chmod, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { run } from './stage-application.mjs'
import { binaryMatchesTarget, windowsImportedLibraries } from './verify-staged-application.mjs'

const hash = async path => {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}
async function download(entry, cache) {
  const destination = join(cache, `${entry.sha256}-${basename(new URL(entry.url).pathname)}`)
  try { if (await hash(destination) === entry.sha256) return destination } catch {}
  await mkdir(cache, { recursive: true })
  const temporary = destination + '.download'
  const response = await fetch(entry.url, { signal: AbortSignal.timeout(300_000) })
  if (!response.ok || !response.body) throw new Error(`Runtime download failed: ${response.status} ${entry.url}`)
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary))
    if (await hash(temporary) !== entry.sha256) throw new Error(`Runtime artifact integrity mismatch: ${entry.url}`)
    await rename(temporary, destination)
  } finally { await rm(temporary, { force: true }) }
  return destination
}

/** App-local official redistributables for the pinned prebuilt Keyring addon. */
async function stageWindowsCRuntime(stage, cache, license) {
  const directory = join(stage, 'node_modules', `@napi-rs/keyring-win32-${process.arch}-msvc`)
  const addon = join(directory, `keyring.win32-${process.arch}-msvc.node`)
  const imports = windowsImportedLibraries(await readFile(addon))
  const required = imports.filter(name => /^(?:vcruntime|msvcp|msvcr|concrt)\d.*\.dll$/i.test(name))
  if (!required.length) return { libraries: [] }
  const vswhere = join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe')
  const found = await run(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-find', `VC/Redist/MSVC/**/${process.arch}/Microsoft.VC*.CRT/vcruntime140.dll`], stage)
  const candidates = found.trim().split(/\r?\n/).filter(path => path && !/[\\/]onecore[\\/]/i.test(path))
  const selected = candidates.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1)
  if (!selected) throw new Error(`Visual Studio's official ${process.arch} VC Redist is required for the Keyring native addon`)
  const powershell = join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const libraries = []
  for (const name of required) {
    const source = join(dirname(selected), name), binary = await readFile(source)
    if (!binaryMatchesTarget(binary, 'win32', process.arch)) throw new Error('VC redistributable architecture mismatch')
    if (windowsImportedLibraries(binary).some(dependency => /^(?:vcruntime|msvcp|msvcr|concrt)\d.*\.dll$/i.test(dependency))) {
      throw new Error('VC redistributable gained a dependency; explicitly include its official closure before publishing')
    }
    const literal = source.replaceAll("'", "''")
    const identity = JSON.parse(await run(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $p='${literal}'; $s=Get-AuthenticodeSignature -LiteralPath $p; @{status=$s.Status.ToString();signer=$s.SignerCertificate.Subject;version=(Get-Item -LiteralPath $p).VersionInfo.FileVersion} | ConvertTo-Json -Compress`], stage,
      { env: { ...process.env, PSModulePath: join(dirname(powershell), 'Modules') } }))
    if (identity.status !== 'Valid' || !identity.signer?.includes('O=Microsoft Corporation')) throw new Error('VC runtime must retain a valid Microsoft signature')
    await cp(source, join(directory, name.toLowerCase()))
    libraries.push({ name: name.toLowerCase(), version: identity.version, sha256: await hash(source),
      source: 'Visual Studio ' + source.slice(source.indexOf('VC\\Redist\\')).replaceAll('\\', '/'), signer: identity.signer })
  }
  const licenseFile = 'MSVC-RUNTIME-LICENSE.docx'
  await cp(await download(license, cache), join(directory, licenseFile))
  const metadata = { formatVersion: 1, architecture: process.arch, libraries, license: { ...license, file: licenseFile } }
  await writeFile(join(directory, 'windows-runtime.json'), JSON.stringify(metadata, null, 2) + '\n')
  return metadata
}

export async function stageRuntime(root, stage) {
  if (!['win32', 'darwin', 'linux'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) {
    throw new Error(`Unsupported release target: ${process.platform}/${process.arch}`)
  }
  const runtime = join(stage, 'runtime'), application = join(runtime, 'app')
  await mkdir(application, { recursive: true })
  const executable = join(runtime, process.platform === 'win32' ? 'node.exe' : 'node')
  await cp(process.execPath, executable)
  if (process.platform !== 'win32') await chmod(executable, 0o755)
  const facts = JSON.parse(await run(executable, ['-p', 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})'], stage))
  if (facts.platform !== process.platform || facts.arch !== process.arch || facts.version !== process.version) throw new Error('Bundled Node runtime identity mismatch')
  let license
  try { license = await readFile(join(dirname(process.execPath), 'LICENSE')) }
  catch {
    const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error('The Node distribution license must be included')
    license = Buffer.from(await response.arrayBuffer())
  }
  await writeFile(join(runtime, 'NODE-LICENSE'), license)
  const artifacts = { node: { ...facts, sha256: await hash(executable) } }
  if (process.platform === 'win32') {
    const lock = JSON.parse(await readFile(new URL('./runtime-artifacts.json', import.meta.url), 'utf8'))
    const cache = join(root, 'artifacts/runtime-cache')
    artifacts.windowsCRuntime = await stageWindowsCRuntime(stage, cache, lock.windowsCRuntimeLicense)
    for (const kind of ['powershell', 'bash']) {
      const artifact = lock[kind][process.arch], archive = await download(artifact, cache), target = join(runtime, kind)
      await mkdir(target, { recursive: true })
      if (kind === 'powershell') await run('tar.exe', ['-xf', archive, '-C', target], root)
      else await run(archive, ['-y', `-o${target}`], root)
      artifacts[kind] = { version: lock[kind].version, ...artifact }
    }
    await access(join(runtime, 'powershell/pwsh.exe')); await access(join(runtime, 'bash/bin/bash.exe'))
    await run(join(runtime, 'powershell/pwsh.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], root)
    await run(join(runtime, 'bash/bin/bash.exe'), ['--version'], root)
  }
  // Keep all service code outside ASAR: standalone Node cannot read an Electron archive.
  for (const name of ['dist', 'web', 'node_modules', 'package.json', 'release.json', 'deploy']) {
    await cp(join(stage, name), join(application, name), { recursive: true })
  }
  await writeFile(join(runtime, 'runtime.json'), JSON.stringify({ formatVersion: 1, platform: process.platform, architecture: process.arch, artifacts }, null, 2) + '\n')
  const launcher = process.platform === 'win32'
    ? '@echo off\r\nset "ANYBOX_RUNTIME_DIRECTORY=%~dp0"\r\n"%~dp0node.exe" "%~dp0app\\dist\\entrypoints\\anybox-main.js" %*\r\nexit /b %errorlevel%\r\n'
    : '#!/bin/sh\nHERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1\nexport ANYBOX_RUNTIME_DIRECTORY="$HERE"\nexec "$HERE/node" "$HERE/app/dist/entrypoints/anybox-main.js" "$@"\n'
  const launcherPath = join(runtime, process.platform === 'win32' ? 'anybox.cmd' : 'anybox')
  await writeFile(launcherPath, launcher, { mode: 0o755 })
  return runtime
}

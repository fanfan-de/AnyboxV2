import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const repository = fileURLToPath(new URL('..', import.meta.url))

async function buildWindowsDialog(root, outputDirectory) {
  if (!['arm64', 'x64'].includes(process.arch)) throw new Error('Unsupported Windows architecture')
  const destination = resolve(outputDirectory)
  await mkdir(destination, { recursive: true })
  const temporary = await mkdtemp(join(destination, '.windows-dialog-build-'))
  const binary = join(temporary, 'anybox-dialog-host.exe')
  const linkerArguments = []
  try {
    try { await run('where.exe', ['link.exe'], { windowsHide: true }) }
    catch {
      const vswhere = join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe')
      const { stdout } = await run(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-find', `VC/Tools/MSVC/**/bin/Hostx64/${process.arch === 'arm64' ? 'arm64' : 'x64'}/link.exe`], { windowsHide: true })
      const linker = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)
      if (!linker) throw new Error('Windows native dialog cancellation requires MSVC build tools')
      linkerArguments.push('-C', `linker=${linker}`)
    }
    await run('rustc', ['--edition=2021', '--crate-name', 'anybox_dialog_host', '-C', 'opt-level=2', '-C', 'debuginfo=0', '-C', 'strip=symbols', '-C', 'target-feature=+crt-static',
      ...linkerArguments, resolve(root, 'src/desktop/native/windows-dialog.rs'), '-o', binary], { cwd: resolve(root), windowsHide: true })
    const { stdout } = await run(binary, ['--version'], { windowsHide: true })
    if (stdout.trim() !== 'anybox-dialog-host 1') throw new Error('Windows native dialog cancellation validation failed')
    const output = join(destination, 'anybox-dialog-host.exe')
    await rename(binary, output)
    return output
  } finally {
    if (dirname(temporary) !== destination) throw new Error('Invalid native build temporary directory')
    await rm(temporary, { recursive: true, force: true })
  }
}

/** Build each host's dialog cancellation adapter separately from the shared Web build. */
export async function buildDesktopNative(root, outputDirectory = join(root, 'dist/desktop/native')) {
  if (process.platform === 'win32') return buildWindowsDialog(root, outputDirectory)
  if (process.platform !== 'darwin') return undefined
  if (!['arm64', 'x64'].includes(process.arch)) throw new Error('Unsupported macOS architecture')
  const source = resolve(root, 'src/desktop/native/mac-dialog.mm')
  const includes = resolve(dirname(process.execPath), '../include/node')
  try { await access(join(includes, 'node_api.h')) }
  catch { throw new Error(`Desktop native build requires Node-API headers at ${includes}`) }
  await access(source)
  const destination = resolve(outputDirectory)
  await mkdir(destination, { recursive: true })
  const temporary = await mkdtemp(join(destination, '.mac-dialog-build-'))
  const binary = join(temporary, 'mac-dialog.node')
  try {
    await run('xcrun', ['clang++', '-std=c++17', '-O2', '-arch', process.arch === 'x64' ? 'x86_64' : 'arm64',
      '-mmacosx-version-min=11.0', '-fobjc-arc', '-fvisibility=hidden',
      '-DNAPI_VERSION=8', '-I', includes, '-dynamiclib', '-undefined', 'dynamic_lookup',
      '-framework', 'Cocoa', source, '-o', binary], { cwd: resolve(root) })
    const output = join(destination, 'mac-dialog.node')
    await rename(binary, output)
    return output
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const filename = process.platform === 'win32' ? 'anybox-dialog-host.exe' : 'mac-dialog.node'
  if (args.length && (args.length !== 2 || args[0] !== '--output' || basename(args[1]) !== filename)) {
    throw new Error(`Usage: node scripts/build-desktop-native.mjs [--output /path/to/${filename}]`)
  }
  const output = args.length ? dirname(resolve(args[1])) : join(repository, 'dist/desktop/native')
  const built = await buildDesktopNative(repository, output)
  if (built) console.log(built)
}

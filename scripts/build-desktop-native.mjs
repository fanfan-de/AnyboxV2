import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const repository = fileURLToPath(new URL('..', import.meta.url))

/** Build the portable Node-API adapter separately from the shared Web build. */
export async function buildDesktopNative(root, outputDirectory = join(root, 'dist/desktop/native')) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('The desktop native adapter currently requires macOS Apple Silicon')
  }
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
    await run('xcrun', ['clang++', '-std=c++17', '-O2', '-arch', 'arm64',
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
  if (args.length && (args.length !== 2 || args[0] !== '--output' || basename(args[1]) !== 'mac-dialog.node')) {
    throw new Error('Usage: node scripts/build-desktop-native.mjs [--output /path/to/mac-dialog.node]')
  }
  const output = args.length ? dirname(resolve(args[1])) : join(repository, 'dist/desktop/native')
  console.log(await buildDesktopNative(repository, output))
}

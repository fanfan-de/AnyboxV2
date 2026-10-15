import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'

const run = promisify(execFile)
const repository = fileURLToPath(new URL('..', import.meta.url))
/** A target-native, dependency-free supervisor. Development and packaged runtimes use the same binary. */
export async function buildProcessNative(root = repository, outputDirectory = join(root, 'dist/platform/native')) {
  if (!['win32', 'linux', 'darwin'].includes(process.platform)) throw new Error('Unsupported native process platform')
  const source = join(root, 'src/platform/native')
  const files = ['process-host.rs', 'windows.rs', 'unix.rs']
  // Standalone Windows hosts must not depend on an installed MSVC runtime.
  const compilerFlags = ['--edition=2021', '--crate-name', 'anybox_process_host', '-C', 'opt-level=2', '-C', 'debuginfo=0', '-C', 'strip=debuginfo',
    ...(process.platform === 'win32' ? ['-C', 'target-feature=+crt-static'] : [])]
  const hash = createHash('sha256')
  hash.update(JSON.stringify(compilerFlags))
  for (const file of files) hash.update(await readFile(join(source, file)))
  const sourceHash = hash.digest('hex'), destination = resolve(outputDirectory)
  const filename = process.platform === 'win32' ? 'anybox-process-host.exe' : 'anybox-process-host'
  const output = join(destination, filename), metadataPath = join(destination, 'process-host.json')
  try {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
    if (metadata.platform === process.platform && metadata.arch === process.arch && metadata.sourceHash === sourceHash && metadata.protocol === 1) {
      await readFile(output); return output
    }
  } catch {}
  await mkdir(destination, { recursive: true })
  const temporary = join(destination, `${filename}.${process.pid}.tmp${process.platform === 'win32' ? '.exe' : ''}`)
  try {
    await run('rustc', [...compilerFlags, join(source, 'process-host.rs'), '-o', temporary], { cwd: root, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
    await rename(temporary, output)
    await writeFile(metadataPath, JSON.stringify({ protocol: 1, platform: process.platform, arch: process.arch, sourceHash }) + '\n')
    return output
  } finally {
    await rm(temporary, { force: true })
    if (process.platform === 'win32') await rm(temporary.replace(/\.exe$/, '.pdb'), { force: true })
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(await buildProcessNative())

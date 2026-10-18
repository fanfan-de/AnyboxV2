/** Portable application staging shared by Node releases and desktop packaging. */
import { spawn } from 'node:child_process'
import { mkdir, cp, readFile, writeFile, readdir, lstat } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { verifyStagedApplication } from './verify-staged-application.mjs'
import { buildDesktopNative } from './build-desktop-native.mjs'

export const run = (command, args, cwd, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], ...options }); let output = ''
  child.stdout.on('data', value => { output += value })
  child.once('error', reject)
  child.once('exit', (code, signal) => code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code ?? signal}`)))
})

export async function stageApplication(root, directory, { desktop = false, build = true } = {}) {
  root = resolve(root)
  const output = resolve(directory)
  if (output === root || root.startsWith(output + '/')) throw new Error('Choose a separate empty output directory')
  await mkdir(output, { recursive: true })
  if ((await readdir(output)).length) throw new Error('Release output must be empty')
  if (build) await run('npm', ['run', 'build'], root)
  // The adapter must be inside the directory-picker tarball before npm installs it.
  if (desktop) await buildDesktopNative(root)
  await mkdir(join(output, 'vendor'))
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const dependencies = {}, artifacts = {}
  const pack = async (directory, packageDirectory) => {
    const packed = JSON.parse(await run('npm', ['pack', directory, '--json', '--ignore-scripts', '--pack-destination', join(output, 'vendor')], root))[0]
    dependencies[packed.name] = `file:vendor/${packed.filename}`
    artifacts[packed.name] = { version: packed.version, integrity: packed.integrity }
    if (packageDirectory) {
      // Keep the current physical CLI entries and module-relative assets available.
      // Runtime package imports resolve the independently installed tarballs.
      for (const entry of packed.files) {
        const source = join(directory, entry.path), destination = join(output, 'packages', packageDirectory, entry.path)
        if (!(await lstat(source)).isFile()) throw new Error(`Workspace package contains a non-regular file: ${source}`)
        await mkdir(dirname(destination), { recursive: true })
        await cp(source, destination)
      }
    }
  }
  const directories = (await readdir(join(root, 'packages'), { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of directories) await pack(join(root, 'packages', entry.name), entry.name)
  const nya = manifest.devDependencies?.['@nya/core']
  if (typeof nya !== 'string' || !nya.startsWith('file:')) throw new Error('Release requires the configured local Nya build')
  await pack(resolve(root, nya.slice(5)))
  await cp(join(root, 'deploy'), join(output, 'deploy'), { recursive: true })
  await cp(join(root, 'docs/harness-server-deployment.md'), join(output, 'README.md'))
  const scripts = { anybox: 'node packages/distribution/dist/entrypoints/anybox-main.js',
    'harness:server': 'node packages/distribution/dist/entrypoints/anybox-main.js harness-server', 'harness:server:init': 'node packages/distribution/dist/entrypoints/anybox-main.js harness-server init',
    harness: 'npm run harness:server', 'harness:init': 'npm run harness:server:init', client: 'node packages/distribution/dist/entrypoints/anybox-main.js client',
    'computer:worker': 'node packages/distribution/dist/entrypoints/anybox-main.js computer-worker', web: 'npm run client', 'web:local': 'node packages/distribution/dist/entrypoints/serve.js' }
  await writeFile(join(output, 'package.json'), JSON.stringify({ name: desktop ? 'anybox-desktop' : 'anybox-app', productName: desktop ? 'Anybox' : undefined,
    version: manifest.version, private: true, type: 'module', engines: manifest.engines, scripts, dependencies,
    ...(desktop ? { main: 'packages/distribution/dist/entrypoints/desktop-main.js', devDependencies: { electron: manifest.devDependencies.electron } } : {}) }, null, 2) + '\n')
  await run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], output)
  const lock = await readFile(join(output, 'package-lock.json'))
  await writeFile(join(output, 'release.json'), JSON.stringify({ version: manifest.version, artifacts,
    lockSha256: createHash('sha256').update(lock).digest('hex'),
    nativeDependencies: desktop ? 'Matching macOS arm64 native dependencies are included in the desktop package.' : 'Install with npm ci --omit=dev --include=optional on the target macOS/Linux platform.' }, null, 2) + '\n')
  await verifyStagedApplication(root, output)
  return { output, manifest, artifacts }
}

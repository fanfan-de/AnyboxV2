/** Portable application staging shared by Node releases and desktop packaging. */
import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { mkdir, cp, readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve, join, dirname, relative, isAbsolute, delimiter } from 'node:path'
import { createHash } from 'node:crypto'
import { verifyStagedApplication } from './verify-staged-application.mjs'

export const run = (command, args, cwd, options = {}) => new Promise((resolve, reject) => {
  // npm.cmd is not an executable. Invoke npm's JavaScript entry directly so
  // paths and arguments never pass through cmd.exe or shell interpolation.
  if (command === 'npm') {
    let npm = process.env.npm_execpath
    if (!npm) {
      const adjacent = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
      if (existsSync(adjacent)) npm = adjacent
      else for (const folder of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
        const candidate = process.platform === 'win32' ? join(folder, 'node_modules/npm/bin/npm-cli.js') : join(folder, 'npm')
        if (existsSync(candidate)) { npm = realpathSync(candidate); break }
      }
    }
    if (!npm || !existsSync(npm)) throw new Error('Build requires an installed npm CLI; run through npm or set npm_execpath')
    args = [npm, ...args]; command = process.execPath
  }
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true, ...options }); let output = ''
  child.stdout.on('data', value => { output += value })
  child.once('error', reject)
  child.once('exit', (code, signal) => code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code ?? signal}`)))
})

export async function stageApplication(root, directory, { desktop = false, build = true } = {}) {
  const output = resolve(directory)
  const inside = relative(output, resolve(root))
  if (!inside || (!inside.startsWith('..') && !isAbsolute(inside))) throw new Error('Choose a separate empty output directory')
  await mkdir(output, { recursive: true })
  if ((await readdir(output)).length) throw new Error('Release output must be empty')
  if (build) await run('npm', ['run', 'build'], root)
  await mkdir(join(output, 'vendor'))
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const dependencies = { ...manifest.dependencies }, artifacts = {}
  for (const [name, spec] of Object.entries(dependencies)) {
    if (!spec.startsWith('file:')) continue
    const packed = JSON.parse(await run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', join(output, 'vendor')], resolve(root, spec.slice(5))))[0]
    dependencies[name] = `file:vendor/${packed.filename}`
    artifacts[name] = { version: packed.version, integrity: packed.integrity }
  }
  await cp(join(root, 'dist'), join(output, 'dist'), { recursive: true })
  await cp(join(root, 'web'), join(output, 'web'), { recursive: true })
  await cp(join(root, 'deploy'), join(output, 'deploy'), { recursive: true })
  await cp(join(root, 'docs/harness-server-deployment.md'), join(output, 'README.md'))
  const scripts = { anybox: 'node dist/entrypoints/anybox-main.js',
    'harness:server': 'node dist/entrypoints/anybox-main.js harness-server', 'harness:server:init': 'node dist/entrypoints/anybox-main.js harness-server init',
    harness: 'npm run harness:server', 'harness:init': 'npm run harness:server:init', client: 'node dist/entrypoints/anybox-main.js client',
    'computer:worker': 'node dist/entrypoints/anybox-main.js computer-worker', web: 'npm run client', 'web:local': 'node dist/entrypoints/serve.js' }
  await writeFile(join(output, 'package.json'), JSON.stringify({ name: desktop ? 'anybox-desktop' : 'anybox-app', productName: desktop ? 'Anybox' : undefined,
    version: manifest.version, private: true, type: 'module', engines: manifest.engines, scripts, dependencies,
    ...(desktop ? { main: 'dist/entrypoints/desktop-main.js', devDependencies: { electron: manifest.devDependencies.electron } } : {}) }, null, 2) + '\n')
  await run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], output)
  const lock = await readFile(join(output, 'package-lock.json'))
  await writeFile(join(output, 'release.json'), JSON.stringify({ version: manifest.version, artifacts,
    lockSha256: createHash('sha256').update(lock).digest('hex'),
    platform: process.platform, architecture: process.arch,
    nativeDependencies: 'Target-platform dependencies and an independent Node runtime are included by the product packaging step.' }, null, 2) + '\n')
  await verifyStagedApplication(root, output)
  return { output, manifest, artifacts }
}

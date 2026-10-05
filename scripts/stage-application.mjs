/** Portable application staging shared by Node releases and desktop packaging. */
import { spawn } from 'node:child_process'
import { mkdir, cp, readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { verifyStagedApplication } from './verify-staged-application.mjs'

export const run = (command, args, cwd, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], ...options }); let output = ''
  child.stdout.on('data', value => { output += value })
  child.once('error', reject)
  child.once('exit', (code, signal) => code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code ?? signal}`)))
})

export async function stageApplication(root, directory, { desktop = false, build = true } = {}) {
  const output = resolve(directory)
  if (output === root || root.startsWith(output + '/')) throw new Error('Choose a separate empty output directory')
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
  const scripts = { 'harness:server': 'node dist/entrypoints/harness-server-main.js', 'harness:server:init': 'node dist/entrypoints/harness-server-main.js init',
    harness: 'npm run harness:server', 'harness:init': 'npm run harness:server:init', client: 'node dist/entrypoints/client-main.js', web: 'node dist/entrypoints/serve.js' }
  await writeFile(join(output, 'package.json'), JSON.stringify({ name: desktop ? 'anybox-desktop' : 'anybox-app', productName: desktop ? 'Anybox' : undefined,
    version: manifest.version, private: true, type: 'module', engines: manifest.engines, scripts, dependencies,
    ...(desktop ? { main: 'dist/entrypoints/desktop-main.js', devDependencies: { electron: manifest.devDependencies.electron } } : {}) }, null, 2) + '\n')
  await run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], output)
  const lock = await readFile(join(output, 'package-lock.json'))
  await writeFile(join(output, 'release.json'), JSON.stringify({ version: manifest.version, artifacts,
    lockSha256: createHash('sha256').update(lock).digest('hex'),
    nativeDependencies: desktop ? 'Matching macOS arm64 native dependencies are included in the desktop package.' : 'Install with npm ci --omit=dev --include=optional on the target macOS/Linux platform.' }, null, 2) + '\n')
  await verifyStagedApplication(root, output)
  return { output, manifest, artifacts }
}

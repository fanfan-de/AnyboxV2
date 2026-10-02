/** Build an installable application, including the exact local Nya build and offline Models catalog. */
import { spawn } from 'node:child_process'
import { verifyDefaultWebAssets } from './verify-web-assets.mjs'
import { mkdir, cp, readFile, writeFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
const root = fileURLToPath(new URL('..', import.meta.url))
const output = resolve(process.argv[2] ?? join(root, 'artifacts/anybox-app'))
if (output === root || root.startsWith(output + '/')) throw new Error('Choose a separate empty output directory')
await mkdir(output, { recursive: true })
if ((await readdir(output)).length) throw new Error('Release output must be empty')
const run = (cmd, args, cwd) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }); let out = ''
  child.stdout.on('data', value => { out += value })
  child.once('error', reject); child.once('exit', code => code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}`)))
})
await run('npm', ['run', 'build'], root)
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
await cp(join(root, 'docs/harness-deployment.md'), join(output, 'README.md'))
await writeFile(join(output, 'package.json'), JSON.stringify({ name: 'anybox-app', version: manifest.version, private: true, type: 'module', engines: manifest.engines,
  scripts: { harness: 'node dist/entrypoints/harness-main.js', 'harness:init': 'node dist/entrypoints/harness-main.js init', client: 'node dist/entrypoints/client-main.js', web: 'node dist/entrypoints/serve.js' }, dependencies }, null, 2) + '\n')
await run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], output)
await verifyDefaultWebAssets(root, output)
const lock = await readFile(join(output, 'package-lock.json'))
await writeFile(join(output, 'release.json'), JSON.stringify({ version: manifest.version, artifacts, lockSha256: createHash('sha256').update(lock).digest('hex'), nativeDependencies: 'Install with npm ci --omit=dev on the target macOS/Linux platform.' }, null, 2) + '\n')
process.stdout.write(`Application release: ${output}\nInstall on target: npm ci --omit=dev\n`)

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, readdir, realpath, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const receipt = join(root, 'dist/core/computer/worker-build.json')
const hash = createHash('sha256').update('anybox-computer-worker-build-1\n')
const skipped = new Set(['node_modules', 'src', 'scripts', 'test', 'tests', 'docs', 'examples', 'coverage', '.git', '.github', '.vscode'])

async function include(path, label) {
  const bytes = await readFile(path)
  hash.update(JSON.stringify([label, bytes.byteLength])).update(bytes)
}
async function tree(directory, label) {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  for (const entry of entries) {
    if (skipped.has(entry.name) || entry.name.startsWith('.') || /(?:\.map|\.d\.[cm]?ts|\.md|\.txt|\.tsbuildinfo)$/i.test(entry.name) || entry.name === 'worker-build.json') continue
    const path = join(directory, entry.name), name = `${label}/${entry.name}`
    if (entry.isDirectory()) await tree(path, name)
    else if (entry.isFile()) await include(path, name)
  }
}

async function dependency(name, parent, optional) {
  for (const directory of createRequire(join(parent, 'package.json')).resolve.paths(name) ?? []) {
    const path = join(directory, name)
    try {
      const location = await realpath(path), manifest = JSON.parse(await readFile(join(location, 'package.json'), 'utf8'))
      if (manifest.name === name) return { location, manifest }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
    }
  }
  if (!optional) throw new Error(`Missing worker build dependency: ${name}`)
}

// The code loaded by a worker and its installed production dependencies determine
// compatibility. Hash actual output bytes, including Nya and native executables;
// timestamps, checkout paths, source maps and the receipt itself do not participate.
await include(join(root, 'package.json'), '@anybox/app-harness/package.json')
await tree(join(root, 'dist/core'), '@anybox/app-harness/dist/core')
await include(join(root, 'dist/entrypoints/computer-worker-main.js'), '@anybox/app-harness/dist/entrypoints/computer-worker-main.js')
const seeds = ['@anybox/api-key-manager', '@anybox/application-api', '@anybox/computer-tools', '@anybox/storage-sqlite', '@anybox/tool-api', '@nya/core', 'sharp']
const queue = seeds.map(name => ({ name, parent: root, label: name, optional: false })), visited = new Set()
for (let index = 0; index < queue.length; index++) {
  const item = queue[index], found = await dependency(item.name, item.parent, item.optional)
  if (!found || visited.has(found.location)) continue
  visited.add(found.location)
  await tree(found.location, item.label)
  const manifest = found.manifest
  const names = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})])
  for (const name of [...names].sort()) queue.push({ name, parent: found.location, label: `${item.label}/dependencies/${name}`,
    optional: name in (manifest.optionalDependencies ?? {}) || manifest.peerDependenciesMeta?.[name]?.optional === true })
}
const buildId = hash.digest('hex'), temporary = `${receipt}.${process.pid}.tmp`
await mkdir(dirname(receipt), { recursive: true })
try {
  await writeFile(temporary, JSON.stringify({ formatVersion: 1, buildId }) + '\n')
  await rename(temporary, receipt)
} finally { await rm(temporary, { force: true }) }

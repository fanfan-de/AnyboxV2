import assert from 'node:assert/strict'
import { access, cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../../', import.meta.url))
const exists = path => access(path).then(() => true, () => false)

async function locate(name, from) {
  for (let directory = await realpath(from);; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', name)
    if (await exists(join(candidate, 'package.json'))) return realpath(candidate)
    if (dirname(directory) === directory) throw new Error(`Missing declared dependency ${name} from ${from}`)
  }
}

/** A physical production closure: no workspace links, source trees, root dev dependencies or NODE_PATH. */
export async function copyApplicationClosure(name, destination) {
  const installed = new Map(), names = new Set()
  const install = async (id, source, parent) => {
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
    let target = join(destination, 'node_modules', id)
    if (installed.has(target) && installed.get(target) !== source) target = join(parent, 'node_modules', id)
    if (installed.has(target)) {
      assert.equal(installed.get(target), source, `Incompatible dependency placement: ${id}`)
      return
    }
    installed.set(target, source); names.add(id)
    await mkdir(target, { recursive: true })
    if (id.startsWith('@anybox/') || id === '@nya/core') {
      assert.ok(Array.isArray(manifest.files), `${id} must declare its published payload`)
      await cp(join(source, 'package.json'), join(target, 'package.json'))
      for (const path of manifest.files) {
        assert.equal(path.includes('*'), false, `Handle the published glob before isolating ${id}`)
        if (await exists(join(source, path))) await cp(join(source, path), join(target, path), { recursive: true, dereference: true })
      }
    } else {
      await cp(source, target, { recursive: true, dereference: true, filter: path => path === source || !path.slice(source.length + 1).split(/[\\/]/).includes('node_modules') })
    }
    const dependencies = new Map(Object.keys(manifest.dependencies ?? {}).map(key => [key, false]))
    for (const key of Object.keys(manifest.peerDependencies ?? {})) if (!manifest.peerDependenciesMeta?.[key]?.optional) dependencies.set(key, false)
    for (const key of Object.keys(manifest.optionalDependencies ?? {})) dependencies.set(key, true)
    for (const [key, optional] of dependencies) {
      let dependency
      try { dependency = await locate(key, source) } catch (error) { if (optional) continue; throw error }
      await install(key, dependency, target)
    }
  }
  await install(name, await locate(name, repository), destination)
  await writeFile(join(destination, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  for (const forbidden of ['@anybox/host', '@anybox/distribution', name === '@anybox/app-harness' ? '@anybox/app-claude-agent' : '@anybox/app-harness']) {
    assert.equal(names.has(forbidden), false, `${forbidden} entered ${name}'s closure`)
    assert.equal(await exists(join(destination, 'node_modules', forbidden)), false)
  }
  return { names, directory: resolve(destination) }
}

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, readdir, access } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { isBuiltin } from 'node:module'
import ts from 'typescript'

const root = resolve('.')
const name = path => relative(root, path).split(sep).join('/')
const inside = (file, directory) => {
  const target = file.split(sep).join('/'), root = directory.split(sep).join('/')
  return target === root || target.startsWith(root + '/')
}
const packageName = specifier => specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
const exists = path => access(path).then(() => true, () => false)

async function files(directory, predicate) {
  if (!await exists(directory)) return []
  return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? files(path, predicate) : predicate(path) ? [path] : []
  }))).flat()
}
const workspaces = (async () => new Map(await Promise.all((await readdir(join(root, 'packages'), { withFileTypes: true }))
  .filter(entry => entry.isDirectory()).map(async entry => {
    const directory = join(root, 'packages', entry.name), manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    return [manifest.name, { directory, manifest }]
  }))))()

function imports(path, text) {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true), result = []
  const visit = node => {
    const imported = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
      : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal
        : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          ts.isIdentifier(node.expression) && node.expression.text === 'require' ||
          ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'resolve' &&
            ts.isMetaProperty(node.expression.expression)) ? node.arguments[0] : undefined
    if (imported && ts.isStringLiteralLike(imported)) result.push({ specifier: imported.text, typeOnly: ts.isImportTypeNode(node) || (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) || (ts.isExportDeclaration(node) && node.isTypeOnly) })
    ts.forEachChild(node, visit)
  }
  visit(file)
  return result
}
function exportTarget(manifest, specifier) {
  const subpath = specifier === manifest.name ? '.' : '.' + specifier.slice(manifest.name.length)
  let target = manifest.exports?.[subpath], replacement
  if (target === undefined) for (const key of Object.keys(manifest.exports ?? {}).sort((a, b) => b.length - a.length)) {
    const star = key.indexOf('*')
    if (star < 0 || !subpath.startsWith(key.slice(0, star)) || !subpath.endsWith(key.slice(star + 1))) continue
    target = manifest.exports[key]; replacement = subpath.slice(star, subpath.length - (key.length - star - 1)); break
  }
  const select = value => typeof value === 'string' ? value : value && typeof value === 'object'
    ? select(value.import ?? value.node ?? value.default ?? value.types) : undefined
  const path = select(target)
  assert.ok(path?.startsWith('./'), `${specifier} is not a public export of ${manifest.name}`)
  return replacement === undefined ? path : path.replaceAll('*', replacement)
}
async function sourcePath(path, phase) {
  path = path.split(sep).join('/')
  const options = phase === 'source' ? [path.replace(/\/dist\//, '/src/').replace(/\.js$/, '.ts'), path.replace(/\.js$/, '.ts'), path.replace(/\.js$/, '.d.ts'), path] : [path]
  for (const candidate of options) if (await exists(candidate)) return candidate
  assert.fail(`Missing ${phase} dependency ${name(path)}`)
}

/** Workspace bare imports resolve through exports rather than ending traversal at the package name. */
async function graph(phase) {
  const packages = await workspaces, paths = []
  for (const { directory, manifest } of packages.values()) {
    const subtree = join(directory, phase === 'source' ? 'src' : 'dist')
    paths.push(...await files(subtree, path => phase === 'source' ? /\.(?:ts|js)$/.test(path) : path.endsWith('.js')))
    if (!await exists(subtree)) for (const target of ['index.js', 'index.d.ts']) if (await exists(join(directory, target))) paths.push(join(directory, target))
  }
  const modules = new Map()
  for (const path of paths) {
    const owner = [...packages.values()].find(item => inside(path, item.directory)), edges = []
    for (const { specifier } of imports(path, await readFile(path, 'utf8'))) {
      if (specifier.startsWith('.')) {
        const target = await sourcePath(resolve(dirname(path), specifier), phase)
        assert.ok(inside(target, owner.directory), `Private relative cross-package import: ${name(path)} -> ${specifier}`)
        assert.equal(phase === 'source' && inside(target, join(owner.directory, 'dist')), false, `Source imports build output: ${name(path)}`)
        edges.push(name(target))
      } else if (packages.has(packageName(specifier))) {
        const target = packages.get(packageName(specifier))
        edges.push(name(await sourcePath(resolve(target.directory, exportTarget(target.manifest, specifier)), phase)))
      } else edges.push(specifier)
    }
    modules.set(name(path), edges)
  }
  return modules
}
const sourceGraph = () => graph('source')
function assertBoundary(modules, roots, forbidden, reason) {
  assert.ok(roots.length, 'Boundary must cover installed package files')
  for (const origin of roots) {
    const visited = new Set()
    const visit = (module, chain) => {
      if (visited.has(module)) return
      visited.add(module)
      const path = [...chain, module]
      assert.equal(forbidden(module), false, `${reason}: ${path.join(' -> ')}`)
      for (const dependency of modules.get(module) ?? []) visit(dependency, path)
    }
    visit(origin, [])
  }
}

test('all workspace imports use public exports, stay inside their package and declare their npm dependencies', async () => {
  const packages = await workspaces
  await sourceGraph() // Resolves all source edges, including type edges and import.meta.resolve.
  for (const { directory, manifest } of packages.values()) {
    const runtimeDeclared = new Set([manifest.name, ...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})])
    const declared = new Set([...runtimeDeclared, ...Object.keys(manifest.devDependencies ?? {})])
    const paths = await files(directory, path => !inside(path, join(directory, 'dist')) && !inside(path, join(directory, 'node_modules')) && /\.(?:[cm]?js|ts)$/.test(path))
    for (const path of paths) for (const { specifier, typeOnly } of imports(path, await readFile(path, 'utf8'))) {
      if (specifier.startsWith('.') || isBuiltin(specifier)) continue
      const dependency = packageName(specifier)
      const typesPackage = '@types/' + dependency.replace(/^@/, '').replace('/', '__')
      const permitted = inside(path, join(directory, 'src')) && !typeOnly ? runtimeDeclared : declared
      assert.ok(permitted.has(dependency) || typeOnly && declared.has(typesPackage), `${name(path)} imports undeclared ${dependency}`)
      if (packages.has(dependency)) exportTarget(packages.get(dependency).manifest, specifier)
    }
  }
})

test('minimum host and SQLite have no transitive application, connection, directory or Vault dependency', async () => {
  const modules = await sourceGraph(), roots = [...modules.keys()].filter(file => inside(file, 'packages/host/src') || inside(file, 'packages/storage-sqlite/src'))
  const forbidden = ['packages/app-harness', 'packages/app-claude-agent', 'packages/distribution', 'packages/models', 'packages/execution-connections', 'packages/directory-picker', 'packages/api-key-manager']
  assertBoundary(modules, roots, file => forbidden.some(directory => inside(file, directory)) || file === '@napi-rs/keyring' || file.startsWith('@anthropic-ai/'), 'Minimum host depends on an application capability')
})

test('applications never import host implementations or another application through package exports', async () => {
  const modules = await sourceGraph()
  for (const app of ['app-harness', 'app-claude-agent']) {
    const own = `packages/${app}`, other = `packages/${app === 'app-harness' ? 'app-claude-agent' : 'app-harness'}`
    assertBoundary(modules, [...modules.keys()].filter(file => inside(file, own + '/src')), file => inside(file, 'packages/host') || inside(file, 'packages/distribution') || inside(file, other), 'Application depends on host composition or another application')
  }
})

test('Harness and Claude Agent cores remain independent of their application adapters', async () => {
  const modules = await sourceGraph()
  for (const app of ['app-harness', 'app-claude-agent']) {
    const own = `packages/${app}/src`, core = own + '/core'
    assertBoundary(modules, [...modules.keys()].filter(file => inside(file, core)), file => inside(file, own) && !inside(file, core), 'Application core depends on an adapter')
  }
  const sdkImporters = [...modules].filter(([, dependencies]) => dependencies.some(value => value === '@anthropic-ai/claude-agent-sdk' || value.startsWith('@anthropic-ai/claude-agent-sdk/'))).map(([file]) => file)
  assert.ok(sdkImporters.length, 'the real Claude SDK adapter is covered')
  for (const file of sdkImporters) assert.ok(inside(file, 'packages/app-claude-agent/src/core/sdk'), `SDK import outside its adapter: ${file}`)
  assertBoundary(modules, [...modules.keys()].filter(file => inside(file, 'packages/app-claude-agent/src/client')), file =>
    inside(file, 'packages/app-claude-agent/src/core') && file !== 'packages/app-claude-agent/src/core/view.ts' || inside(file, 'packages/app-claude-agent/src/http'), 'Claude client loads execution code')
})

test('browser runtime closures follow public workspace exports and never reach Node or execution code', async () => {
  const modules = await graph('runtime'), api = 'packages/application-api/dist'
  for (const [directory, allowed] of [
    // Directory uploads share the host's pure, platform-neutral framing leaf.
    // Its entire runtime closure remains checked, so Node dependencies still fail.
    ['packages/host/dist/web', file => inside(file, 'packages/host/dist/web') || file === 'packages/host/dist/package-management/directory-format.js' || file === `${api}/web.js` || file === `${api}/index.js`],
    ['packages/app-harness/dist/web', file => inside(file, 'packages/app-harness/dist/web') || inside(file, 'packages/app-harness/dist/core') || file === `${api}/web.js` || file === `${api}/index.js`],
    ['packages/app-claude-agent/dist/web', file => inside(file, 'packages/app-claude-agent/dist/web') || ['packages/app-claude-agent/dist/core/events.js', 'packages/app-claude-agent/dist/core/view.js', `${api}/web.js`, `${api}/index.js`].includes(file)],
  ]) assertBoundary(modules, [...modules.keys()].filter(file => inside(file, directory)), file => !allowed(file), 'Browser imports a native or unrelated implementation')
})

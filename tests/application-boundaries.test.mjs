import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const root = resolve('.')
const name = path => relative(root, path).split(sep).join('/')
const inside = (file, directory) => file.startsWith(directory + '/')

async function files(directory, extension) {
  return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? files(path, extension) : entry.name.endsWith(extension) ? [path] : []
  }))).flat()
}

/** Include type edges: a host contract can acquire domain coupling without emitting an import. */
async function graph(directory, extension) {
  const paths = await files(resolve(directory), extension)
  return new Map(await Promise.all(paths.map(async path => {
    const file = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true)
    const dependencies = new Set()
    const visit = node => {
      const imported = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier
        : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) ? node.argument.literal
          : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0]
            : undefined
      if (imported && ts.isStringLiteral(imported)) {
        dependencies.add(imported.text.startsWith('.')
          ? name(resolve(dirname(path), imported.text.replace(/\.js$/, extension)))
          : imported.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
    return [name(path), [...dependencies]]
  })))
}

function assertBoundary(modules, roots, forbidden, reason) {
  assert.ok(roots.length, 'Boundary must cover installed source files')
  for (const root of roots) {
    const visited = new Set()
    const visit = (module, chain) => {
      if (visited.has(module)) return
      visited.add(module)
      const path = [...chain, module]
      assert.equal(forbidden(module), false, `${reason}: ${path.join(' -> ')}`)
      for (const dependency of modules.get(module) ?? []) visit(dependency, path)
    }
    visit(root, [])
  }
}

test('generic host and storage remain independent of applications and Models through every source dependency', async () => {
  const modules = await graph('src', '.ts')
  const roots = [...modules.keys()].filter(file => inside(file, 'src/host') || inside(file, 'src/storage'))
  assertBoundary(modules, roots, file => inside(file, 'src/applications') || inside(file, 'src/entrypoints') ||
    file === '@anybox/models' || file.startsWith('@anybox/models/'), 'Generic host depends on application policy')
})

test('Harness core remains independent of its transports, browser, and host implementations', async () => {
  const modules = await graph('src', '.ts'), core = 'src/applications/harness/core'
  const publicHostContracts = new Set(['src/host/applications/contracts.ts'])
  assertBoundary(modules, [...modules.keys()].filter(file => inside(file, core)), file =>
    inside(file, 'src/entrypoints') || inside(file, 'src/applications') && !inside(file, core) ||
    inside(file, 'src/host') && !publicHostContracts.has(file), 'Harness core depends on an application adapter')
})

test('browser dependency closures contain only browser modules and portable Harness projections', async () => {
  const modules = await graph('dist', '.js')
  const shell = 'dist/host/web', harness = 'dist/applications/harness/web', core = 'dist/applications/harness/core'
  assertBoundary(modules, [...modules.keys()].filter(file => inside(file, shell)), file =>
    !inside(file, shell), 'Browser shell depends on an application or native implementation')
  assertBoundary(modules, [...modules.keys()].filter(file => inside(file, harness)), file =>
    !inside(file, shell) && !inside(file, harness) && !inside(file, core), 'Harness browser reaches a native implementation')
})

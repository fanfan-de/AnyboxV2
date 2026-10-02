/** Validate the exact static map and emitted browser graph, also used after release copying. */
import { readFile, stat } from 'node:fs/promises'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, relative, join } from 'node:path'
import ts from 'typescript'

export async function verifyWebAssets(catalog) {
  const check = (from, specifier) => {
    if (!/^(?:\.\.?\/|\/)/.test(specifier)) throw new Error(`Browser import must be a registered URL: ${from} -> ${specifier}`)
    const target = new URL(specifier, `https://application.invalid${from}`).pathname
    if (!catalog.assets.has(target)) throw new Error(`Missing browser dependency: ${from} -> ${target}`)
  }
  for (const [path, asset] of catalog.assets) {
    if (!(await stat(asset.file)).isFile()) throw new Error(`Missing application asset file: ${path}`)
    const source = await readFile(asset.file, 'utf8')
    if (path.endsWith('.js')) {
      const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
      const visit = node => {
        const imported = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
          : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined
        if (imported) {
          if (ts.isStringLiteral(imported)) check(path, imported.text)
          else if (path !== '/host/web/client.js') throw new Error(`Undeclared dynamic browser import in ${path}`)
        }
        ts.forEachChild(node, visit)
      }
      visit(file)
      if (/\b(?:process\.env|require\s*\(|Buffer\.)/.test(source)) throw new Error(`Native runtime in browser asset: ${path}`)
    }
    if (asset.type.startsWith('text/html')) {
      for (const match of source.matchAll(/(?:src|href)="([^"#][^"]*)"/g)) check(path === '/' ? '/index.html' : path, match[1])
    }
    if (asset.type.startsWith('text/css')) {
      for (const match of source.matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/g)) if (!match[1].startsWith('#')) check(path, match[1])
    }
  }
}
export async function verifyDefaultWebAssets(directory, copiedDirectory) {
  const root = pathToFileURL(resolve(directory) + '/')
  const [{ harnessClientApplication }, { shellAssets }, { createApplicationCatalog }] = await Promise.all([
    import(new URL('dist/applications/harness/registration.js', root)), import(new URL('dist/host/assets.js', root)), import(new URL('dist/host/applications/registration.js', root)),
  ])
  const catalog = createApplicationCatalog([harnessClientApplication()], shellAssets)
  await verifyWebAssets(copiedDirectory ? { ...catalog, assets: new Map([...catalog.assets].map(([path, asset]) => [path, { ...asset, file: join(copiedDirectory, relative(resolve(directory), asset.file)) }])) } : catalog)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await verifyDefaultWebAssets(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)))
  process.stdout.write('Registered browser assets and dependencies verified.\n')
}

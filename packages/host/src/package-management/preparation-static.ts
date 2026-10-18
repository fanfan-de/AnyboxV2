import { parse } from 'acorn'
import type { ApplicationAsset, ApplicationRegistration } from '@anybox/application-api/node'
import { createApplicationCatalog, isCanonicalApplicationPath as validRoute } from '../applications/registration.js'
import { assertVerifiedApplicationArchive, parseApplicationArchiveJson, type VerifiedApplicationArchive } from './archive.js'

export interface PackageAliasPolicy {
  readonly assetPrefixes?: readonly string[]
  readonly routePrefixes?: readonly string[]
  readonly webLegacyRoutes?: readonly string[]
}
export type PackageAliasPolicies = Readonly<Record<string, PackageAliasPolicy>>
export interface PreparedAsset { readonly path: string; readonly file: string; readonly type: string }
export interface PreparedWebDeclaration {
  readonly entry: string
  readonly styles: readonly string[]
  readonly assets: readonly PreparedAsset[]
}
export function preparationFailure(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }) }
const fail = (code: string): never => { throw preparationFailure(code) }
const within = (prefix: string, path: string) => path === prefix.replace(/\/$/, '') || path.startsWith(prefix.replace(/\/$/, '') + '/')
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const text = (bytes: Uint8Array): string => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return fail('package-resource-encoding') } }
export function freezePreparation<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezePreparation(child); Object.freeze(value) }
  return value
}
/** Signed declarations are checked without evaluating browser or Node application code. */
export function verifyPackageWebResources(archive: VerifiedApplicationArchive, aliases: PackageAliasPolicies = {}): PreparedWebDeclaration | undefined {
  assertVerifiedApplicationArchive(archive)
  const { manifest } = archive
  if (!manifest.web) return undefined
  if (!manifest.web.assets) return fail('package-assets-index-required')
  let index: unknown
  try { index = parseApplicationArchiveJson(archive.readFile(manifest.web.assets)) } catch { return fail('package-assets-index-invalid') }
  if (!plain(index) || Object.keys(index).some(key => key !== 'schemaVersion' && key !== 'assets') || index.schemaVersion !== 1 || !Array.isArray(index.assets) || index.assets.length > 10_000) return fail('package-assets-index-invalid')
  const owned = `/apps/${manifest.appId}/${manifest.version}`
  const prefixes = [owned, ...(aliases[manifest.appId]?.assetPrefixes ?? [])]
  if (prefixes.some(prefix => !validRoute(prefix) || prefix === '/')) return fail('package-alias-policy-invalid')
  const paths = new Map<string, PreparedAsset>(), files = new Map<string, PreparedAsset>()
  const knownFiles = new Set(archive.filePaths)
  for (const value of index.assets) {
    if (!plain(value) || Object.keys(value).some(key => !['path', 'file', 'type'].includes(key)) || !validRoute(value.path) || typeof value.file !== 'string' || typeof value.type !== 'string' || !knownFiles.has(value.file) || !prefixes.some(prefix => within(prefix, value.path as string)) || paths.has(value.path) || files.has(value.file) || !/^(text\/(javascript|css|html|plain)|application\/json|image\/(svg\+xml|png|jpeg|gif|webp|avif|x-icon)|font\/(woff2?|ttf|otf))(?:; charset=utf-8)?$/.test(value.type)) return fail('package-asset-invalid')
    const asset = Object.freeze({ path: value.path, file: value.file, type: value.type })
    paths.set(asset.path, asset); files.set(asset.file, asset)
  }
  const entry = files.get(manifest.web.entry)
  if (!entry || !entry.type.startsWith('text/javascript')) return fail('package-web-entry-invalid')
  const styles = ((manifest.web as { styles?: readonly string[] }).styles ?? []).map(file => {
    const asset = files.get(file)
    if (!asset?.type.startsWith('text/css')) return fail('package-web-style-invalid')
    return asset.path
  })
  const reference = (value: string, base: string, module: boolean) => {
    if (module && value === '@anybox/application-api/web') return
    if (!value || value.startsWith('#')) { if (module) fail('package-resource-reference-invalid'); return }
    if (!module && value.startsWith('data:')) return fail('package-resource-reference-invalid')
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(value) || /[\\\0]/.test(value) || (module && !value.startsWith('.') && !value.startsWith('/'))) return fail('package-resource-reference-invalid')
    let url: URL
    try { url = new URL(value, 'https://package.invalid' + base) } catch { return fail('package-resource-reference-invalid') }
    if (url.origin !== 'https://package.invalid' || url.search || (module && url.hash)) return fail('package-resource-reference-invalid')
    const target = paths.get(url.pathname)
    if (!target || (module && !target.type.startsWith('text/javascript'))) return fail('package-resource-missing')
  }
  const inspectJavaScript = (source: string, base: string) => {
    let tree: unknown
    try { tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }) } catch { return fail('package-resource-javascript-invalid') }
    const queue: unknown[] = [tree]
    while (queue.length) {
      const item = queue.pop()
      if (!item || typeof item !== 'object') continue
      const node = item as Record<string, any>
      const property = (member: Record<string, any>) => member.computed ? member.property?.value : member.property?.name
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require' ||
          node.type === 'MemberExpression' && node.object.type === 'Identifier' && (node.object.name === 'Buffer' || node.object.name === 'process' && property(node) === 'env')) return fail('package-browser-node-runtime')
      if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' || node.type === 'ExportNamedDeclaration' && node.source) reference(node.source.value, base, true)
      if (node.type === 'ImportExpression') {
        if (node.source.type !== 'Literal' || typeof node.source.value !== 'string') return fail('package-dynamic-import-not-static')
        reference(node.source.value, base, true)
      }
      if (node.type === 'NewExpression' && node.callee.type === 'Identifier' && node.callee.name === 'URL' && node.arguments[1]?.type === 'MemberExpression' && node.arguments[1].object?.type === 'MetaProperty' && node.arguments[1].property?.name === 'url') {
        if (node.arguments[0]?.type !== 'Literal' || typeof node.arguments[0].value !== 'string') return fail('package-resource-url-not-static')
        reference(node.arguments[0].value, base, false)
      }
      // Absolute template/image paths are part of the package graph even when loaded with fetch().
      if (node.type === 'Literal' && typeof node.value === 'string' && node.value.startsWith('/') && /\.(?:js|css|html|svg|png|jpe?g|gif|webp|avif|woff2?|ttf|otf)(?:#.*)?$/i.test(node.value)) reference(node.value, base, false)
      for (const [key, value] of Object.entries(node)) if (key !== 'start' && key !== 'end') {
        if (Array.isArray(value)) queue.push(...value)
        else if (value && typeof value === 'object') queue.push(value)
      }
    }
  }
  const inspectCss = (source: string, base: string) => {
    // Reject escaping rather than accepting a spelling our restricted CSS scanner cannot prove.
    if (source.includes('\\')) return fail('package-resource-css-escape')
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '')
    if (/\/\*/.test(stripped)) return fail('package-resource-css-invalid')
    for (const match of stripped.matchAll(/@import\s+(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^\s;)]+))/gi)) reference(match[1] ?? match[2] ?? match[3], base, false)
    for (const match of stripped.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)/gi)) reference(match[1] ?? match[2] ?? match[3], base, false)
  }
  const inspectMarkup = (source: string, base: string) => {
    if (/<\s*(?:script|base|iframe|object|embed)\b/i.test(source)) return fail('package-resource-markup-active')
    for (const style of source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) inspectCss(style[1], base)
    for (const tag of source.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<\s*([a-z][\w:-]*)\b([^<>]*)>/gi)) {
      for (const attribute of tag[2].matchAll(/(?:^|\s)(src|href|xlink:href|poster|srcset|style)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
        const name = attribute[1].toLowerCase(), value = attribute[2] ?? attribute[3] ?? attribute[4]
        if (name === 'srcset' || value.includes('&')) return fail('package-resource-markup-reference')
        if (name === 'style') { inspectCss(value, base); continue }
        if (tag[1].toLowerCase() === 'a' && name === 'href') continue
        reference(value, base, false)
      }
    }
  }
  let inspectedBytes = 0
  for (const asset of paths.values()) {
    const bytes = archive.readFile(asset.file)
    inspectedBytes += bytes.length
    if (bytes.length > 16 * 1024 * 1024 || inspectedBytes > 64 * 1024 * 1024) return fail('package-resource-graph-too-large')
    if (asset.type.startsWith('text/javascript')) inspectJavaScript(text(bytes), asset.path)
    else if (asset.type.startsWith('text/css')) inspectCss(text(bytes), asset.path)
    else if (asset.type.startsWith('text/html') || asset.type.startsWith('image/svg+xml')) inspectMarkup(text(bytes), asset.path)
  }
  createApplicationCatalog([{ definition: { id: manifest.appId, name: manifest.displayName, icon: manifest.appId, web: { entry: entry.path, styles } }, assets: [...paths.values()] }])
  return freezePreparation({ entry: entry.path, styles, assets: [...paths.values()] })
}

export function assertPreparedCatalog(applications: readonly ApplicationRegistration[], assets: readonly ApplicationAsset[] = []): void {
  const services = new Set<string>()
  for (const application of applications) {
    const service = application.http?.service
    if (service !== undefined && (typeof service !== 'string' || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(service) || services.has(service))) return fail('package-service-conflict')
    if (service) services.add(service)
    const capabilities = application.http?.capabilities ?? []
    if (new Set(capabilities).size !== capabilities.length || capabilities.some(value => typeof value !== 'string' || !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(value))) return fail('package-http-capability-invalid')
  }
  createApplicationCatalog(applications, assets)
}

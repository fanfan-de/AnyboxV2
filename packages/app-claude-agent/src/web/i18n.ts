import { createInstance } from './vendor/i18next.js'
import { en, zh } from './i18n-resources.js'

export type MessageKey = keyof typeof zh
type Parameters<S extends string> = S extends `${string}{{${infer Name}}}${infer Rest}` ? Name | Parameters<Rest> : never
type Arguments<K extends MessageKey> = [Parameters<(typeof zh)[K]>] extends [never] ? [values?: Record<string, never>] : [values: Readonly<Record<Parameters<(typeof zh)[K]>, string | number>>]
export interface LocaleSource {
  current(): Readonly<{ preferredLocale: string; revision: number }>
  subscribe(listener: () => void): () => void
}
type Attribute = string | boolean | undefined | (() => string)
type Child = Node | string | null | undefined | false | (() => string)
type Binding = { node: WeakRef<HTMLElement>; attributes: Map<string, () => string> }

/** Existing fixed-tag DOM helper; translated values use the same text/attribute-only path. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Record<string, string | boolean | undefined> = {}, ...children: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue
    if (name === 'class') node.className = String(value)
    else if (name === 'text') node.textContent = String(value)
    else node.setAttribute(name, value === true ? '' : value)
  }
  for (const child of children) if (child) node.append(child)
  return node
}
export function resolveClaudeLocale(value: unknown): 'zh-CN' | 'en' {
  if (typeof value !== 'string') return 'zh-CN'
  try { const locale = Intl.getCanonicalLocales(value)[0]; return /^en(?:-|$)/i.test(locale) ? 'en' : 'zh-CN' } catch { return 'zh-CN' }
}

/** One presentation owner per mount. This module never changes the host's preference or business state. */
export function createClaudeI18n(source?: LocaleSource, staticSource = false) {
  let locale: 'zh-CN' | 'en' = 'zh-CN', revision = 0, closed = false, unsubscribe: (() => void) | undefined
  const engine = createInstance()
  // All resources are static. Only textContent/safe attributes consume output, so HTML escaping here would double-encode it.
  void engine.init({ lng: locale, fallbackLng: 'zh-CN', supportedLngs: ['zh-CN', 'en'], load: 'currentOnly', initAsync: false,
    keySeparator: false, resources: { 'zh-CN': { translation: zh }, en: { translation: en } }, interpolation: { escapeValue: false } })
  const bindings = new Map<WeakRef<HTMLElement>, Binding>(), byNode = new WeakMap<HTMLElement, Binding>()
  const write = (node: HTMLElement, name: string, read: () => string) => { const value = read(); if (name === 'text') { if (node.textContent !== value) node.textContent = value } else if (node.getAttribute(name) !== value) node.setAttribute(name, value) }
  const bind = (node: HTMLElement, name: string, read: () => string) => {
    if (closed) return
    write(node, name, read)
    if (staticSource) return
    let binding = byNode.get(node)
    if (!binding) { const reference = new WeakRef(node); binding = { node: reference, attributes: new Map() }; byNode.set(node, binding); bindings.set(reference, binding) }
    binding.attributes.set(name, read)
  }
  const refresh = () => {
    for (const [reference, binding] of bindings) {
      const node = reference.deref()
      if (!node) { bindings.delete(reference); continue }
      for (const [name, read] of binding.attributes) { try { write(node, name, read) } catch { /* One display callback cannot affect other labels or application work. */ } }
    }
  }
  const readSource = () => {
    if (closed || !source) return
    try {
      const next = resolveClaudeLocale(source.current().preferredLocale)
      if (next === locale) return
      locale = next; revision++; void engine.changeLanguage(locale); refresh()
    } catch { /* Last accepted language remains usable if the preference source fails. */ }
  }
  // Subscribe before the first read so a synchronous source change cannot be lost.
  try { unsubscribe = source?.subscribe(readSource) } catch { /* Optional source failure never blocks the app. */ }
  readSource()
  const t = <K extends MessageKey>(key: K, ...[values]: Arguments<K>): string => engine.t(key, values)
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Record<string, Attribute> = {}, ...children: Child[]): HTMLElementTagNameMap[K] => {
    const node = el(tag)
    for (const [name, value] of Object.entries(attributes)) {
      if (typeof value === 'function') bind(node, name, value)
      else if (value !== undefined && value !== false) { if (name === 'text') node.textContent = String(value); else node.setAttribute(name === 'class' ? 'class' : name, value === true ? '' : value) }
    }
    for (const child of children) {
      if (typeof child === 'function') { const span = el('span'); bind(span, 'text', child); node.append(span) }
      else if (child) node.append(child)
    }
    return node
  }
  return { t, element, bind, get locale() { return locale }, get revision() { return revision },
    number(value: number, options?: Intl.NumberFormatOptions) { return new Intl.NumberFormat(locale, options).format(value) },
    money(value: number, digits = value < 0.01 && value > 0 ? 4 : 2) { return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value) },
    relative(value: number, unit: Intl.RelativeTimeFormatUnit) { return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(value, unit) },
    date(value: number) { return new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(value) },
    /** Prune only explicitly registered nodes after normal rendering; no DOM translation scan. */
    retain(root: HTMLElement) { for (const [reference] of bindings) { const node = reference.deref(); let parent = node; while (parent && parent !== root) parent = parent.parentElement ?? undefined; if (!node || !parent) { bindings.delete(reference); if (node) byNode.delete(node) } } },
    dispose() { if (closed) return; closed = true; try { unsubscribe?.() } catch { /* Source teardown is isolated from application teardown. */ } bindings.clear() },
  }
}
export type ClaudeI18n = ReturnType<typeof createClaudeI18n>
/** Immutable source-language rendering for legacy helper consumers, with no source subscription or retained bindings. */
export const sourceI18n = createClaudeI18n(undefined, true)

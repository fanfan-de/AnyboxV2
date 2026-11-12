import type { ApplicationLocaleContext } from '@anybox/application-api/web'

export type HostLocalePreference = 'system' | 'zh-CN' | 'en'
export type HostLocale = Exclude<HostLocalePreference, 'system'>
export const localePreferenceStorageKey = 'anybox.preferences.locale.v1'
const preference = (value: unknown): HostLocalePreference => value === 'zh-CN' || value === 'en' ? value : 'system'

/** Match supported languages without claiming to provide a Traditional Chinese translation. */
export function resolveHostLocale(languages: readonly string[]): HostLocale {
  for (const language of languages) {
    try {
      const locale = new Intl.Locale(language)
      if (locale.language === 'en') return 'en'
      if (locale.language === 'zh' && locale.script !== 'Hant' && (!locale.region || locale.region === 'CN' || locale.region === 'SG' || locale.script === 'Hans')) return 'zh-CN'
    } catch { /* Unknown system language entries do not prevent subsequent matches. */ }
  }
  return 'zh-CN'
}

export interface HostLocaleOptions {
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'>
  readonly languages: () => readonly string[]
  readonly onStorage?: (listener: (value: string | null) => void) => () => void
  readonly onLanguageChange?: (listener: () => void) => () => void
}

/** Owns only the shell preference; no application resources or lifecycle controls are accepted. */
export function createHostLocale(options: HostLocaleOptions) {
  let selected: HostLocalePreference = 'system', disposed = false
  try { selected = preference(options.storage?.getItem(localePreferenceStorageKey)) } catch { /* Session preference remains usable. */ }
  const resolve = (): HostLocale => {
    if (selected !== 'system') return selected
    try { return resolveHostLocale(options.languages()) } catch { return snapshot?.preferredLocale ?? 'zh-CN' }
  }
  let snapshot: Readonly<{ preferredLocale: HostLocale; revision: number }> | undefined
  snapshot = Object.freeze({ preferredLocale: resolve(), revision: 0 })
  const listeners = new Set<() => void>(), cleanups: (() => void)[] = []
  const update = (next: HostLocalePreference) => {
    if (disposed) return
    const changed = selected !== next
    selected = next
    const locale = resolve()
    if (!changed && locale === snapshot!.preferredLocale) return
    snapshot = Object.freeze({ preferredLocale: locale, revision: snapshot!.revision + 1 })
    for (const listener of [...listeners]) {
      if (disposed) break
      if (listeners.has(listener)) try { listener() } catch { /* One consumer cannot prevent other presentations updating. */ }
    }
  }
  const context: ApplicationLocaleContext = Object.freeze({
    current: () => snapshot!,
    subscribe(listener: () => void) {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  })
  try {
    const cleanup = options.onStorage?.(value => {
      if (disposed) return
      // Storage events can arrive after a newer write from this or another window.
      // The current durable value, rather than the queued event payload, is authoritative.
      try { update(preference(options.storage ? options.storage.getItem(localePreferenceStorageKey) : value)) }
      catch { /* Keep the last usable preference if the source becomes unreadable. */ }
    })
    if (cleanup) cleanups.push(cleanup)
  } catch { /* Optional external source. */ }
  try { const cleanup = options.onLanguageChange?.(() => { if (selected === 'system') update(selected) }); if (cleanup) cleanups.push(cleanup) } catch { /* Optional external source. */ }
  return {
    context,
    preference: () => selected,
    setPreference(value: HostLocalePreference) {
      if (disposed) return
      const next = preference(value)
      try { options.storage?.setItem(localePreferenceStorageKey, next) } catch { /* Keep the explicit choice for this page. */ }
      update(next)
    },
    dispose() {
      if (disposed) return
      disposed = true; listeners.clear()
      for (const cleanup of cleanups.splice(0)) try { cleanup() } catch { /* Continue releasing the remaining subscriptions. */ }
    },
  }
}

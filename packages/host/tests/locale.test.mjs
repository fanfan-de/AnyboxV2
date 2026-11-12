import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHostLocale, localePreferenceStorageKey, resolveHostLocale } from '../dist/web/locale.js'
import { createHostI18n } from '../dist/web/i18n.js'

function fixture(input = {}) {
  const values = new Map(input.saved === undefined ? [] : [[localePreferenceStorageKey, input.saved]])
  const writes = []
  let languages = input.languages ?? ['zh-CN'], readFailed = input.readFailed, storageListener, languageListener, storageReleased = 0, languageReleased = 0
  const locale = createHostLocale({
    storage: {
      getItem(key) { if (readFailed) throw Error('storage unavailable'); return values.get(key) ?? null },
      setItem(key, value) { if (input.writeFailed) throw Error('storage unavailable'); writes.push([key, value]); values.set(key, value) },
    },
    languages() { if (languages instanceof Error) throw languages; return languages },
    onStorage(listener) { storageListener = listener; return () => { storageReleased++ } },
    onLanguageChange(listener) { languageListener = listener; return () => { languageReleased++ } },
  })
  return {
    locale, writes, values,
    storage(value) { if (value === null) values.delete(localePreferenceStorageKey); else values.set(localePreferenceStorageKey, value); storageListener(value) },
    failReads(value = true) { readFailed = value },
    system(value) { languages = value; languageListener() },
    released: () => ({ storage: storageReleased, language: languageReleased }),
  }
}

test('system language resolution respects preference order and falls back to the source language', () => {
  for (const languages of [[], ['fr-FR'], ['zh-CN'], ['zh-Hans'], ['zh-Hans-SG']]) assert.equal(resolveHostLocale(languages), 'zh-CN')
  assert.equal(resolveHostLocale(['fr-FR', 'en-GB', 'zh-CN']), 'en')
  assert.equal(resolveHostLocale(['zh-CN', 'en-US']), 'zh-CN')
  assert.equal(resolveHostLocale(['en-US']), 'en')
  assert.equal(resolveHostLocale(['not a locale', 'en']), 'en')
})

test('a saved explicit preference wins over system languages without rewriting storage on startup', () => {
  const f = fixture({ saved: 'en', languages: ['zh-CN'] })
  assert.equal(f.locale.preference(), 'en')
  assert.equal(f.locale.context.current().preferredLocale, 'en')
  assert.deepEqual(f.writes, [])
  f.locale.dispose()
})

test('missing and malformed saved values choose system while keeping the resolved locale deterministic', () => {
  for (const saved of [undefined, '', 'fr', '{"locale":"en"}', 'EN']) {
    const f = fixture({ saved, languages: ['en-US'] })
    assert.equal(f.locale.preference(), 'system')
    assert.equal(f.locale.context.current().preferredLocale, 'en')
    assert.deepEqual(f.writes, [])
    f.locale.dispose()
  }
})

test('the public context exposes frozen read-only snapshots and local preference changes notify once', () => {
  const f = fixture()
  const before = f.locale.context.current(), updates = []
  assert.equal(Object.isFrozen(f.locale.context), true)
  assert.equal(Object.isFrozen(before), true)
  assert.equal('setPreference' in f.locale.context, false)
  assert.throws(() => { before.preferredLocale = 'en' }, TypeError)
  const unsubscribe = f.locale.context.subscribe(() => updates.push(f.locale.context.current()))
  f.locale.setPreference('en')
  assert.equal(f.locale.preference(), 'en')
  assert.equal(updates.length, 1)
  assert.equal(updates[0].preferredLocale, 'en')
  assert.equal(updates[0].revision, before.revision + 1)
  assert.equal(before.preferredLocale, 'zh-CN', 'previous snapshots never mutate')
  assert.deepEqual(f.writes, [[localePreferenceStorageKey, 'en']])
  f.locale.setPreference('en')
  assert.equal(updates.length, 1, 'repeating the selected preference is not a language update')
  unsubscribe()
  f.locale.setPreference('zh-CN')
  assert.equal(updates.length, 1)
  f.locale.dispose()
})

test('a preference change is observed even when its effective language is unchanged', () => {
  const f = fixture({ languages: ['en-US'] }), updates = []
  const before = f.locale.context.current()
  f.locale.context.subscribe(() => updates.push(f.locale.context.current()))
  f.locale.setPreference('en')
  assert.equal(updates.length, 1)
  assert.equal(updates[0].preferredLocale, 'en')
  assert.equal(updates[0].revision, before.revision + 1)
  f.locale.dispose()
})

test('system changes affect only system preference and storage changes never write back to another window', () => {
  const f = fixture(), updates = []
  f.locale.context.subscribe(() => updates.push(f.locale.context.current().preferredLocale))
  f.system(['en-US'])
  assert.deepEqual(updates, ['en'])
  f.locale.setPreference('zh-CN')
  const writes = f.writes.length
  f.system(['en-GB'])
  assert.deepEqual(updates, ['en', 'zh-CN'])
  f.storage('en')
  assert.equal(f.locale.preference(), 'en')
  assert.equal(f.locale.context.current().preferredLocale, 'en')
  f.storage(null)
  assert.equal(f.locale.preference(), 'system')
  assert.equal(f.locale.context.current().preferredLocale, 'en')
  assert.equal(f.writes.length, writes, 'storage event synchronization cannot produce write loops')
  f.locale.dispose()
})

test('unavailable preference storage leaves in-memory choice and listener delivery usable', () => {
  const f = fixture({ readFailed: true, writeFailed: true }), updates = []
  f.locale.context.subscribe(() => updates.push(f.locale.context.current().preferredLocale))
  assert.equal(f.locale.preference(), 'system')
  f.locale.setPreference('en')
  assert.equal(f.locale.preference(), 'en')
  assert.deepEqual(updates, ['en'])
  f.locale.dispose()
})

test('queued cross-window events cannot overwrite a newer explicit choice with an obsolete event value', () => {
  const values = new Map(), listeners = {}, writes = []
  const storage = { getItem: key => values.get(key) ?? null, setItem(key, value) { values.set(key, value); writes.push(value) } }
  const first = createHostLocale({ storage, languages: () => ['zh-CN'], onStorage(listener) { listeners.first = listener; return () => {} } })
  const second = createHostLocale({ storage, languages: () => ['zh-CN'], onStorage(listener) { listeners.second = listener; return () => {} } })
  first.setPreference('en')
  // Before the queued English event reaches the second window, its user chooses Chinese.
  second.setPreference('zh-CN')
  assert.equal(values.get(localePreferenceStorageKey), 'zh-CN')
  listeners.second('en')
  listeners.first('zh-CN')
  assert.equal(first.preference(), 'zh-CN')
  assert.equal(second.preference(), 'zh-CN')
  assert.equal(first.context.current().preferredLocale, 'zh-CN')
  assert.equal(second.context.current().preferredLocale, 'zh-CN')
  assert.deepEqual(writes, ['en', 'zh-CN'], 'delivery only reads current storage, without writing an old event back')
  first.dispose(); second.dispose()
})

test('failed cross-window storage reads preserve the last accepted preference and language', () => {
  const f = fixture({ saved: 'en' }), before = f.locale.context.current(), updates = []
  f.locale.context.subscribe(() => updates.push(f.locale.context.current()))
  f.failReads()
  f.storage('zh-CN')
  assert.equal(f.locale.preference(), 'en')
  assert.deepEqual(f.locale.context.current(), before)
  assert.deepEqual(updates, [])
  f.failReads(false)
  f.storage('zh-CN')
  assert.equal(f.locale.context.current().preferredLocale, 'zh-CN')
  f.locale.dispose()
})

test('system probing failures retain the last accepted language and never close preference admission', () => {
  const f = fixture({ saved: 'en' })
  f.system(Error('system unavailable'))
  f.locale.setPreference('system')
  assert.equal(f.locale.context.current().preferredLocale, 'en')
  f.system(['zh-CN'])
  assert.equal(f.locale.context.current().preferredLocale, 'zh-CN')
  f.locale.dispose()
  const missing = fixture({ languages: Error('initial probe unavailable') })
  assert.equal(missing.locale.context.current().preferredLocale, 'zh-CN')
  missing.locale.dispose()
})

test('one failed application listener cannot prevent other mounted applications from receiving the update', () => {
  const f = fixture(), updates = []
  f.locale.context.subscribe(() => { throw Error('application callback failed') })
  f.locale.context.subscribe(() => updates.push(f.locale.context.current().preferredLocale))
  assert.doesNotThrow(() => f.locale.setPreference('en'))
  assert.deepEqual(updates, ['en'])
  f.locale.dispose()
})

test('a failed event source setup is optional and disposal prevents late source callbacks or DOM events from publishing', () => {
  const standalone = createHostLocale({ languages: () => ['en'], onStorage() { throw Error('source unavailable') }, onLanguageChange() { throw Error('source unavailable') } })
  assert.equal(standalone.context.current().preferredLocale, 'en')
  standalone.setPreference('zh-CN')
  assert.equal(standalone.context.current().preferredLocale, 'zh-CN')
  standalone.dispose()

  const f = fixture(), updates = []
  f.locale.context.subscribe(() => updates.push(f.locale.context.current()))
  const before = f.locale.context.current()
  f.locale.dispose(); f.locale.dispose()
  f.locale.context.subscribe(() => { throw Error('closed subscription invoked') })
  f.locale.setPreference('en'); f.storage('en'); f.system(['en'])
  assert.deepEqual(f.locale.context.current(), before)
  assert.deepEqual(updates, [])
  assert.deepEqual(f.released(), { storage: 1, language: 1 })
})

test('independent shell translators preserve locale ownership, English plurals and literal dynamic text', () => {
  let firstLocale = 'zh-CN', secondLocale = 'en'
  const first = createHostI18n(() => firstLocale), second = createHostI18n(() => secondLocale)
  assert.equal(first('applications'), '应用')
  assert.equal(second('applications'), 'Apps')
  assert.equal(second('optional', { count: 0 }), '0 optional capabilities unavailable')
  assert.equal(second('optional', { count: 1 }), '1 optional capability unavailable')
  assert.equal(second('optional', { count: 2 }), '2 optional capabilities unavailable')
  const name = '<>&"\' 应用'
  assert.equal(second('openNamed', { name }), `Open ${name}`, 'DOM text setters receive raw text, without HTML encoding')
  firstLocale = 'en'
  assert.equal(first('applications'), 'Apps')
  secondLocale = 'zh-CN'
  assert.equal(second('applications'), '应用')
  assert.equal(first('applications'), 'Apps', 'changing another translator never mutates this instance')
})

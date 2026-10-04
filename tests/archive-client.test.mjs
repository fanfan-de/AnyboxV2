import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createArchiveIndex, setupArchivePanel } from '../dist/applications/harness/web/archive-client.js'
import { deferred } from './helpers/controlled-models.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const session = id => ({ id, projectId: 'project', archivedAt: '2026-10-02T00:00:00.000Z' })

// Only the tree, events and focus operations used by the archive settings section.
function archiveFixture(t, { restore = async () => {}, view = () => {} } = {}) {
  const document = { activeElement: undefined }
  class Element extends EventTarget {
    children = []; dataset = {}; attributes = {}; hidden = false; disabled = false; textContent = ''; className = ''
    constructor(tagName) { super(); this.tagName = tagName }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child) } }
    replaceChildren(...children) { for (const child of this.children) child.parentElement = undefined; this.children = []; this.append(...children) }
    contains(node) { return node === this || this.children.some(child => child.contains(node)) }
    setAttribute(name, value) { this.attributes[name] = value }
    querySelectorAll(selector) {
      const matches = node => selector.startsWith('#') ? node.id === selector.slice(1)
        : selector.startsWith('.') ? node.className === selector.slice(1)
        : selector.startsWith('[data-') ? selector.slice(6, -1).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()) in node.dataset
        : node.tagName === selector
      return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)])
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
    focus() { document.activeElement = this }
    click() { if (!this.disabled) this.dispatchEvent(new Event('click')) }
  }
  document.createElement = tag => new Element(tag)
  const root = new Element('div'), dialog = new Element('dialog'), section = new Element('section')
  const list = new Element('div'), status = new Element('p'), retry = new Element('button'), requests = []
  dialog.id = 'agent--settings-dialog'; dialog.open = false; dialog.close = () => { dialog.open = false }
  section.id = 'agent--archive-settings'; section.hidden = true
  list.className = 'archive-list'; status.dataset.archiveStatus = ''; retry.dataset.archiveRefresh = ''
  section.append(status, retry, list); dialog.append(section); root.append(dialog)
  const previousDocument = globalThis.document; globalThis.document = document
  const panel = setupArchivePanel((url, body, signal) => {
    const job = deferred(); requests.push({ url, body, signal, job }); return job.promise
  }, error => error.message, { root, projects: () => [{ id: 'project', name: 'Project', harnessName: 'Device' }], view, restore })
  t.after(() => { panel.dispose(); if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument })
  return { document, dialog, section, list, status, retry, requests, panel,
    button: (action, id) => list.querySelectorAll('button').find(button => button.dataset[action] === id),
    async show(sessions = [session('first')]) {
      dialog.open = true; section.hidden = false; panel.activate()
      requests.at(-1).job.resolve(sessions); await tick()
    },
  }
}

test('archive refresh ignores stale responses, retains failures for retry, and joins disposal by aborting reads', async () => {
  const calls = []; let updates = 0
  const index = createArchiveIndex((url, body, signal) => {
    const job = deferred(); calls.push({ url, signal, job }); return job.promise
  }, () => { updates++ })
  const first = index.load(), second = index.load()
  assert.equal(calls[0].signal.aborted, true)
  assert.equal(calls[1].url, '/sessions/archived')
  calls[1].job.resolve([{ id: 'fresh' }]); await second
  calls[0].job.resolve([{ id: 'old' }]); await first
  assert.deepEqual(index.snapshot().sessions, [{ id: 'fresh' }])
  const failing = index.load(), error = new Error('offline')
  calls[2].job.reject(error); await failing
  assert.equal(index.snapshot().error, error)
  assert.deepEqual(index.snapshot().sessions, [{ id: 'fresh' }])
  const retry = index.load(); calls[3].job.resolve([]); await retry
  assert.equal(index.snapshot().error, undefined)
  assert.deepEqual(index.snapshot().sessions, [])
  const last = index.load(), count = updates
  index.dispose(); assert.equal(calls[4].signal.aborted, true)
  calls[4].job.resolve([{ id: 'late' }]); await last
  assert.equal(updates, count)
})

test('archive settings reads only while its category is visible and disposal leaves shared settings open', async t => {
  const f = archiveFixture(t)
  f.panel.activate(); f.panel.refresh()
  f.dialog.open = true; f.panel.activate(); f.panel.refresh()
  assert.equal(f.requests.length, 0)
  await f.show()
  assert.equal(f.requests[0].url, '/sessions/archived')
  assert.equal(f.list.children.length, 1)
  assert.equal(f.list.children[0].children[0].children[0].textContent, 'Device · Project · 会话 first')
  f.section.hidden = true; f.panel.activate(); f.panel.refresh()
  f.section.hidden = false; f.dialog.open = false; f.panel.activate(); f.panel.refresh()
  assert.equal(f.requests.length, 1)
  f.dialog.open = true; f.panel.refresh()
  assert.equal(f.requests.length, 2)
  assert.equal(f.list.attributes['aria-busy'], 'true')
  const contents = f.list.children, status = f.status.textContent
  f.panel.dispose()
  assert.equal(f.requests[1].signal.aborted, true)
  assert.equal(f.dialog.open, true)
  f.requests[1].job.resolve([session('late')]); await tick()
  assert.equal(f.list.children, contents)
  assert.equal(f.status.textContent, status)
  f.retry.click(); f.panel.activate(); f.panel.refresh()
  assert.equal(f.requests.length, 2)
})

test('viewing an archived session closes settings before opening its workspace', async t => {
  const viewed = []
  const f = archiveFixture(t, { view: value => viewed.push({ value, settingsOpen: f.dialog.open }) })
  const archived = session('first'); await f.show([archived])
  f.button('archiveView', archived.id).click()
  assert.deepEqual(viewed, [{ value: archived, settingsOpen: false }])
  assert.equal(f.requests.length, 1)
})

test('archive restore deduplicates clicks, refreshes the list and returns focus to its settings controls', async t => {
  const restore = deferred(), restored = []
  const f = archiveFixture(t, { restore: value => { restored.push(value); return restore.promise } })
  const archived = session('first'); await f.show([archived])
  const originalButton = f.button('archiveRestore', archived.id)
  originalButton.focus(); originalButton.click()
  const pendingButton = f.button('archiveRestore', archived.id)
  assert.equal(pendingButton.disabled, true)
  assert.equal(f.document.activeElement, pendingButton)
  // A stale node or a synthetic event must not submit a second restore.
  originalButton.click(); pendingButton.dispatchEvent(new Event('click'))
  assert.deepEqual(restored, [archived])
  restore.resolve(); await tick()
  assert.equal(f.requests.length, 2)
  f.requests[1].job.resolve([]); await tick()
  assert.equal(f.list.children.length, 0)
  assert.equal(f.status.textContent, '还没有已归档会话')
  assert.equal(f.document.activeElement, f.retry)
  assert.equal(f.dialog.open, true)
})

test('archive settings keeps failed restores retryable and clears action and read errors on retry', async t => {
  const restore = deferred()
  const f = archiveFixture(t, { restore: () => restore.promise })
  const archived = session('first'); await f.show([archived])
  f.button('archiveRestore', archived.id).focus(); f.button('archiveRestore', archived.id).click()
  restore.reject(new Error('restore offline')); await tick()
  const button = f.button('archiveRestore', archived.id)
  assert.equal(button.disabled, false)
  assert.equal(f.document.activeElement, button)
  assert.equal(f.status.textContent, 'restore offline')
  f.retry.click()
  assert.equal(f.status.textContent, '正在读取已归档会话…')
  f.requests[1].job.reject(new Error('read offline')); await tick()
  assert.equal(f.status.textContent, 'read offline')
  assert.equal(f.list.children.length, 1)
  f.retry.click(); f.requests[2].job.resolve([archived]); await tick()
  assert.equal(f.status.textContent, '')
  assert.equal(f.button('archiveRestore', archived.id).disabled, false)
})

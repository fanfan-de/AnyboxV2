import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFileSidebar, restoreFileSidebarSessionState } from '../dist/applications/harness/web/file-sidebar.js'
import { createFileView } from '../dist/applications/harness/web/file-view.js'
import { sameFileReference } from '../dist/applications/harness/web/session-client.js'
import { deferred } from './helpers/controlled-models.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const ref = sessionId => ({ sessionId, projectId: `p-${sessionId}` })
const file = { snapshotId: 'snapshot', projectId: 'p-a', path: 'src/a.ts', actualRange: { start: 1, end: 2 }, byteLength: 8,
  sha256: 'a'.repeat(64), createdAt: '2026-10-02T00:00:00.000Z' }
const preview = (selection, text = '<script>plain text</script>') => ({ path: selection.path, text, totalLines: 2, sourceByteLength: 8, byteLength: 8, actualRange: selection.range ?? { start: 1, end: 2 }, canReference: true })

// This fixture implements only the DOM operations used by the sidebar, including event bubbling.
function documentFixture() {
  const document = { activeElement: undefined }
  const match = (node, selector) => selector.startsWith('#') ? node.id === selector.slice(1)
    : selector.startsWith('.') ? node.className.split(/\s+/).includes(selector.slice(1))
    : selector.startsWith('[data-') ? selector.slice(6, -1).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()) in node.dataset
    : node.tagName === selector.toLowerCase()
  const createElement = tagName => {
    let ownText = ''
    const node = {
      ownerDocument: document, tagName, className: '', dataset: {}, children: [], parentElement: undefined,
      attributes: {}, listeners: new Map(), style: { setProperty() {} }, scrollTop: 0, scrollLeft: 0, value: '', hidden: false, disabled: false,
      classList: { toggle(name, force) { const values = new Set(node.className.split(/\s+/).filter(Boolean)); if (force ?? !values.has(name)) values.add(name); else values.delete(name); node.className = [...values].join(' ') }, contains(name) { return node.className.split(/\s+/).includes(name) } },
      setAttribute(name, value) { this.attributes[name] = value }, getAttribute(name) { return this.attributes[name] }, removeAttribute(name) { delete this.attributes[name] },
      append(...children) { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child) } },
      prepend(child) { child.remove(); child.parentElement = this; this.children.unshift(child) },
      insertBefore(child, target) { child.remove(); const index = this.children.indexOf(target); child.parentElement = this; if (index < 0) this.children.push(child); else this.children.splice(index, 0, child) },
      replaceChildren(...children) { for (const child of this.children) child.parentElement = undefined; this.children = []; ownText = ''; this.append(...children) },
      remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = undefined },
      contains(child) { return child === this || this.children.some(node => node.contains(child)) },
      closest(selector) { return match(this, selector) ? this : this.parentElement?.closest(selector) },
      querySelectorAll(selector) { return this.children.flatMap(child => [...(match(child, selector) ? [child] : []), ...child.querySelectorAll(selector)]) },
      querySelector(selector) { return this.querySelectorAll(selector)[0] },
      addEventListener(type, callback, options) { const list = this.listeners.get(type) ?? []; list.push({ callback, signal: options?.signal }); this.listeners.set(type, list) },
      dispatch(type, extra = {}) { const event = { type, target: this, preventDefault() {}, ...extra }; for (let current = this; current; current = current.parentElement) for (const listener of current.listeners.get(type) ?? []) if (!listener.signal?.aborted) listener.callback(event) },
      click() { if (!this.disabled) this.dispatch('click') }, focus() { document.activeElement = this },
    }
    Object.defineProperty(node, 'textContent', { get: () => ownText + node.children.map(child => child.textContent).join(''), set(value) { ownText = String(value); for (const child of node.children) child.parentElement = undefined; node.children = [] } })
    return node
  }
  document.createElement = createElement
  return { document, container: createElement('div') }
}
function fixture({ read, treeApi, session = {} } = {}) {
  const dom = documentFixture(), changed = [], requests = [], applied = [], treeRequests = []
  const state = { session: { id: 'a', projectId: 'p-a', historyMode: 'native-local-v1', ...session }, position: { viewNodeId: null }, draft: '', files: [], loading: false, busy: false }
  const controller = {
    snapshot: () => state,
    previewFile(selection, signal) { requests.push({ selection, signal }); return read ? read(selection, signal) : Promise.resolve(preview(selection)) },
    readFile(id, signal) { requests.push({ id, signal }); return read ? read(id, signal) : Promise.resolve({ file, text: 'immutable bytes' }) },
    applyFileReference(input) {
      applied.push(input)
      if (input.parentNodeId !== state.position.viewNodeId || (input.expectedItem && !sameFileReference(state.files.find(item => item.id === input.item.id), input.expectedItem))) return false
      const previous = state.files.some(item => item.id === input.item.id)
      state.files = previous ? state.files.map(item => item.id === input.item.id ? input.item : item) : [...state.files, input.item]
      return true
    },
  }
  const sidebar = createFileSidebar(dom.container, { api: async (url, body, signal) => {
    treeRequests.push({ url, body, signal })
    if (treeApi) return treeApi(url, body, signal)
    if (url.endsWith('/open')) return { cursorId: 'tree', page: 0, path: body.path, entries: [], nextPage: null }
  }, messageFor: error => error.message, changed: (sessionId, value) => changed.push({ sessionId, value: JSON.parse(JSON.stringify(value)) }) })
  sidebar.setSession(ref('a'), controller)
  return { ...dom, sidebar, controller, state, changed, requests, applied, treeRequests,
    open: (kind, item, extra = {}) => sidebar.open({ ref: ref('a'), parentNodeId: state.position.viewNodeId, kind, item, ...extra }) }
}

test('persistent descriptors separate snapshot purposes, normalize selection and contain no preview text', () => {
  const raw = { tabs: ['history', 'draft'].map(kind => ({ id: 'ignored', kind, parentNodeId: null, item: { id: kind, file, selection: { kind: 'snapshot', snapshotId: file.snapshotId } }, scrollTop: 4, scrollLeft: 2, text: 'must not persist' })), activeTabId: 'missing', treeExpanded: ['src', 'src', '../unsafe'], treeScroll: NaN }
  const state = restoreFileSidebarSessionState(raw)
  assert.equal(state.tabs.length, 2); assert.notEqual(state.tabs[0].id, state.tabs[1].id)
  assert.deepEqual(state.treeExpanded, ['src']); assert.equal(state.treeScroll, 0)
  assert.equal(JSON.stringify(state).includes('must not persist'), false)
  assert.equal(restoreFileSidebarSessionState({ tabs: [{ kind: 'current', parentNodeId: 7 }] }).tabs.length, 0)
})

test('composer history and draft previews never capture an unrelated active mention', async t => {
  const previousDocument = globalThis.document, dom = documentFixture(), requests = []
  globalThis.document = dom.document
  t.mock.method(globalThis, 'setTimeout', callback => { queueMicrotask(callback); return 0 })
  const compose = dom.document.createElement('form'), input = dom.document.createElement('textarea'), actions = dom.document.createElement('div')
  actions.className = 'actions'; compose.append(input, actions); dom.container.append(compose)
  const original = { id: 'draft', file, selection: { kind: 'snapshot', snapshotId: file.snapshotId } }
  const state = { session: { id: 'a', historyMode: 'native-local-v1' }, position: { viewNodeId: null }, files: [original], loading: false, busy: false }
  const controller = { snapshot: () => state, searchFiles: async () => ({ paths: ['src/a.ts'], incomplete: false }), fileMessage: error => error.message, setFiles() {} }
  const view = createFileView(compose, input, controller, ref('a'), request => requests.push(request))
  try {
    view.render(state)
    const mention = () => { input.value = '@src'; input.selectionStart = 4; input.dispatch('input') }
    mention(); compose.append(view.snapshotButton(file)); compose.children.at(-1).click()
    assert.equal(requests.at(-1).kind, 'history'); assert.equal(requests.at(-1).mention, undefined)
    mention(); compose.querySelector('.draft-file').querySelector('button').click()
    assert.equal(requests.at(-1).kind, 'draft'); assert.equal(requests.at(-1).mention, undefined)
    mention(); await tick()
    view.keydown({ key: 'Enter', isComposing: false, preventDefault() {} })
    assert.equal(requests.at(-1).kind, 'current')
    assert.deepEqual(requests.at(-1).mention, { start: 0, end: 4, text: '@src' })
  } finally {
    view.dispose()
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
})

test('same current file deduplicates, snapshot purposes stay separate, and closing the active tab returns focus', async () => {
  const f = fixture()
  try {
    f.open('current', { id: 'first', selection: { kind: 'project-file', path: 'src/a.ts' } })
    f.open('current', { id: 'second', selection: { kind: 'project-file', path: 'src/a.ts' } })
    const original = { id: 'draft', file, selection: { kind: 'snapshot', snapshotId: file.snapshotId } }
    f.state.files = [original]; f.open('history', original); f.open('draft', original)
    await tick(); assert.equal(f.sidebar.snapshot().tabs.length, 3)
    const tabs = f.container.querySelectorAll('.file-tab')
    f.container.querySelectorAll('.file-tab-close').at(-1).click()
    await tick()
    assert.equal(f.sidebar.snapshot().tabs.length, 2)
    assert.equal(f.document.activeElement.getAttribute('aria-selected'), 'true')
    assert.equal(f.container.querySelector('.file-preview-text').textContent, 'immutable bytes')
    assert.equal(tabs.length, 3)
  } finally { await f.sidebar.dispose() }
})

test('tree and draft current-file previews deduplicate by path and replace the captured reference target', async () => {
  const f = fixture(), path = 'src/a.ts'
  try {
    f.open('current', { id: 'tree', selection: { kind: 'project-file', path } }); await tick()
    f.state.position = { viewNodeId: 'draft-parent' }
    const original = { id: 'chip', selection: { kind: 'project-file', path, range: { start: 1, end: 2 } } }
    f.state.files = [original]; f.open('draft', original); await tick()
    let tabs = f.sidebar.snapshot().tabs
    assert.equal(tabs.length, 1); assert.equal(tabs[0].kind, 'draft')
    assert.equal(tabs[0].parentNodeId, 'draft-parent'); assert.equal(tabs[0].item.id, 'chip')
    f.container.querySelector('.file-preview-actions').children.at(-1).click()
    assert.equal(f.applied.at(-1).parentNodeId, 'draft-parent')
    assert.equal(f.applied.at(-1).item.id, 'chip'); assert.deepEqual(f.applied.at(-1).expectedItem, original)
    f.state.position = { viewNodeId: 'tree-parent' }
    f.open('current', { id: 'new-tree', selection: { kind: 'project-file', path } }); await tick()
    tabs = f.sidebar.snapshot().tabs
    assert.equal(tabs.length, 1); assert.equal(tabs[0].kind, 'current')
    assert.equal(tabs[0].parentNodeId, 'tree-parent'); assert.equal(tabs[0].item.id, 'new-tree')
    f.container.querySelector('.file-preview-actions').children.at(-1).click()
    assert.equal(f.applied.at(-1).parentNodeId, 'tree-parent'); assert.equal(f.applied.at(-1).expectedItem, undefined)
    f.sidebar.setSession(undefined, undefined)
    assert.equal(f.container.querySelector('.file-tree-status').textContent, '选择一个会话以浏览项目文件')
  } finally { await f.sidebar.dispose() }
})

test('clearing a range previews and references the whole file, and current-file actions target the parent at click', async () => {
  const f = fixture()
  try {
    f.open('current', { id: 'range', selection: { kind: 'project-file', path: 'src/a.ts', range: { start: 1, end: 2 } } })
    await tick()
    const range = f.container.querySelector('.file-preview-range'), [start, end] = range.querySelectorAll('input')
    start.value = '1'; start.dispatch('input'); end.value = '1'; end.dispatch('input'); range.querySelector('button').click()
    await tick()
    assert.equal(f.container.querySelector('.file-tab').textContent, 'src/a.ts · L1–1')
    assert.match(f.container.querySelector('.file-tab').title, /L1–1/)
    assert.match(f.container.querySelector('.file-tab-close').getAttribute('aria-label'), /L1–1/)
    assert.equal(f.container.querySelector('.file-preview-heading').textContent, 'src/a.ts · L1–1')
    assert.match(f.container.querySelector('.file-preview-text').getAttribute('aria-label'), /L1–1/)
    assert.deepEqual(f.sidebar.snapshot().tabs[0].item.selection.range, { start: 1, end: 2 }, 'display ranges do not rewrite the original chip guard')
    start.value = ''; start.dispatch('input'); end.value = ''; end.dispatch('input'); range.querySelector('button').click()
    await tick()
    assert.deepEqual(f.requests.at(-1).selection, { kind: 'project-file', path: 'src/a.ts' })
    assert.equal(f.container.querySelector('.file-tab').textContent, 'src/a.ts · 整文件')
    assert.equal(f.container.querySelector('.file-preview-heading').textContent, 'src/a.ts · 整文件')
    assert.match(f.container.querySelector('.file-tab-close').getAttribute('aria-label'), /整文件/)
    f.state.position = { viewNodeId: 'next-parent' }; f.sidebar.refresh()
    f.container.querySelector('.file-preview-actions').children.at(-1).click()
    assert.equal(f.applied.at(-1).parentNodeId, 'next-parent')
    assert.deepEqual(f.applied.at(-1).item.selection, { kind: 'project-file', path: 'src/a.ts' })
    assert.equal(f.container.querySelector('.file-preview-text').textContent, '<script>plain text</script>')
  } finally { await f.sidebar.dispose() }
})

test('only an explicit draft update replaces its snapshot and keeps the captured chip identity', async () => {
  const f = fixture(), original = { id: 'original', file, selection: { kind: 'snapshot', snapshotId: file.snapshotId } }
  f.state.files = [original]
  try {
    f.open('draft', original); await tick()
    const actions = f.container.querySelector('.file-preview-actions')
    assert.equal(actions.children[0].textContent, '更新为当前文件')
    actions.children[0].click(); await tick()
    assert.equal(f.applied.length, 1); assert.equal(f.applied[0].item.id, original.id)
    assert.deepEqual(f.applied[0].expectedItem, original)
    assert.deepEqual(f.state.files[0].selection, { kind: 'project-file', path: file.path })
    f.open('history', original); await tick()
    assert.equal(actions.children[0].textContent, '查看当前文件')
    actions.children[0].click(); await tick()
    assert.equal(f.applied.length, 1, 'viewing current bytes from history cannot rewrite the draft or history')
    assert.ok(f.sidebar.snapshot().tabs.some(tab => tab.kind === 'history' && tab.item.selection.kind === 'snapshot'))
  } finally { await f.sidebar.dispose() }
})

const readonlySessions = [
  ['legacy', { historyMode: 'dialogue-v1' }],
  ['archived', { archivedAt: '2026-10-02T00:00:00.000Z' }],
]
for (const [kind, session] of readonlySessions) test(`${kind} conversations browse and preview project files while all draft reference writes stay blocked`, async () => {
  const f = fixture({ session, treeApi(url, body) {
    if (url.endsWith('/close')) return {}
    if (url.endsWith('/open')) return { cursorId: `tree-${body.path || 'root'}`, page: 0, path: body.path, nextPage: null,
      entries: body.path === '' ? [{ name: 'src', path: 'src', kind: 'directory' }] : [{ name: 'a.ts', path: 'src/a.ts', kind: 'file' }] }
    throw Error(`unexpected ${url}`)
  } })
  const original = { id: 'original', file, selection: { kind: 'snapshot', snapshotId: file.snapshotId } }
  f.state.files = [original]
  try {
    await tick()
    f.container.querySelectorAll('.file-tree-entry').find(button => button.dataset.treePath === 'src').click()
    await tick()
    f.container.querySelectorAll('.file-tree-entry').find(button => button.dataset.treePath === 'src/a.ts').click()
    await tick()
    assert.ok(f.treeRequests.some(request => request.url.endsWith('/open') && request.body.path === 'src'))
    assert.deepEqual(f.requests.at(-1).selection, { kind: 'project-file', path: 'src/a.ts' })
    assert.equal(f.container.querySelector('.file-preview-text').textContent, '<script>plain text</script>')
    const range = f.container.querySelector('.file-preview-range'), [start, end] = range.querySelectorAll('input')
    start.value = '1'; start.dispatch('input'); end.value = '1'; end.dispatch('input'); range.querySelector('button').click()
    await tick()
    assert.deepEqual(f.requests.at(-1).selection.range, { start: 1, end: 1 }, 'read-only views can inspect a narrower range')
    const actions = f.container.querySelector('.file-preview-actions')
    assert.equal(actions.children.at(-1).disabled, true)
    actions.children.at(-1).click()
    f.open('draft', original); await tick()
    assert.equal(f.container.querySelector('.file-preview-text').textContent, 'immutable bytes')
    assert.equal(actions.children[0].textContent, '更新为当前文件')
    assert.equal(actions.children[0].disabled, true)
    actions.children[0].click(); actions.children.at(-1).click()
    f.open('history', original); await tick()
    assert.equal(actions.children[0].textContent, '查看当前文件')
    assert.equal(actions.children[0].disabled, false, 'opening current bytes from history is still a read')
    actions.children[0].click(); await tick()
    assert.equal(f.container.querySelector('.file-preview-text').textContent, '<script>plain text</script>')
    assert.ok(f.sidebar.snapshot().tabs.some(tab => tab.kind === 'history' && tab.item.selection.kind === 'snapshot'))
    assert.equal(actions.children.at(-1).disabled, true)
    assert.equal(f.applied.length, 0)
    assert.deepEqual(f.state.files, [original])
  } finally { await f.sidebar.dispose() }
})

test('read-only transitions invalidate old @ confirmation while keeping draft and historical previews accessible', async t => {
  const previousDocument = globalThis.document
  t.mock.method(globalThis, 'setTimeout', callback => { queueMicrotask(callback); return 0 })
  try {
    for (const [kind, session] of readonlySessions) await t.test(kind, async () => {
      const dom = documentFixture(), opened = [], writes = [], searches = []
      globalThis.document = dom.document
      const compose = dom.document.createElement('form'), input = dom.document.createElement('textarea'), actions = dom.document.createElement('div')
      actions.className = 'actions'; compose.append(input, actions); dom.container.append(compose)
      const original = { id: 'original', file, selection: { kind: 'snapshot', snapshotId: file.snapshotId } }
      const state = { session: { id: 'a', historyMode: 'native-local-v1' }, position: { viewNodeId: null }, files: [original], loading: false, busy: false }
      const controller = { snapshot: () => state, searchFiles: async query => { searches.push(query); return { paths: ['src/a.ts'], incomplete: false } },
        fileMessage: error => error.message, setFiles: value => writes.push(value) }
      const view = createFileView(compose, input, controller, ref('a'), request => opened.push(request))
      try {
        view.render(state); input.value = '@src'; input.selectionStart = 4; input.dispatch('input'); await tick()
        const oldCandidate = compose.querySelectorAll('button').find(button => button.getAttribute('role') === 'option')
        assert.ok(oldCandidate)
        state.session = { ...state.session, ...session }; view.render(state)
        assert.equal(compose.querySelector('.attach-files').disabled, true)
        oldCandidate.click()
        assert.equal(view.keydown({ key: 'Enter', isComposing: false, preventDefault() {} }), false)
        input.value = '@readonly'; input.selectionStart = 9; input.dispatch('input'); await tick()
        assert.equal(searches.length, 1)
        assert.equal(opened.length, 0, 'an old candidate cannot confirm after the conversation becomes read-only')
        const chip = compose.querySelector('.draft-file')
        assert.equal(chip.querySelectorAll('button').at(-1).disabled, true)
        chip.querySelectorAll('button').at(-1).click()
        chip.querySelector('button').click()
        assert.equal(opened.at(-1).kind, 'draft'); assert.equal(opened.at(-1).mention, undefined)
        view.snapshotButton(file).click()
        assert.equal(opened.at(-1).kind, 'history'); assert.equal(opened.at(-1).mention, undefined)
        assert.equal(input.value, '@readonly')
        assert.deepEqual(state.files, [original]); assert.deepEqual(writes, [])
      } finally { view.dispose() }
    })
  } finally {
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
})

test('late preview responses cannot replace another tab or session and disposal joins actual read exit', async () => {
  const jobs = [], f = fixture({ read(selection) { const job = deferred(); jobs.push({ selection, job }); return job.promise } })
  const open = path => f.open('current', { id: path, selection: { kind: 'project-file', path } })
  open('a.ts'); open('b.ts'); assert.equal(f.requests[0].signal.aborted, true)
  jobs[1].job.resolve(preview(jobs[1].selection, 'b bytes')); await tick()
  assert.equal(f.container.querySelector('.file-preview-text').textContent, 'b bytes')
  f.sidebar.setSession(ref('b'), { ...f.controller, snapshot: () => ({ ...f.state, session: { ...f.state.session, id: 'b', projectId: 'p-b' } }) })
  assert.equal(f.container.querySelector('.file-preview-text').textContent, '')
  let exited = false; const disposal = f.sidebar.dispose().then(() => { exited = true })
  await tick(); assert.equal(exited, false)
  jobs[0].job.resolve(preview(jobs[0].selection, 'late a bytes')); await disposal
  assert.equal(exited, true)
  assert.equal(f.changed.some(row => row.sessionId === 'b' && row.value.tabs.length), false)
  assert.equal(f.treeRequests.some(row => row.url.endsWith('/cancel')), false)
})

test('a hidden sidebar retains descriptions and joins a late directory cursor before disposal', async () => {
  const opened = deferred(), closed = deferred()
  const f = fixture({ treeApi(url) { if (url.endsWith('/open')) return opened.promise; if (url.endsWith('/close')) return closed.promise } })
  await tick()
  f.sidebar.setVisible(false)
  assert.equal(f.treeRequests[0].signal.aborted, true)
  let exited = false; const disposal = f.sidebar.dispose().then(() => { exited = true })
  opened.resolve({ cursorId: 'late-tree', path: '', page: 0, entries: [], nextPage: 1 }); await tick()
  assert.equal(exited, false)
  assert.deepEqual(f.treeRequests.at(-1).body, { cursorId: 'late-tree' })
  closed.resolve({}); await disposal
})

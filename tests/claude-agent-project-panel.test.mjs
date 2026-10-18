import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProjectPanel } from '../packages/app-claude-agent/dist/web/projects.js'
import { installClaudeAgentDOM } from './helpers/claude-agent-dom.mjs'

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const setup = (t, overrides = {}) => {
  const dom = installClaudeAgentDOM(t), picks = [], selected = [], created = [], errors = [], requests = []
  const panel = createProjectPanel(local => local, {
    request: async (path, signal) => {
      requests.push({ path, signal })
      if (overrides.request) return overrides.request(path, signal)
      if (path.endsWith('/projects/recent')) return { projects: [] }
      throw new Error('unexpected device request')
    },
    select: path => selected.push(path), create: (path, title) => created.push({ path, title }), report: error => errors.push(error),
    pickNative(signal) { const pick = { ...deferred(), signal }; picks.push(pick); return pick.promise },
  })
  dom.container.append(panel.element); panel.setNativePicker(true); panel.setEnabled(true)
  t.after(() => panel.dispose())
  return { ...dom, panel, picks, selected, created, errors, requests, dialog: dom.find('dialog'), newButton: dom.find('.ca-new-thread'), button: dom.find('.ca-pick-native'), input: dom.find('input[name="projectPath"]') }
}

test('new conversation opens an on-demand project dialog and restores focus when cancelled', async t => {
  const view = setup(t)
  assert.equal(view.dialog.open, false)
  assert.equal(view.newButton.textContent, '新建会话')
  assert.equal(view.find('h2', view.dialog).textContent, '新建会话')
  assert.ok(view.find('details.ca-project-options input[aria-label="标题"]', view.dialog))
  assert.equal(view.panel.element.children.length, 2, 'only the entry button and closed dialog occupy the project panel')
  view.newButton.focus(); view.newButton.click()
  assert.equal(view.dialog.open, true)
  assert.equal(view.document.activeElement, view.input)
  await view.flush()
  view.fire(view.dialog, 'cancel')
  assert.equal(view.dialog.open, false)
  assert.equal(view.document.activeElement, view.newButton)
  assert.deepEqual(view.created, [])
  assert.deepEqual(view.selected, [])
  assert.deepEqual(view.errors, [])
})

test('project dialog also opens and closes when modal methods are unavailable', t => {
  const view = setup(t)
  view.dialog.showModal = undefined; view.dialog.close = undefined
  view.newButton.focus(); view.panel.open()
  assert.equal(view.dialog.hasAttribute('open'), true)
  view.find('.ca-project-close').click()
  assert.equal(view.dialog.hasAttribute('open'), false)
  assert.equal(view.document.activeElement, view.newButton)
})

test('selecting a recent project closes the dialog without precreating an empty conversation', async t => {
  const view = setup(t, { request: async () => ({ projects: [{ path: '/local/recent', name: 'Recent project', source: 'both', lastUsedAt: Date.now() }] }) })
  view.panel.open(); await view.flush()
  view.find('button[data-path="/local/recent"]', view.dialog).click()
  assert.deepEqual(view.selected, ['/local/recent'])
  assert.deepEqual(view.created, [])
  assert.equal(view.dialog.open, false)
  assert.equal(view.input.value, '/local/recent')
})

test('a chosen directory returns to the conversation, while explicit creation preserves its optional title', async t => {
  const view = setup(t, { request: async path => path.endsWith('/projects/recent') ? { projects: [] } : { path: '/local/project', parent: '/local', entries: [] } })
  view.panel.open(); view.find('.ca-browse').click(); await view.flush()
  assert.equal(view.find('.ca-browser').hidden, false)
  view.find('.ca-browser-choose').click()
  assert.deepEqual(view.selected, ['/local/project'])
  assert.deepEqual(view.created, [])
  assert.equal(view.dialog.open, false)
  assert.equal(view.find('.ca-browser').hidden, true)
  view.panel.open()
  view.find('input[name="title"]').value = '  A named task  '
  view.find('.ca-project-create').click()
  assert.deepEqual(view.created, [{ path: '/local/project', title: 'A named task' }])
  assert.equal(view.dialog.open, false)
  assert.equal(view.find('input[name="title"]').value, '')
})

test('using the current project selects it without creating a conversation', t => {
  const view = setup(t)
  view.panel.setPath('/local/current'); view.panel.open()
  view.find('.ca-project-select').click()
  assert.deepEqual(view.selected, ['/local/current'])
  assert.deepEqual(view.created, [])
  assert.equal(view.dialog.open, false)
})

test('submitting the project path selects it without implicitly creating an empty conversation', t => {
  const view = setup(t)
  view.panel.setPath('/local/current'); view.panel.open()
  view.fire(view.find('form.ca-project-form'), 'submit')
  assert.deepEqual(view.selected, ['/local/current'])
  assert.deepEqual(view.created, [])
  assert.equal(view.dialog.open, false)
})

test('the current native directory window selects its result and releases the picker button', async t => {
  const view = setup(t)
  view.panel.open()
  view.button.click()
  assert.equal(view.button.disabled, true)
  assert.equal(view.picks[0].signal.aborted, false)
  view.picks[0].resolve('/local/project')
  await view.flush()
  assert.deepEqual(view.selected, ['/local/project'])
  assert.equal(view.input.value, '/local/project')
  assert.equal(view.button.disabled, false)
  assert.equal(view.dialog.open, false)
  assert.deepEqual(view.created, [])
  assert.deepEqual(view.errors, [])
})

for (const outcome of ['result', 'error']) test(`a previous device's late picker ${outcome} cannot alter the current project or picker`, async t => {
  const view = setup(t)
  view.panel.open()
  view.button.click()
  const previous = view.picks[0]
  view.panel.setEnabled(false)
  assert.equal(previous.signal.aborted, true, 'leaving the device cancels the host window request')
  assert.equal(view.dialog.open, false)
  view.panel.setEnabled(true)
  view.panel.setPath('/remote/current')
  view.panel.open()
  view.button.click()
  const current = view.picks[1]
  assert.equal(current.signal.aborted, false)
  if (outcome === 'result') previous.resolve('/local/previous')
  else previous.reject(new Error('previous device picker unavailable'))
  await view.flush()
  assert.deepEqual(view.selected, [])
  assert.deepEqual(view.errors, [])
  assert.equal(view.input.value, '/remote/current')
  assert.equal(view.button.disabled, true, 'the previous completion cannot release the current window')
  current.resolve('/remote/selected')
  await view.flush()
  assert.deepEqual(view.selected, ['/remote/selected'])
  assert.equal(view.input.value, '/remote/selected')
  assert.equal(view.button.disabled, false)
})

test('disposing the panel cancels its native window and ignores its late result', async t => {
  const view = setup(t)
  view.panel.open()
  view.button.click()
  view.panel.dispose()
  assert.equal(view.picks[0].signal.aborted, true)
  assert.equal(view.dialog.open, false)
  view.picks[0].resolve('/local/previous')
  await view.flush()
  assert.deepEqual(view.selected, [])
  assert.deepEqual(view.errors, [])
  assert.equal(view.input.value, '')
  assert.equal(view.button.disabled, true)
  view.panel.setEnabled(true); view.panel.open()
  assert.equal(view.dialog.open, false, 'disposed panels cannot reopen')
})

for (const outcome of ['result', 'error']) test(`closing the project dialog cancels its native picker and ignores the late ${outcome}`, async t => {
  const view = setup(t)
  view.panel.open(); view.button.click()
  const previous = view.picks[0]
  view.find('.ca-project-close').click()
  assert.equal(previous.signal.aborted, true)
  assert.equal(view.dialog.open, false)
  view.panel.open(); view.button.click()
  const current = view.picks[1]
  if (outcome === 'result') previous.resolve('/local/previous')
  else previous.reject(new Error('late directory window failure'))
  await view.flush()
  assert.deepEqual(view.selected, [])
  assert.deepEqual(view.errors, [])
  assert.equal(view.button.disabled, true)
  assert.equal(view.dialog.open, true)
  current.resolve(null); await view.flush()
  assert.equal(view.button.disabled, false)
  assert.equal(view.dialog.open, true, 'cancelling the native window keeps project selection available')
})

test('closing project selection cancels directory and recent reads and isolates late responses', async t => {
  const recent = deferred(), listing = deferred()
  const view = setup(t, { request: path => path.endsWith('/projects/recent') ? recent.promise : listing.promise })
  view.panel.open(); view.find('.ca-browse').click()
  assert.equal(view.requests.length, 2)
  view.panel.close()
  assert.ok(view.requests.every(request => request.signal.aborted))
  recent.resolve({ projects: [{ path: '/previous', name: 'Old project', source: 'threads', lastUsedAt: Date.now() }] })
  listing.resolve({ path: '/previous', parent: '/', entries: [] })
  await view.flush()
  assert.equal(view.find('button[data-path="/previous"]'), null)
  assert.equal(view.find('.ca-browser-path').textContent, '')
  assert.deepEqual(view.selected, [])
  assert.deepEqual(view.errors, [])
})

test('closing the dialog aborts path validation and prevents its late selection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const validation = deferred()
  const view = setup(t, { request: path => path.endsWith('/projects/recent') ? Promise.resolve({ projects: [] }) : validation.promise })
  view.panel.open()
  view.input.value = '/local/pending'; view.fire(view.input, 'input')
  t.mock.timers.tick(350)
  const request = view.requests.find(request => request.path.includes('/directories?'))
  assert.ok(request)
  assert.equal(request.signal.aborted, false)
  view.panel.close()
  assert.equal(request.signal.aborted, true)
  validation.resolve({ path: '/local/late', parent: '/local', entries: [] })
  await view.flush()
  assert.deepEqual(view.selected, [])
  assert.deepEqual(view.errors, [])
  assert.equal(view.find('.ca-project-select').disabled, true)
})

test('validating an edited path keeps the current conversation until the user confirms it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const view = setup(t, { request: async path => path.endsWith('/projects/recent') ? { projects: [] } : { path: '/local/next', parent: '/local', entries: [] } })
  view.panel.setPath('/local/current'); view.panel.open()
  view.input.value = '/local/next'; view.fire(view.input, 'input')
  t.mock.timers.tick(350); await view.flush()
  assert.equal(view.find('.ca-path-status').textContent, '目录存在')
  assert.equal(view.find('.ca-project-select').disabled, false)
  assert.deepEqual(view.selected, [], 'directory validation must not change the current conversation')
  assert.equal(view.dialog.open, true)
  view.fire(view.input, 'keydown', { key: 'Enter', isComposing: false })
  assert.deepEqual(view.selected, ['/local/next'])
  assert.equal(view.dialog.open, false)
})

test('reopening defaults to the latest current project without validating it or committing cancelled edits', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const view = setup(t, { request: async path => path.endsWith('/projects/recent') ? { projects: [] } : { path: '/local/unselected', parent: '/local', entries: [] } })
  view.panel.setPath('/local/current'); view.panel.open(); await view.flush()
  assert.equal(view.input.value, '/local/current')
  assert.equal(view.requests.some(request => request.path.includes('/directories?')), false)
  view.input.value = '/local/unselected'; view.fire(view.input, 'input')
  t.mock.timers.tick(350); await view.flush()
  view.panel.close(); view.panel.open(); await view.flush()
  assert.equal(view.input.value, '/local/current')
  assert.deepEqual(view.selected, [])
  assert.equal(view.requests.filter(request => request.path.includes('/directories?')).length, 1, 'a trusted current project needs no extra existence check')
  view.panel.close(); view.panel.setPath('/remote/other'); view.panel.open()
  assert.equal(view.input.value, '/remote/other')
  assert.deepEqual(view.selected, [])
})

test('opening revalidates an unverified path after the previous dialog was cancelled', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const view = setup(t, { request: async path => path.endsWith('/projects/recent') ? { projects: [] } : { path: '/local/draft', parent: '/local', entries: [] } })
  view.panel.open()
  view.input.value = '/local/draft'; view.fire(view.input, 'input')
  view.panel.close()
  assert.equal(view.requests.some(request => request.path.includes('/directories?')), false, 'closing cancels the debounced validation')
  view.panel.open(); await view.flush()
  assert.equal(view.requests.filter(request => request.path.includes('/directories?')).length, 1)
  assert.equal(view.find('.ca-project-select').disabled, false)
  assert.deepEqual(view.selected, [])
  assert.equal(view.dialog.open, true)
})

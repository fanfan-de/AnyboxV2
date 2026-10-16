import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createProjectPanel } from '../dist/applications/claude-agent/web/projects.js'
import { installClaudeAgentDOM } from './helpers/claude-agent-dom.mjs'

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const setup = t => {
  const dom = installClaudeAgentDOM(t), picks = [], selected = [], errors = []
  const panel = createProjectPanel(local => local, {
    request: async () => { throw new Error('unexpected device request') },
    select: path => selected.push(path), create() {}, report: error => errors.push(error),
    pickNative(signal) { const pick = { ...deferred(), signal }; picks.push(pick); return pick.promise },
  })
  dom.container.append(panel.element); panel.setNativePicker(true); panel.setEnabled(true)
  t.after(() => panel.dispose())
  return { ...dom, panel, picks, selected, errors, button: dom.find('.ca-pick-native'), input: dom.find('input[name="projectPath"]') }
}

test('the current native directory window selects its result and releases the picker button', async t => {
  const view = setup(t)
  view.button.click()
  assert.equal(view.button.disabled, true)
  assert.equal(view.picks[0].signal.aborted, false)
  view.picks[0].resolve('/local/project')
  await view.flush()
  assert.deepEqual(view.selected, ['/local/project'])
  assert.equal(view.input.value, '/local/project')
  assert.equal(view.button.disabled, false)
  assert.deepEqual(view.errors, [])
})

for (const outcome of ['result', 'error']) test(`a previous device's late picker ${outcome} cannot alter the current project or picker`, async t => {
  const view = setup(t)
  view.button.click()
  const previous = view.picks[0]
  view.panel.setEnabled(false)
  assert.equal(previous.signal.aborted, true, 'leaving the device cancels the host window request')
  view.panel.setEnabled(true)
  view.panel.setPath('/remote/current')
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
  view.button.click()
  view.panel.dispose()
  assert.equal(view.picks[0].signal.aborted, true)
  view.picks[0].resolve('/local/previous')
  await view.flush()
  assert.deepEqual(view.selected, [])
  assert.deepEqual(view.errors, [])
  assert.equal(view.input.value, '')
  assert.equal(view.button.disabled, true)
})

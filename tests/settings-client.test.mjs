import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setupSettingsNavigation } from '../packages/app-harness/dist/web/settings-client.js'

const sections = ['general', 'connections', 'archive', 'models', 'prompts', 'tools', 'units']
const dataKey = name => name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())

/** Only the DOM operations owned by the settings navigation, without mounting business views. */
function fixture(t, options = {}) {
  const document = { activeElement: undefined }
  class Element extends EventTarget {
    constructor(tag) { super(); this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.hidden = false; this.disabled = false; this.open = false; this.value = ''; this.textContent = ''; this.className = ''; this.parentElement = null }
    append(...children) { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child) } }
    prepend(...children) { for (const child of [...children].reverse()) { child.remove(); child.parentElement = this; this.children.unshift(child) } }
    insertBefore(child, reference) { child.remove(); const index = this.children.indexOf(reference); assert.ok(index >= 0); child.parentElement = this; this.children.splice(index, 0, child) }
    replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...children) }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null }
    setAttribute(name, value) { this.attributes[name] = value; if (name.startsWith('data-')) this.dataset[dataKey(name)] = value }
    removeAttribute(name) { delete this.attributes[name] }
    getAttribute(name) { return this.attributes[name] ?? null }
    querySelectorAll(selector) {
      const matches = element => selector.startsWith('#') ? element.id === selector.slice(1)
        : selector.startsWith('.') ? element.className.split(/\s+/).includes(selector.slice(1))
        : selector.startsWith('[data-') ? dataKey(selector.slice(1, -1)) in element.dataset
        : selector.startsWith('label[') ? element.tagName === 'label' && element.attributes.for === 'agent--settings-device'
        : element.tagName === selector
      return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)])
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
    focus() { document.activeElement = this }
    showModal() { this.open = true }
    close() { this.open = false }
    click() { this.dispatchEvent(new Event('click')) }
  }
  document.createElement = tag => new Element(tag)
  document.body = new Element('body'); document.activeElement = document.body
  const previousDocument = globalThis.document; globalThis.document = document
  const el = (tag, id, text) => { const node = document.createElement(tag); if (id) node.id = id; if (text) node.textContent = text; return node }
  const root = el('div'), dialog = el('dialog', 'agent--settings-dialog'), content = el('div', 'agent--settings-content')
  const scope = el('div', 'agent--settings-scope'), label = el('label'), device = el('select', 'agent--settings-device'), all = el('span', 'agent--settings-all-devices', '所有设备')
  label.setAttribute('for', 'agent--settings-device'); label.textContent = '正在设置：'; all.hidden = true; scope.append(label, device, all)
  const buttons = new Map(), panels = new Map(), headings = new Map()
  for (const section of sections) {
    const button = el('button'); button.dataset.settingsSection = section; buttons.set(section, button); dialog.append(button)
    const panel = el('section'), heading = el('header'), title = el('h3', undefined, section), workflow = el('p', undefined, `${section} existing description`)
    panel.dataset.settingsPanel = section; panel.hidden = section !== 'general'; heading.className = 'settings-panel-heading'
    if (section === 'models') {
      const group = el('div'); group.append(title, workflow)
      const action = el('button', undefined, '添加提供方'); action.id = 'models-action'; heading.append(group, action)
    } else heading.append(title, workflow)
    panel.append(heading); panels.set(section, panel); headings.set(section, heading); content.append(panel)
  }
  content.prepend(scope); dialog.append(content); root.append(dialog)
  let active = true, refreshes = 0
  const changes = [], fixed = { devices: [{ id: 'local', name: '这台电脑' }, { id: 'remote', name: '开发服务器' }], selectedId: 'local',
    isActive: () => active, selectDevice: id => { changes.push(id); return true }, refreshArchive: () => { refreshes++ }, ...options }
  const view = setupSettingsNavigation(root, fixed)
  t.after(() => { view.dispose(); if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument })
  return { document, view, dialog, content, scope, label, device, all, buttons, panels, headings, changes,
    setActive(value) { active = value }, get refreshes() { return refreshes },
    select(id) { device.value = id; device.dispatchEvent(new Event('change')) },
  }
}

test('device scope sits next to the current title and retains nested model descriptions and actions', t => {
  const f = fixture(t, { initialState: { section: 'prompts', open: false, focusDevice: false } })
  assert.equal(f.device.value, 'local')
  assert.deepEqual(f.device.children.map(option => option.textContent), ['这台电脑', '开发服务器'])
  const promptHeading = f.headings.get('prompts'), promptRow = promptHeading.querySelector('.settings-title-row')
  assert.equal(promptRow.parentElement, promptHeading)
  assert.equal(f.scope.parentElement, promptRow)
  assert.equal(promptHeading.querySelector('p').textContent, 'prompts existing description', 'the Prompt save/publish workflow is retained')
  assert.equal(promptHeading.querySelector('.settings-scope-description').textContent, '这里的 Prompt 供这台电脑上的 Agent 使用。')
  assert.equal(f.panels.get('prompts').hidden, false)
  f.buttons.get('models').click()
  const modelsHeading = f.headings.get('models'), modelRow = modelsHeading.querySelector('.settings-title-row')
  assert.equal(modelRow.parentElement, modelsHeading)
  assert.equal(modelRow.querySelector('h3').textContent, 'models')
  assert.equal(f.scope.parentElement, modelRow)
  assert.ok(modelsHeading.children.some(child => child.tagName === 'p' && child.textContent === 'models existing description'))
  assert.equal(modelsHeading.querySelector('#models-action').textContent, '添加提供方')
  assert.equal(modelsHeading.querySelector('.settings-scope-description').textContent, '管理这台电脑上保存的模型连接和调用配置。')
  f.buttons.get('prompts').click()
  assert.equal(promptHeading.querySelectorAll('.settings-title-row').length, 1)
  assert.equal(promptHeading.querySelectorAll('.settings-scope-description').length, 1)
})

test('connection and archive sections show all-device scope instead of the current device', t => {
  const f = fixture(t)
  for (const section of ['connections', 'archive']) {
    f.buttons.get(section).click()
    assert.equal(f.device.hidden, true); assert.equal(f.label.hidden, true); assert.equal(f.all.hidden, false)
    assert.equal(f.scope.parentElement.parentElement, f.headings.get(section))
    assert.doesNotMatch(f.headings.get(section).querySelector('.settings-scope-description').textContent, /正在设置/)
  }
  assert.equal(f.refreshes, 1)
  f.buttons.get('tools').click()
  assert.equal(f.device.hidden, false); assert.equal(f.label.hidden, false); assert.equal(f.all.hidden, true)
  assert.match(f.headings.get('tools').querySelector('.settings-scope-description').textContent, /只影响新建会话/)
})

test('rejected changes restore the fixed device and show feedback on the guard-revealed section', t => {
  let f
  const changes = []
  f = fixture(t, { selectDevice(id) { changes.push(id); f.view.selectSection('prompts'); return false } })
  f.buttons.get('models').click(); f.select('remote')
  assert.deepEqual(changes, ['remote']); assert.equal(f.device.value, 'local')
  assert.equal(f.view.snapshot().section, 'prompts')
  const status = f.headings.get('prompts').querySelector('.settings-device-status')
  assert.equal(status.hidden, false); assert.equal(status.getAttribute('role'), 'status')
  assert.match(status.textContent, /保存或放弃/)
  assert.match(f.headings.get('prompts').querySelector('.settings-scope-description').textContent, /这台电脑/)
  f.select('unknown'); f.select('local')
  assert.deepEqual(changes, ['remote'], 'unknown and unchanged targets do not reach the owner')
})

test('accepted changes delegate once without optimistically binding the old page to the new device', t => {
  const f = fixture(t)
  f.select('remote')
  assert.deepEqual(f.changes, ['remote'])
  assert.equal(f.device.value, 'local')
  assert.match(f.headings.get('general').querySelector('.settings-scope-description').textContent, /这台电脑/)
  f.device.focus(); f.view.open('models')
  assert.deepEqual(f.view.snapshot(), { section: 'models', open: true, focusDevice: true })
})

test('restoration keeps the category and returns focus only when the application is active', t => {
  const f = fixture(t, { initialState: { section: 'prompts', open: true, focusDevice: true } })
  assert.equal(f.dialog.open, false, 'mounting alone does not steal modal focus')
  f.setActive(false); f.view.restore()
  assert.equal(f.dialog.open, false); assert.equal(f.document.activeElement, f.document.body)
  f.setActive(true); f.view.restore()
  assert.deepEqual(f.view.snapshot(), { section: 'prompts', open: true, focusDevice: true })
  f.dialog.close(); f.view.restore()
  assert.equal(f.dialog.open, true)
})

test('disposed navigation ignores old device and category controls', t => {
  const f = fixture(t)
  f.view.dispose(); f.select('remote'); f.buttons.get('archive').click(); f.view.open('prompts'); f.view.showBlocked()
  assert.deepEqual(f.changes, []); assert.equal(f.refreshes, 0); assert.equal(f.dialog.open, false)
  assert.equal(f.view.snapshot().section, 'general')
})

test('handling a blocked switch or moving to another category clears outdated switch feedback', t => {
  const f = fixture(t)
  f.view.open('prompts'); f.view.showBlocked()
  const status = f.headings.get('prompts').querySelector('.settings-device-status')
  assert.equal(status.hidden, false)
  f.dialog.dispatchEvent(new Event('input'))
  assert.equal(status.hidden, true, 'editing the draft clears the earlier warning')
  f.view.showBlocked(); f.buttons.get('archive').click()
  assert.equal(status.hidden, true, 'switch feedback does not follow the user into global categories')
  assert.equal(f.headings.get('archive').querySelectorAll('p').length, 1, 'the scope description is not duplicated')
})

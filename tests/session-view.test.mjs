import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSessionPanel } from '../dist/applications/harness/web/session-view.js'
import { mapResourceIds, scopedId } from '../dist/applications/harness/web/harness-client.js'
import { renderMarkdown } from '../dist/applications/harness/web/markdown.js'

// A local DOM surface keeps these tests about panel behavior without a browser dependency.
function documentFixture() {
  const document = { activeElement: undefined }
  const attributeName = name => name.replace(/-([a-z])/g, (_, value) => value.toUpperCase())
  const simpleMatch = (node, selector) => {
    if (!node.tagName) return false
    const tag = selector.match(/^[\w-]+/)
    if (tag && node.tagName !== tag[0].toLowerCase()) return false
    for (const match of selector.matchAll(/([.#])([\w-]+)|\[([^\]=]+)(?:=["']?([^\]"']*)["']?)?\]/g)) {
      if (match[1] === '.' && !node.classList.contains(match[2])) return false
      if (match[1] === '#' && node.id !== match[2]) return false
      if (match[3]) {
        const value = node.getAttribute(match[3])
        if (value === null || (match[4] !== undefined && value !== match[4])) return false
      }
    }
    return true
  }
  const match = (node, selector) => selector.split(',').some(part => {
    const tokens = part.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/)
    const matchesAt = (current, index) => {
      if (!current || !simpleMatch(current, tokens[index])) return false
      if (index === 0) return true
      if (tokens[index - 1] === '>') return matchesAt(current.parentElement, index - 2)
      for (let parent = current.parentElement; parent; parent = parent.parentElement) if (matchesAt(parent, index - 1)) return true
      return false
    }
    return matchesAt(node, tokens.length - 1)
  })
  const createElement = tagName => {
    let ownText = '', ownWidth = 640, ownHeight = 400, ownScrollHeight = 1800
    const node = {
      ownerDocument: document, tagName: tagName.toLowerCase(), className: '', dataset: {}, children: [], parentElement: undefined,
      attributes: {}, listeners: new Map(), style: { setProperty() {} }, scrollTop: 0, value: '', hidden: false, inert: false, disabled: false, open: false,
      classList: {
        toggle(name, force) { const values = new Set(node.className.split(/\s+/).filter(Boolean)); if (force ?? !values.has(name)) values.add(name); else values.delete(name); node.className = [...values].join(' ') },
        contains(name) { return node.className.split(/\s+/).includes(name) },
        add(...names) { for (const name of names) this.toggle(name, true) },
        remove(...names) { for (const name of names) this.toggle(name, false) },
      },
      setAttribute(name, value) {
        value = String(value); this.attributes[name] = value
        if (name === 'class') this.className = value
        if (name === 'id') this.id = value
        if (name.startsWith('data-')) this.dataset[attributeName(name.slice(5))] = value
        if (name === 'hidden') this.hidden = true
        if (name === 'inert') this.inert = true
      },
      getAttribute(name) {
        if (name.startsWith('data-')) return this.dataset[attributeName(name.slice(5))] ?? null
        if (name === 'class') return this.className || null
        if (name === 'id') return this.id ?? null
        return this.attributes[name] ?? null
      },
      removeAttribute(name) { delete this.attributes[name]; if (name === 'hidden') this.hidden = false; if (name === 'inert') this.inert = false },
      append(...children) { for (let child of children) { if (typeof child === 'string') child = document.createTextNode(child); child.remove(); child.parentElement = this; this.children.push(child) } },
      prepend(child) { this.insertBefore(child, this.firstChild) },
      insertBefore(child, target) { child.remove(); const index = this.children.indexOf(target); child.parentElement = this; if (index < 0) this.children.push(child); else this.children.splice(index, 0, child) },
      replaceChildren(...children) { for (const child of [...this.children]) child.remove(); ownText = ''; this.append(...children) },
      remove() { if (this.parentElement) { if (this.contains(document.activeElement)) document.activeElement = document.body; this.parentElement.children = this.parentElement.children.filter(child => child !== this) } this.parentElement = undefined },
      contains(child) { return child === this || this.children.some(node => node.contains(child)) },
      closest(selector) { return match(this, selector) ? this : this.parentElement?.closest(selector) },
      querySelectorAll(selector) { return this.children.flatMap(child => [...(match(child, selector) ? [child] : []), ...child.querySelectorAll(selector)]) },
      querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null },
      addEventListener(type, callback, options) { const list = this.listeners.get(type) ?? []; list.push({ callback, signal: options?.signal }); this.listeners.set(type, list) },
      dispatch(type, extra = {}) {
        let stopped = false
        const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() { stopped = true }, ...extra }
        for (let current = this; current && !stopped; current = current.parentElement) for (const listener of current.listeners.get(type) ?? []) if (!listener.signal?.aborted) listener.callback(event)
        return event
      },
      dispatchEvent(event) { this.dispatch(event.type, { key: event.key }); return true },
      click() { if (!this.disabled) this.dispatch('click') },
      focus() { document.activeElement = this },
    }
    const visible = () => { for (let current = node; current; current = current.parentElement) if (current.hidden) return false; return true }
    Object.defineProperties(node, {
      firstChild: { get: () => node.children[0] ?? null },
      childNodes: { get: () => node.children },
      nextSibling: { get: () => node.parentElement?.children[node.parentElement.children.indexOf(node) + 1] ?? null },
      isConnected: { get: () => node === document.body || Boolean(node.parentElement?.isConnected) },
      clientWidth: { get: () => visible() ? ownWidth : 0, set(value) { ownWidth = value } },
      clientHeight: { get: () => visible() ? ownHeight : 0, set(value) { ownHeight = value } },
      scrollHeight: { get: () => visible() ? ownScrollHeight : 0, set(value) { ownScrollHeight = value } },
      offsetTop: { get: () => (node.parentElement?.children.indexOf(node) ?? 0) * 96 },
      textContent: { get: () => ownText + node.children.map(child => child.textContent).join(''), set(value) { ownText = String(value); for (const child of node.children) child.parentElement = undefined; node.children = [] } },
      innerHTML: { set(value) {
        node.replaceChildren()
        const stack = [node], voidTags = new Set(['input', 'img', 'br', 'hr', 'meta', 'link'])
        for (const token of value.matchAll(/<\/?[^>]+>|[^<]+/g)) {
          const text = token[0]
          if (text.startsWith('</')) { if (stack.length > 1) stack.pop(); continue }
          if (text.startsWith('<')) {
            const tag = text.match(/^<([\w-]+)/)?.[1]; if (!tag) continue
            const child = createElement(tag)
            const attributes = text.slice(tag.length + 1, -1)
            for (const attr of attributes.matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) child.setAttribute(attr[1], attr[2] ?? attr[3] ?? attr[4] ?? '')
            stack.at(-1).append(child)
            if (!voidTags.has(tag) && !text.endsWith('/>')) stack.push(child)
          } else if (text.trim()) stack.at(-1).append(document.createTextNode(text))
        }
      } },
    })
    return node
  }
  document.createElement = createElement
  document.createTextNode = text => { const node = createElement('#text'); node.textContent = text; return node }
  document.body = createElement('body')
  return document
}

function markdownFixture(t, source, citations = []) {
  const previous = globalThis.document
  globalThis.document = documentFixture()
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous })
  return renderMarkdown(source, citations)
}

const run = (id, status = 'completed', parentNodeId = null) => ({ id, sessionId: 'session', input: `Input ${id}`, status,
  history: { kind: 'tree', parentNodeId }, revision: 1, createdAt: id, ...(status === 'completed' ? { resultNodeId: `node-${id}`, output: `Answer ${id}` } : {}) })
const projection = (id, text, status = 'committed', viewRevision = 1) => ({ envelopeVersion: 1, viewSchemaVersion: 2,
  protocolId: 'chat-completions', sessionId: 'session', runId: id, viewRevision, status,
  exchanges: [{ id: 'exchange', blocks: [{ id: 'text', type: 'chat.content', text }] }] })
const traceAt = seconds => new Date(Date.UTC(2026, 9, 2, 1, 0, seconds)).toISOString()
const traceRun = (id, status = 'completed', extra = {}) => ({ ...run(id, status), createdAt: traceAt(0), updatedAt: traceAt(10),
  modelId: 'configuration', modelSnapshot: { remoteModelId: 'deepseek-chat', protocolId: 'chat-completions' },
  protocolBinding: { protocolId: 'chat-completions' }, ...extra })
const modelStarted = (id, seconds) => ({ kind: 'operation-started', operationId: id, operationKind: 'model', at: traceAt(seconds) })
const operationObserved = (id, seconds) => ({ kind: 'operation-observed', operationId: id, at: traceAt(seconds) })

function fixture(t, { runs = [run('first')], position = {}, initialScroll = { dialogue: 0 }, path } = {}) {
  const previous = globalThis.document, document = documentFixture(), calls = []
  globalThis.document = document
  const state = { session: { id: 'session', projectId: 'project', agentId: 'assistant', protocolId: 'chat-completions', historyMode: 'native-local-v1' },
    runs, position: { viewNodeId: 'node-first', ...position }, path: path ?? [{ id: 'node-first', parentId: null, input: 'Thread input', output: 'Thread answer', sourceRunId: 'first' }],
    children: [], moreChildren: false, loading: false, busy: false, notice: '', draft: 'Unsent draft', images: [], files: [], events: new Map(), expanded: new Set(),
    views: new Map([['first', projection('first', 'Thread answer')]]) }
  let panel
  const changed = () => panel?.render()
  const controller = {
    snapshot: () => ({ ...state, run: state.runs.find(item => item.id === state.position.focusedRunId) }),
    setViewMode(mode) { calls.push(['mode', mode]); state.position = { ...state.position, viewMode: mode }; changed() },
    navigate(id) { calls.push(['navigate', id]); state.position = { viewNodeId: id, viewMode: 'dialogue' }; changed(); return Promise.resolve() },
    focusRun(id) { calls.push(['focus', id]); state.position = { ...state.position, focusedRunId: id, follow: undefined }; state.expanded.add(id); changed() },
    toggleTrace(id) { calls.push(['trace', id]); if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id); changed() },
    setTraceViewport(ids) { calls.push(['viewport', ids]) }, setTraceSearch(query) { calls.push(['search', query]); changed() }, retryTrace(id) { calls.push(['retry', id]) },
    cancel(id) { calls.push(['cancel', id]); return Promise.resolve() },
    setDraft(value) { state.draft = value; changed() }, setFiles(value) { state.files = value; changed() },
    submit() { calls.push(['submit']); return Promise.resolve() }, moreChildren() { return Promise.resolve() },
  }
  const mount = scroll => {
    panel = createSessionPanel({ id: 'session', sessionId: 'session', projectId: 'project' }, 'Project', controller, () => {}, () => {}, scroll)
    document.body.append(panel.element); panel.render()
    return panel
  }
  mount(initialScroll)
  t.after(() => { panel.dispose(); if (previous === undefined) delete globalThis.document; else globalThis.document = previous })
  const find = selector => { const found = panel.element.querySelector(selector); assert.ok(found, `missing ${selector}`); return found }
  return { panel, state, calls, document, find, mount, dialogue: () => find('[data-view-mode="dialogue"]'), history: () => find('[data-view-mode="runs"]') }
}

test('assistant Markdown renders CommonMark and GFM blocks with readable tables and copyable literal code', t => {
  const source = '# Heading\n\nA **bold** and *emphasis* with `inline` and ~~removed~~.\n\n> Quoted text\n\n1. First\n2. Second\n\n- [x] Done\n- [ ] Pending\n\n| Name | Value |\n| --- | --- |\n| Alpha | 42 |\n\n```ts\nconst answer = 42\n```'
  const content = markdownFixture(t, source)
  assert.equal(content.tagName, 'div')
  assert.ok(content.classList.contains('message-content')); assert.ok(content.classList.contains('markdown-content'))
  assert.equal(content.querySelector('h1').textContent, 'Heading')
  assert.equal(content.querySelector('strong').textContent, 'bold'); assert.equal(content.querySelector('em').textContent, 'emphasis')
  assert.equal(content.querySelector('del').textContent, 'removed'); assert.equal(content.querySelector('p code').textContent, 'inline')
  assert.equal(content.querySelector('blockquote').textContent, 'Quoted text')
  assert.deepEqual(content.querySelector('ol').querySelectorAll('li').map(item => item.textContent), ['First', 'Second'])
  const checkboxes = content.querySelector('ul').querySelectorAll('input')
  assert.equal(checkboxes.length, 2); assert.ok(checkboxes.every(checkbox => checkbox.disabled))
  assert.deepEqual(checkboxes.map(checkbox => checkbox.checked), [true, false])
  const table = content.querySelector('table')
  assert.equal(table.parentElement.classList.contains('markdown-table-container'), true)
  assert.equal(table.parentElement.tabIndex, 0)
  assert.deepEqual(table.querySelectorAll('th').map(cell => cell.textContent), ['Name', 'Value'])
  assert.deepEqual(table.querySelectorAll('td').map(cell => cell.textContent), ['Alpha', '42'])
  assert.equal(content.querySelector('pre code').textContent, 'const answer = 42')
  assert.equal(content.querySelector('.markdown-code-copy').getAttribute('aria-label'), '复制代码')
})

test('Markdown code copy preserves the original code without fences or button text', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), copied = []
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async value => { copied.push(value) } } } })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'navigator', previous); else delete globalThis.navigator })
  const content = markdownFixture(t, '```sh\nprintf "<tag>\\n"\n```')
  content.querySelector('.markdown-code-copy').click()
  await Promise.resolve()
  assert.deepEqual(copied, ['printf "<tag>\\n"'])
})

test('Markdown displays HTML literally and never loads remote images or unsafe links', t => {
  const payload = '<script>attack()</script>\n\n<img src=x onerror="attack()">\n\n<svg onload="attack()"></svg>'
  const content = markdownFixture(t, `${payload}\n\n[unsafe](javascript:attack%281%29) [data](data:text/html;base64,c2NyaXB0) [account](https://secret:password@example.test/private) [relative](/private) [safe](https://example.test/page "Safe")\n\n![diagram](https://images.example.test/chart.png) ![leak](data:image/svg+xml;base64,c2NyaXB0)`)
  assert.ok(content.textContent.includes('<script>attack()</script>'))
  assert.ok(content.textContent.includes('<img src=x onerror="attack()">'))
  assert.ok(content.textContent.includes('<svg onload="attack()"></svg>'))
  assert.equal(content.querySelectorAll('img, script, svg, iframe, object, embed').length, 0)
  const links = content.querySelectorAll('a'), urls = links.map(link => link.href ?? link.getAttribute('href'))
  assert.deepEqual(urls, ['https://example.test/page', 'https://images.example.test/chart.png'])
  assert.equal(links[0].textContent, 'safe'); assert.equal(links[0].title, 'Safe')
  assert.match(links[1].textContent, /diagram/); assert.match(content.textContent, /leak/)
  assert.ok(links.every(link => link.target === '_blank' && /noopener/.test(link.rel) && /noreferrer/.test(link.rel)))
})

test('Markdown falls back to the complete literal source for too many nodes or oversized content', t => {
  // Many short paragraphs exceed the node budget while staying below the character limit.
  const source = 'a\n\n'.repeat(21_000)
  const content = markdownFixture(t, source)
  assert.equal(content.classList.contains('markdown-plain'), true)
  assert.equal(content.textContent, source); assert.equal(content.children.length, 0)
  const oversized = '**literal** '.repeat(100_000), large = renderMarkdown(oversized)
  assert.equal(large.classList.contains('markdown-plain'), true)
  assert.equal(large.textContent, oversized); assert.equal(large.children.length, 0)
})

test('Markdown citations beside entities, nested link labels and inline code never create nested anchors', t => {
  const source = 'Plain &amp; tail [**linked**](https://example.test/link) and `x & y` final.'
  const content = markdownFixture(t, source, [
    { start: source.indexOf('x & y'), end: source.indexOf('x & y') + 2, url: 'https://example.test/code' },
    { start: source.indexOf('linked'), end: source.indexOf('linked') + 3, url: 'https://example.test/link-source' },
    { start: source.indexOf('&amp;'), end: source.indexOf('&amp;') + 3, url: 'https://example.test/entity' },
    { start: source.indexOf('linked'), end: source.indexOf('linked') + 6, url: 'https://example.test/overlap' },
  ])
  const paragraph = content.querySelector('p'), link = paragraph.querySelectorAll('a').find(link => link.href === 'https://example.test/link'), code = paragraph.querySelector('code')
  assert.equal(paragraph.firstChild.textContent, 'Plain & tail ')
  assert.equal(paragraph.firstChild.nextSibling.textContent, '[3]', 'a decoded entity keeps the mark after its text node')
  assert.equal(link.querySelector('strong').textContent, 'linked')
  assert.equal(link.nextSibling.textContent, '[2]'); assert.equal(link.nextSibling.nextSibling.textContent, '[4]')
  assert.equal(code.textContent, 'x & y'); assert.equal(code.nextSibling.textContent, '[1]')
  assert.equal(content.querySelectorAll('sup').length, 4)
  assert.ok(content.querySelectorAll('a').every(link => link.querySelectorAll('a, sup').length === 0))
})

test('Markdown citations preserve source order for overlapping ranges and the original citation numbering', t => {
  const source = 'Alpha Bravo Charlie', content = markdownFixture(t, source, [
    { start: 0, end: 11, url: 'https://example.test/first' },
    { start: 0, end: 5, url: 'https://example.test/second' },
    { start: 6, end: 11, url: 'https://example.test/third' },
  ])
  assert.equal(content.querySelector('p').textContent, 'Alpha[2] Bravo[1][3] Charlie')
  assert.deepEqual(content.querySelectorAll('sup a').map(link => link.href), [
    'https://example.test/second', 'https://example.test/first', 'https://example.test/third',
  ])
})

test('streaming Markdown reparses an unfinished fence while preserving protocol turn and block identities', t => {
  const f = fixture(t, { runs: [run('first'), run('live', 'running', 'node-first')], position: { focusedRunId: 'live' } })
  f.state.views.set('live', projection('live', '```js\nconst partial = "x"', 'provisional')); f.panel.render()
  const turn = f.find('.protocol-turn[data-run-id="live"]'), block = turn.querySelector('[data-block-id="text"]')
  const completedTurn = f.find('.protocol-turn[data-run-id="first"]')
  assert.equal(block.querySelector('pre code').textContent, 'const partial = "x"')
  f.history().click()
  f.state.views.set('live', projection('live', '```js\nconst partial = "x";\n```\n\n**Complete**', 'provisional', 2)); f.panel.render()
  f.dialogue().click()
  assert.equal(f.find('.protocol-turn[data-run-id="live"]'), turn)
  assert.equal(turn.querySelector('[data-block-id="text"]'), block)
  assert.equal(f.find('.protocol-turn[data-run-id="first"]'), completedTurn)
  assert.equal(block.querySelector('pre code').textContent, 'const partial = "x";')
  assert.equal(block.querySelector('strong').textContent, 'Complete')
  assert.equal(block.querySelectorAll('pre').length, 1)
})

for (const parentNodeId of [null, 'node-first']) test(`followed completion keeps the visible turn until the result path commits from ${parentNodeId ?? 'the root'}`, t => {
  const existingPath = parentNodeId ? [{ id: 'node-first', parentId: null, input: 'Thread input', output: 'Thread answer', sourceRunId: 'first' }] : []
  const f = fixture(t, { runs: [...(parentNodeId ? [run('first')] : []), run('live', 'running', parentNodeId), run('other', 'completed', parentNodeId)],
    path: existingPath, position: { viewNodeId: parentNodeId, focusedRunId: 'live', follow: { runId: 'live', parentNodeId } } })
  const text = '```js\nconst answer = 42\n```'
  f.state.views.set('live', projection('live', text, 'provisional'))
  f.state.views.set('other', projection('other', 'A different completed branch'))
  f.panel.render()
  const transcript = f.find('.transcript'), turn = f.find('.protocol-turn[data-run-id="live"]')
  const block = turn.querySelector('[data-block-id="text"]'), copy = block.querySelector('.markdown-code-copy')
  assert.equal(transcript.querySelector('.protocol-turn[data-run-id="other"]'), null)
  assert.match(transcript.textContent, /正在生成/)
  f.state.runs = f.state.runs.map(item => item.id === 'live' ? run('live', 'completed', parentNodeId) : item)
  f.panel.render()
  assert.equal(transcript.hidden, false); assert.equal(f.find('.empty-state').hidden, true)
  assert.equal(f.panel.element.classList.contains('is-empty'), false)
  assert.equal(transcript.querySelector('.protocol-turn[data-run-id="live"]'), turn)
  assert.equal(turn.isConnected, true); assert.equal(block.querySelector('.markdown-code-copy'), copy)
  assert.doesNotMatch(transcript.textContent, /正在生成/); assert.match(transcript.textContent, /已完成/)
  f.state.path = [...existingPath, { id: 'node-live', parentId: parentNodeId, input: 'Input live', output: text, sourceRunId: 'live' }]
  f.state.position = { ...f.state.position, viewNodeId: 'node-live', follow: undefined }
  f.state.views.set('live', projection('live', text, 'committed', 2)); f.panel.render()
  assert.equal(transcript.hidden, false); assert.equal(f.find('.empty-state').hidden, true)
  assert.equal(transcript.querySelectorAll('.protocol-turn[data-run-id="live"]').length, 1)
  assert.equal(transcript.querySelector('.protocol-turn[data-run-id="live"]'), turn)
  assert.equal(turn.querySelector('[data-block-id="text"]'), block)
  assert.equal(block.querySelector('.markdown-code-copy'), copy)
  assert.doesNotMatch(transcript.textContent, /正在生成|临时输出/)
})

test('clearing follow removes completed transition output without another run or view update', t => {
  const f = fixture(t, { runs: [run('first'), run('live', 'completed', 'node-first')],
    position: { focusedRunId: 'live', follow: { runId: 'live', parentNodeId: 'node-first' } } })
  f.state.views.set('live', projection('live', 'Completed transition output')); f.panel.render()
  const turn = f.find('.protocol-turn[data-run-id="live"]')
  f.state.position = { ...f.state.position, follow: undefined }; f.panel.render()
  assert.equal(f.find('.transcript').hidden, false)
  assert.equal(f.find('.transcript').querySelector('.protocol-turn[data-run-id="live"]'), null)
  assert.equal(turn.isConnected, false)
  assert.equal(f.find('.protocol-turn[data-run-id="first"]').textContent, 'Chat CompletionsThread answer')
})

test('protocol updates retain unchanged Markdown controls across block reorder and remove obsolete blocks', t => {
  const f = fixture(t), code = { id: 'code', type: 'chat.content', text: '```js\nconst kept = true\n```' }
  const update = (viewRevision, blocks) => {
    f.state.views.set('first', { ...projection('first', '', 'committed', viewRevision), exchanges: [{ id: 'exchange', blocks }] })
    f.panel.render()
  }
  update(2, [code, { id: 'status', type: 'harness.unsupported', text: 'Waiting' }])
  const turn = f.find('.protocol-turn[data-run-id="first"]'), block = turn.querySelector('[data-block-id="code"]'), copy = block.querySelector('.markdown-code-copy')
  const status = turn.querySelector('[data-block-id="status"]')
  update(3, [{ id: 'status', type: 'harness.unsupported', text: 'Completed' }, code])
  assert.equal(f.find('.protocol-turn[data-run-id="first"]'), turn)
  assert.equal(turn.querySelector('[data-block-id="code"]'), block)
  assert.equal(block.querySelector('.markdown-code-copy'), copy)
  assert.equal(turn.querySelector('[data-block-id="status"]'), status)
  assert.equal(status.textContent, 'Completed')
  assert.deepEqual(turn.querySelectorAll('.protocol-block').map(node => node.dataset.blockId), ['status', 'code'])
  update(4, [{ id: 'status', type: 'harness.unsupported', text: 'Completed' }])
  assert.equal(turn.querySelector('[data-block-id="code"]'), null)
  assert.equal(block.isConnected, false)
  update(5, [code])
  assert.notEqual(turn.querySelector('[data-block-id="code"]'), block)
  assert.equal(turn.querySelectorAll('.markdown-code-copy').length, 1)
})

test('native citation source offsets coexist with Markdown lists and emphasis without changing source text', t => {
  const f = fixture(t, { runs: [traceRun('cite', 'completed', { protocolBinding: { protocolId: 'anthropic-messages' } })], path: [{ id: 'node-cite', input: 'Question', output: 'Answer', sourceRunId: 'cite' }] })
  const text = '- **Alpha** detail\n- Beta [page](https://example.test/page)', citations = [
    { start: text.indexOf('Alpha'), end: text.indexOf('Alpha') + 5, url: 'https://example.test/alpha', title: 'Alpha source' },
    { start: text.indexOf('Beta'), end: text.indexOf('Beta') + 4, url: 'https://example.test/beta', title: 'Beta source' },
  ]
  f.state.views.set('cite', { ...projection('cite', text, 'committed', 2), protocolId: 'anthropic-messages', exchanges: [{ id: 'exchange', blocks: [{ id: 'text', type: 'anthropic.text', text, citations }] }] })
  f.panel.render()
  const block = f.find('.native-text'), content = block.querySelector('.markdown-content'), items = content.querySelector('ul').querySelectorAll('li')
  assert.equal(items.length, 2); assert.match(items[0].querySelector('strong').textContent, /Alpha/)
  assert.equal(items[0].querySelector('sup').textContent, '[1]'); assert.equal(items[1].querySelector('sup').textContent, '[2]')
  assert.deepEqual(content.querySelectorAll('sup a').map(link => link.href), ['https://example.test/alpha', 'https://example.test/beta'])
  assert.deepEqual(block.querySelector('ol[aria-label="引用来源"]').querySelectorAll('li').map(item => item.textContent), ['Alpha source', 'Beta source'])
  assert.equal(f.state.views.get('cite').exchanges[0].blocks[0].text, text)
  assert.doesNotMatch(content.textContent, /\*\*Alpha\*\*|\[page\]\(/)
})

test('only legacy dialogue falls back to saved Markdown when native presentation is unavailable', t => {
  const input = '**Question**\n\n- plain input', output = '**Answer**\n\n- first\n- second'
  const f = fixture(t, { path: [{ id: 'node-first', parentId: null, input, output, sourceRunId: 'first' }] })
  f.state.views.clear(); f.panel.render()
  const user = f.find('.message.user .message-content')
  assert.equal(user.textContent, input); assert.equal(user.querySelectorAll('strong, ul, li').length, 0)
  assert.equal(user.classList.contains('markdown-content'), false)
  assert.equal(f.find('.transcript').querySelector('.message.assistant'), null)
  assert.match(f.find('.native-display-missing').textContent, /原生模型展示暂不可用/)
  f.state.traceLoading = { total: 1, loaded: 0, pending: 1, failed: 0, states: new Map([['first', 'loading']]), errors: new Map() }; f.panel.render()
  assert.match(f.find('.native-display-missing').textContent, /正在读取原生模型展示/)
  f.state.traceLoading.states.set('first', 'failed'); f.state.notice = '协议展示版本不兼容，请一起升级。'; f.panel.render()
  assert.match(f.find('.native-display-missing').textContent, /原生模型展示暂不可用/)
  assert.doesNotMatch(f.find('.transcript').textContent, /Answer|firstsecond/)
  assert.match(f.find('.pane-notice').textContent, /协议展示版本不兼容/)
  f.state.session = { ...f.state.session, historyMode: 'dialogue-v1' }; f.panel.render()
  assert.equal(f.find('.message.user .message-content').textContent, input)
  const assistant = f.find('.message.assistant .message-content')
  assert.equal(assistant.querySelector('strong').textContent, 'Answer')
  assert.deepEqual(assistant.querySelectorAll('li').map(item => item.textContent), ['first', 'second'])
  assert.equal(f.find('textarea').disabled, true)
})

test('protocol reasoning uses Markdown but status and tool details keep literal operational facts', t => {
  const f = fixture(t), detail = '**stdout**\n- literal tool output'
  f.state.views.set('first', { ...projection('first', '', 'committed', 2), exchanges: [{ id: 'exchange', blocks: [
    { id: 'reasoning', type: 'chat.reasoning_content', text: '## Reasoning\n\n**Read** the manifest.' },
    { id: 'status', type: 'harness.unsupported', text: '**Waiting**' },
    { id: 'tool', type: 'chat.tool_call', name: '**Bash**', arguments: detail },
  ] }] }); f.panel.render()
  assert.equal(f.find('.native-reasoning h2').textContent, 'Reasoning')
  assert.equal(f.find('.native-reasoning-toggle').getAttribute('aria-expanded'), 'false')
  assert.equal(f.find('.native-reasoning-body').hidden, true)
  assert.equal(f.find('.native-notice').textContent, '**Waiting**')
  assert.equal(f.find('.native-notice').querySelectorAll('.markdown-content, strong').length, 0)
  assert.equal(f.find('.native-function-request pre').textContent, detail)
  assert.equal(f.find('.native-function-request').querySelectorAll('.markdown-content, ul, li').length, 0)
})

test('dialogue is the default and switching shows all session records without changing the branch or draft', t => {
  const f = fixture(t, { runs: [run('first'), run('other', 'failed', 'other-parent'), run('live', 'running'), run('stopping', 'cancelling', 'another-parent')],
    position: { follow: { runId: 'live', parentNodeId: 'node-first' }, focusedRunId: 'live' } })
  assert.equal(f.dialogue().getAttribute('aria-selected'), 'true')
  assert.equal(f.find('.transcript').hidden, false); assert.equal(f.find('.transcript').inert, false)
  assert.equal(f.find('.run-history').hidden, true); assert.equal(f.find('.run-history').inert, true)
  assert.equal(f.find('.composer').hidden, false)
  assert.equal(f.find('.transcript').querySelectorAll('.run-card').length, 0)
  assert.equal(f.find('.run-count').hidden, false); assert.match(f.history().getAttribute('aria-label'), /2/)
  const position = { ...f.state.position }
  f.history().click()
  assert.equal(f.history().getAttribute('aria-selected'), 'true')
  assert.equal(f.find('.transcript').hidden, true); assert.equal(f.find('.transcript').inert, true)
  assert.equal(f.find('.run-history').hidden, false); assert.equal(f.find('.run-history').inert, false)
  assert.equal(f.find('.composer').hidden, true); assert.equal(f.find('.composer').inert, true)
  assert.equal(f.find('.branch-controls').hidden, true)
  assert.equal(f.find('.run-history-scope').hidden, false); assert.match(f.find('.run-history-scope').textContent, /整个会话|全部|所有/)
  assert.deepEqual(f.find('.run-history').querySelectorAll('.trajectory-group').map(card => card.dataset.runId), ['first', 'live', 'other', 'stopping'])
  assert.deepEqual(f.state.position, { ...position, viewMode: 'runs' }); assert.equal(f.state.draft, 'Unsent draft')
  assert.equal(f.calls.some(([kind]) => ['navigate', 'focus', 'submit', 'cancel'].includes(kind)), false)
  f.state.runs = f.state.runs.map(item => ({ ...item, status: 'completed' })); f.panel.render()
  assert.equal(f.find('.run-count').hidden, true)
})

test('the two view tabs support keyboard selection and record reply navigation returns to dialogue', t => {
  const f = fixture(t)
  assert.equal(f.dialogue().getAttribute('role'), 'tab'); assert.equal(f.history().getAttribute('role'), 'tab')
  assert.equal(f.dialogue().dispatch('keydown', { key: 'ArrowRight' }).defaultPrevented, true)
  assert.equal(f.history().getAttribute('aria-selected'), 'true'); assert.equal(f.document.activeElement, f.history())
  f.history().dispatch('keydown', { key: 'Home' }); assert.equal(f.dialogue().getAttribute('aria-selected'), 'true')
  f.dialogue().dispatch('keydown', { key: 'End' }); assert.equal(f.history().getAttribute('aria-selected'), 'true')
  f.history().dispatch('keydown', { key: 'ArrowLeft' }); assert.equal(f.dialogue().getAttribute('aria-selected'), 'true')
  f.history().click()
  f.find('.trajectory-row').click()
  f.find('.trajectory-detail-actions button').click()
  assert.ok(f.calls.some(([kind, id]) => kind === 'navigate' && id === 'node-first'))
  assert.equal(f.dialogue().getAttribute('aria-selected'), 'true'); assert.equal(f.find('.composer').hidden, false)
})

test('empty run history stays visible and archived or legacy dialogue keeps its read-only boundary', t => {
  const f = fixture(t, { runs: [], path: [], position: { viewNodeId: null } })
  f.history().click()
  assert.equal(f.find('.run-history').hidden, false)
  assert.equal(f.find('.run-history-empty').hidden, false); assert.match(f.find('.run-history-empty').textContent, /暂无|没有|尚无/)
  assert.equal(f.find('.empty-state').hidden, true); assert.equal(f.find('.composer').hidden, true)
  for (const session of [{ archivedAt: '2026-10-02T00:00:00.000Z' }, { historyMode: 'dialogue-v1' }]) {
    f.state.session = { ...f.state.session, archivedAt: undefined, historyMode: 'native-local-v1', ...session }; f.panel.render(); f.dialogue().click()
    assert.equal(f.find('textarea').disabled, true); assert.equal(f.find('.send-button').disabled, true)
    f.history().click(); assert.equal(f.find('.composer').hidden, true)
  }
})

test('switching modes preserves native turn elements and updates provisional text while history is visible', t => {
  const f = fixture(t, { runs: [run('first'), run('live', 'running', 'node-first')], position: { focusedRunId: 'live' } })
  f.state.views.set('live', projection('live', 'Partial', 'provisional')); f.panel.render()
  const savedTurn = f.find('.transcript [data-run-id="first"]'), liveTurn = f.find('.transcript [data-run-id="live"]')
  f.history().click()
  f.state.views.set('live', projection('live', 'Partial answer grows', 'provisional', 2)); f.panel.render()
  f.dialogue().click()
  assert.equal(f.find('.transcript [data-run-id="first"]'), savedTurn)
  assert.equal(f.find('.transcript [data-run-id="live"]'), liveTurn)
  assert.match(liveTurn.textContent, /Partial answer grows/)
})

test('dialogue reasoning choices survive branch navigation and update on revisit until the panel closes', t => {
  const f = fixture(t, { runs: [run('first'), run('other')] }), originalPath = f.state.path
  const view = revision => ({ ...projection('first', '', 'committed', revision), exchanges: [{ id: 'exchange', blocks: [
    { id: 'thinking', type: 'chat.reasoning_content', text: `Reasoning ${revision}` },
    { id: 'text', type: 'chat.content', text: 'First branch answer' },
  ] }] })
  f.state.views.set('first', view(2)); f.panel.render()
  const turn = f.find('.transcript [data-run-id="first"]'), fold = turn.querySelector('.native-reasoning-toggle')
  fold.click(); assert.equal(fold.getAttribute('aria-expanded'), 'true')
  f.state.path = []; f.state.position.viewNodeId = 'node-other'; f.panel.render()
  f.state.path = [{ id: 'node-other', parentId: null, input: 'Other input', output: 'Other answer', sourceRunId: 'other' }]
  f.state.views.set('other', projection('other', 'Other answer')); f.state.views.set('first', view(3)); f.panel.render()
  assert.equal(turn.isConnected, false)
  f.state.path = originalPath; f.state.position.viewNodeId = 'node-first'; f.panel.render()
  assert.equal(f.find('.transcript [data-run-id="first"]'), turn)
  assert.equal(turn.querySelector('.native-reasoning-toggle'), fold)
  assert.equal(fold.getAttribute('aria-expanded'), 'true'); assert.match(turn.textContent, /Reasoning 3/)
})

test('a text-only trajectory shows model timing and opens safe output and reasoning in a persistent inspector', t => {
  const f = fixture(t, { runs: [traceRun('first')], position: { viewMode: 'runs' } })
  f.state.events.set('first', [modelStarted('exchange', 1), operationObserved('exchange', 4)])
  f.state.views.set('first', { ...projection('first', ''), exchanges: [{ id: 'exchange', inputs: [
    { id: 'system', role: 'system', text: 'Project instructions.' }, { id: 'context', role: 'context', text: 'Workspace context.' },
    { id: 'user', role: 'user', text: 'Prepared: Input first' },
  ], blocks: [{ id: 'reasoning', type: 'chat.reasoning_content', text: 'Read the manifest.' }, { id: 'text', type: 'chat.content', text: 'This is AnyboxV2.' }] }] })
  f.panel.render()
  const group = f.find('.trajectory-group'), rows = group.querySelectorAll('.trajectory-row')
  assert.deepEqual(rows.map(row => row.dataset.role), ['system', 'context', 'user', 'assistant'])
  assert.equal(rows[2].querySelector('.trajectory-preview').textContent, 'Input first')
  assert.equal(rows[3].querySelector('.trajectory-row-state').textContent, '3 s')
  assert.match(group.querySelector('.trajectory-group-heading').textContent, /1 次模型/)
  assert.equal(group.querySelectorAll('[data-role="tool"]').length, 0)
  rows[3].click()
  const inspector = f.find('.trajectory-inspector')
  assert.equal(inspector.hidden, false); assert.match(inspector.textContent, /Read the manifest/); assert.match(inspector.textContent, /This is AnyboxV2/)
  const nativeTurn = inspector.querySelector('.protocol-turn'), fold = inspector.querySelector('.native-reasoning-toggle')
  assert.equal(fold.getAttribute('aria-expanded'), 'false')
  fold.click(); assert.equal(fold.getAttribute('aria-expanded'), 'true')
  const selected = f.find('.trajectory-row[aria-selected="true"]').dataset.rowId
  f.state.views.set('first', { ...f.state.views.get('first'), viewRevision: 2, exchanges: [{ id: 'exchange', blocks: [{ id: 'text', type: 'chat.content', text: 'Updated output.' }] }] })
  f.panel.render()
  assert.equal(f.find('.trajectory-row[aria-selected="true"]').dataset.rowId, selected)
  assert.match(inspector.textContent, /Updated output/)
  assert.equal(inspector.querySelector('.protocol-turn'), nativeTurn)
  f.find('.trajectory-detail-close').click(); assert.equal(inspector.hidden, true)
  assert.equal(f.document.activeElement.dataset.rowId, selected)
})

test('dialogue tool requests adopt durable outcomes independently of model frames', t => {
  const f = fixture(t, { runs: [traceRun('live', 'running')], path: [{ id: 'node-live', input: 'Question', output: '', sourceRunId: 'live' }] }), request = { id: 'request', type: 'chat.tool_call', name: 'bash', requestId: 'call', arguments: '{"command":"pwd"}' }
  f.state.runs = [traceRun('live', 'running')]
  f.state.views.set('live', { ...projection('live', '', 'provisional'), exchanges: [{ id: 'exchange', blocks: [request] }] })
  f.state.events.set('live', [modelStarted('exchange', 0), operationObserved('exchange', 1)])
  f.state.traceLoading = { states: new Map([['live', 'loading']]) }
  f.panel.render()
  const turn = f.find('.protocol-turn[data-run-id="live"]'), nativeRequest = turn.querySelector('[data-block-id="request"]')
  assert.match(nativeRequest.textContent, /执行事实待同步/)
  assert.equal(nativeRequest.querySelector('.tool-call'), null)
  const toggle = nativeRequest.querySelector('.native-tool-summary'), body = nativeRequest.querySelector('.native-tool-details')
  assert.equal(toggle.getAttribute('aria-expanded'), 'false'); assert.equal(body.hidden, true)
  toggle.click(); toggle.focus(); body.scrollTop = 42
  f.state.events.set('live', [...f.state.events.get('live'),
    { kind: 'tool-started', requestId: 'call', name: 'bash', command: 'pwd', at: traceAt(2) },
    { kind: 'tool-observed', requestId: 'call', name: 'bash', exitCode: 0, signal: null, stdout: '/project', stderr: '', truncated: false, at: traceAt(3) }])
  f.state.traceLoading.states.set('live', 'loaded'); f.panel.render()
  assert.equal(f.find('.protocol-turn[data-run-id="live"]'), turn)
  assert.equal(turn.querySelector('[data-block-id="request"]'), nativeRequest)
  assert.equal(nativeRequest.querySelector('.native-tool-summary'), toggle); assert.equal(f.document.activeElement, toggle)
  assert.equal(body.hidden, false); assert.equal(body.scrollTop, 42)
  assert.equal(nativeRequest.querySelector('.tool-command').textContent, '$ pwd')
  assert.ok(nativeRequest.querySelectorAll('.tool-output').some(output => output.textContent === '/project'))
  assert.doesNotMatch(nativeRequest.textContent, /执行事实待同步|执行结果未记录/)
})

test('dialogue tool folds survive branch and view switches independently from detailed trajectory mounts', t => {
  const f = fixture(t), request = { id: 'request', type: 'chat.tool_call', requestId: 'call', name: 'bash', arguments: '{"command":"pwd"}' }
  const snapshot = revision => ({ ...projection('first', '', 'committed', revision), exchanges: [{ id: 'exchange', blocks: [request] }] })
  f.state.views.set('first', snapshot(2))
  f.state.events.set('first', [modelStarted('exchange', 0), operationObserved('exchange', 1),
    { kind: 'tool-started', requestId: 'call', name: 'bash', command: 'pwd', at: traceAt(2) },
    { kind: 'tool-observed', requestId: 'call', name: 'bash', exitCode: 0, signal: null, stdout: '/project', stderr: '', truncated: false, at: traceAt(3) }])
  f.panel.render()
  const turn = f.find('.transcript [data-run-id="first"]'), toggle = turn.querySelector('.native-function-request').querySelector('.native-tool-summary'), body = turn.querySelector('.native-tool-details')
  assert.equal(body.hidden, true); toggle.click(); body.scrollTop = 29
  const oldPath = f.state.path
  f.state.path = []; f.state.position = { viewNodeId: null }; f.panel.render()
  f.state.views.set('first', snapshot(3)); f.state.path = oldPath; f.state.position = { viewNodeId: 'node-first' }; f.panel.render()
  assert.equal(f.find('.transcript [data-run-id="first"]'), turn); assert.equal(turn.querySelector('.native-function-request').querySelector('.native-tool-summary'), toggle)
  assert.equal(body.hidden, false); assert.equal(body.scrollTop, 29)
  f.history().click()
  const modelRow = f.find('.trajectory-group').querySelector('[data-role="assistant"]'); modelRow.click()
  const detail = f.find('.trajectory-inspector')
  assert.ok(detail.querySelectorAll('.native-tool-summary').every(summary => summary.hidden), 'model inspector uses detail presentation')
  assert.equal(detail.querySelector('.native-tool-group-toggle'), null, 'model inspector does not add collapsed tool groups')
  assert.equal(detail.querySelector('.native-tool-details').hidden, false)
  f.dialogue().click(); assert.equal(body.hidden, false); assert.equal(body.scrollTop, 29)
  f.panel.dispose()
  const fresh = f.mount({ dialogue: 0 }); assert.equal(fresh.element.querySelector('.native-tool-details').hidden, true)
})

test('trajectory tool details retain copy focus and scroll across durable updates and abort detached copy actions', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), copied = []
  let settleCopy
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: value => {
    copied.push(value); return new Promise(resolve => { settleCopy = resolve })
  } } } })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'navigator', previous); else delete globalThis.navigator })
  const f = fixture(t, { runs: [traceRun('first', 'running')], position: { viewMode: 'runs' } })
  const started = [modelStarted('exchange', 0), operationObserved('exchange', 1), { kind: 'tool-started', requestId: 'call', name: 'bash', command: 'npm test', at: traceAt(2) }]
  f.state.events.set('first', started); f.panel.render(); f.find('.trajectory-row[data-role="tool"]').click()
  const inspector = f.find('.trajectory-inspector'), card = inspector.querySelector('.tool-call')
  const copy = card.querySelectorAll('.tool-copy').find(button => button.dataset.copyField === 'command')
  copy.focus(); inspector.scrollTop = 54; inspector.dispatch('scroll')
  f.state.events.set('first', [...started, { kind: 'tool-observed', requestId: 'call', name: 'bash', exitCode: 0, signal: null, stdout: 'Done', stderr: '', truncated: false, at: traceAt(4) }])
  f.state.runs = [traceRun('first')]; f.panel.render()
  assert.equal(inspector.querySelector('.tool-call'), card)
  assert.equal(card.querySelectorAll('.tool-copy').find(button => button.dataset.copyField === 'command'), copy)
  assert.equal(f.document.activeElement, copy); assert.equal(inspector.scrollTop, 54)
  f.find('.trajectory-row[data-role="user"]').click(); f.find('.trajectory-row[data-role="tool"]').click()
  assert.equal(inspector.querySelector('.tool-call'), card, 'row selection reuses the tool details mount')
  f.find('.trajectory-detail-close').click(); f.find('.trajectory-row[data-role="tool"]').click()
  assert.equal(inspector.querySelector('.tool-call'), card, 'closing the inspector keeps the panel-local mount')
  copy.click(); assert.deepEqual(copied, ['npm test'])
  const detachedText = copy.textContent
  f.panel.dispose(); settleCopy(); await Promise.resolve(); await Promise.resolve()
  assert.equal(copy.textContent, detachedText, 'a completed clipboard promise cannot change disposed content')
  copy.click(); await Promise.resolve(); assert.deepEqual(copied, ['npm test'])
})

test('a native trajectory preserves citation blocks and reasoning expansion through updates', t => {
  const f = fixture(t, { runs: [traceRun('first', 'running')], position: { viewMode: 'runs' } })
  f.state.runs[0].protocolBinding = { protocolId: 'anthropic-messages' }
  f.state.runs[0].modelSnapshot.protocolId = 'anthropic-messages'
  f.state.events.set('first', [modelStarted('exchange', 0)])
  const snapshot = viewRevision => ({ ...projection('first', '', 'provisional', viewRevision), protocolId: 'anthropic-messages', exchanges: [{
    id: 'exchange', blocks: [
      { id: 'thinking', type: 'anthropic.thinking', text: `Thinking ${viewRevision}` },
      { id: 'answer', type: 'anthropic.text', text: 'Answer', citations: [{ start: 0, end: 6, url: 'https://example.test/source', title: 'Source' }] },
    ], nativeState: { type: 'anthropic.state', stopReason: 'pause_turn' },
  }] })
  f.state.views.set('first', snapshot(1)); f.panel.render()
  const row = f.find('.trajectory-row[data-role="assistant"]'); row.click()
  const inspector = f.find('.trajectory-inspector'), turn = inspector.querySelector('.protocol-turn')
  const fold = inspector.querySelector('.native-reasoning-toggle'); fold.click()
  fold.focus()
  assert.equal(fold.getAttribute('aria-expanded'), 'true')
  assert.equal(inspector.querySelector('sup a').href, 'https://example.test/source')
  f.state.views.set('first', snapshot(2)); f.panel.render()
  assert.equal(inspector.querySelector('.protocol-turn'), turn)
  assert.equal(inspector.querySelector('.native-reasoning-toggle'), fold)
  assert.equal(fold.getAttribute('aria-expanded'), 'true')
  assert.equal(f.document.activeElement, fold)
  assert.match(inspector.textContent, /Thinking 2/)
  assert.equal(f.find('.trajectory-row[aria-selected="true"]').dataset.rowId, row.dataset.rowId)
})

test('dialogue native toggles keep focus while frames and durable tool events update', t => {
  const f = fixture(t, { runs: [traceRun('focus', 'running')], path: [{ id: 'node-focus', input: 'Question', output: '', sourceRunId: 'focus' }] })
  const view = revision => ({ ...projection('focus', '', 'provisional', revision), exchanges: [{ id: 'exchange', blocks: [
    { id: 'thinking', type: 'chat.reasoning_content', text: `Thinking ${revision}` },
    { id: 'request', type: 'chat.tool_call', requestId: 'call', name: 'bash', arguments: '{"command":"pwd"}' },
  ] }] })
  f.state.views.set('focus', view(1)); f.state.events.set('focus', [modelStarted('exchange', 0)]); f.panel.render()
  const turn = f.find('.protocol-turn[data-run-id="focus"]'), fold = turn.querySelector('.native-reasoning-toggle')
  fold.click(); fold.focus()
  f.state.views.set('focus', view(2)); f.panel.render()
  assert.equal(f.document.activeElement, fold)
  assert.equal(fold.getAttribute('aria-expanded'), 'true')
  f.state.events.set('focus', [...f.state.events.get('focus'), operationObserved('exchange', 1),
    { kind: 'tool-started', requestId: 'call', name: 'bash', command: 'pwd', at: traceAt(2) }]); f.panel.render()
  assert.equal(f.document.activeElement, fold)
  assert.equal(f.find('.protocol-turn[data-run-id="focus"]'), turn)
})

test('trajectory reasoning choices survive row selection, inspector close and view switching for the panel lifetime', t => {
  const f = fixture(t, { runs: [traceRun('folds', 'running')], path: [], position: { viewMode: 'runs' } })
  f.state.events.set('folds', [modelStarted('one', 0), operationObserved('one', 1), modelStarted('two', 2)])
  const view = revision => ({ ...projection('folds', '', 'provisional', revision), exchanges: ['one', 'two'].map(id => ({ id, blocks: [
    { id: 'thinking', type: 'chat.reasoning_content', text: `${id} reasoning ${revision}` },
    { id: 'answer', type: 'chat.content', text: `${id} answer ${revision}` },
  ] })) })
  f.state.views.set('folds', view(1)); f.panel.render()
  const modelRows = () => f.find('.trajectory-group[data-run-id="folds"]').querySelectorAll('.trajectory-row[data-role="assistant"]')
  modelRows()[0].click()
  const inspector = f.find('.trajectory-inspector'), turn = inspector.querySelector('.protocol-turn'), fold = inspector.querySelector('.native-reasoning-toggle')
  fold.click(); assert.equal(fold.getAttribute('aria-expanded'), 'true')
  modelRows()[1].click(); assert.equal(inspector.querySelector('.native-reasoning-toggle').getAttribute('aria-expanded'), 'false')
  modelRows()[0].click()
  assert.equal(inspector.querySelector('.protocol-turn'), turn); assert.equal(inspector.querySelector('.native-reasoning-toggle'), fold)
  assert.equal(fold.getAttribute('aria-expanded'), 'true')
  f.find('.trajectory-detail-close').click(); modelRows()[0].click()
  assert.equal(inspector.querySelector('.native-reasoning-toggle'), fold); assert.equal(fold.getAttribute('aria-expanded'), 'true')
  f.dialogue().click(); f.state.views.set('folds', view(2)); f.panel.render(); f.history().click()
  assert.equal(inspector.querySelector('.native-reasoning-toggle'), fold); assert.equal(fold.getAttribute('aria-expanded'), 'true')
  assert.match(inspector.textContent, /one reasoning 2/)
  f.state.runs = []; f.panel.render(); fold.click()
  assert.equal(fold.getAttribute('aria-expanded'), 'true', 'removing the owning Run disposes its cached toggle listener')
})

test('device-qualified views match local operations without selecting another device exchange', t => {
  const instances = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222']
  const runs = instances.map((instance, index) => mapResourceIds(traceRun('shared-run', 'completed', { output: `Device ${index + 1}` }), id => scopedId(instance, id)))
  const f = fixture(t, { runs, position: { viewMode: 'runs' }, path: [] }); f.state.views.clear()
  for (const [index, instance] of instances.entries()) {
    const id = scopedId(instance, 'shared-run'), view = mapResourceIds(projection('shared-run', `Device ${index + 1}`), value => scopedId(instance, value))
    view.exchanges.unshift({ id: scopedId(instances[1 - index], 'exchange'), blocks: [{ id: 'foreign', type: 'chat.content', text: 'Foreign output' }] })
    f.state.events.set(id, [modelStarted('exchange', 1), operationObserved('exchange', 4)]); f.state.views.set(id, view)
  }
  f.panel.render()
  for (const [index, instance] of instances.entries()) {
    const row = f.find(`.trajectory-group[data-run-id="${scopedId(instance, 'shared-run')}"] [data-role="assistant"]`)
    assert.equal(row.querySelector('.trajectory-preview').textContent, `Device ${index + 1}`)
    row.click(); assert.doesNotMatch(f.find('.trajectory-inspector').textContent, /Foreign output/)
  }
})

test('cancelled trajectories retain ordered tool exits and partial patch facts', t => {
  const f = fixture(t, { runs: [traceRun('mixed', 'cancelled')], position: { viewMode: 'runs' }, path: [] })
  const patch = '*** Begin Patch\n*** Update File: saved.txt\n@@\n-old\n+new\n*** End Patch'
  const result = { status: 'partial', changes: [{ kind: 'updated', path: '/project/saved.txt' }], pending: [{ kind: 'delete', path: '/project/pending.txt' }], diagnostic: { code: 'commit-failed', message: 'Permission denied' } }
  f.state.events.set('mixed', [modelStarted('first-model', 1), operationObserved('first-model', 2),
    { kind: 'tool-started', requestId: 'bash', name: 'bash', command: 'npm test', at: traceAt(2) },
    { kind: 'tool-observed', requestId: 'bash', name: 'bash', exitCode: 2, signal: null, stdout: 'Tests ran.', stderr: 'One failed.', truncated: true, at: traceAt(5) },
    { kind: 'tool-started', requestId: 'patch', name: 'apply_patch', patch, patchTruncated: false, at: traceAt(5) },
    { kind: 'tool-observed', requestId: 'patch', name: 'apply_patch', result, at: traceAt(7) }, modelStarted('last-model', 7)])
  f.state.views.set('mixed', { ...projection('mixed', ''), exchanges: [{ id: 'first-model', blocks: [{ id: 'text', type: 'chat.content', text: 'Checking files.' }] }] })
  f.panel.render()
  const rows = f.find('.trajectory-group').querySelectorAll('.trajectory-row')
  assert.deepEqual(rows.map(row => row.dataset.role), ['user', 'assistant', 'tool', 'tool', 'assistant'])
  assert.deepEqual(rows.map(row => row.querySelector('.trajectory-row-state').textContent), ['', '1 s', '3 s', '2 s', '已取消'])
  rows[2].click(); assert.match(f.find('.trajectory-inspector').textContent, /退出码：2/); assert.match(f.find('.trajectory-inspector').textContent, /Tests ran\./); assert.match(f.find('.trajectory-inspector').textContent, /输出摘要已截断/)
  rows[3].click(); assert.ok(f.find('.trajectory-inspector').querySelectorAll('.tool-output').some(output => output.textContent === '修改 /project/saved.txt'))
  assert.ok(f.find('.trajectory-inspector').querySelectorAll('.tool-output').some(output => output.textContent === '删除 /project/pending.txt'))
  assert.match(f.find('.trajectory-inspector').textContent, /commit-failed：Permission denied/)
  f.find('[data-calls]').click(); assert.equal(f.find('.trajectory-group').querySelectorAll('[data-role="tool"]').length, 0)
  f.find('.trajectory-group').querySelectorAll('[data-role="assistant"]').at(-1).click()
  assert.equal(f.find('[data-calls]').getAttribute('aria-pressed'), 'true')
  f.find('[data-calls]').click(); assert.equal(f.find('.trajectory-group').querySelectorAll('[data-role="tool"]').length, 2)
  const fold = f.find('.trajectory-group-heading'); fold.focus(); fold.click(); assert.equal(f.document.activeElement.dataset.turnRun, 'mixed'); f.find('.trajectory-group-heading').click()
  f.find('[data-turns]').click(); assert.deepEqual(f.find('.trajectory-group').querySelectorAll('.trajectory-row').map(row => row.dataset.role), ['user'])
  f.find('[data-turns]').click()
  f.find('.trajectory-bar[data-row-id="mixed:tool:0:bash:bash"]').click()
  assert.match(f.find('.trajectory-inspector').textContent, /npm test/)
})

test('legacy records show known content and distinguish missing history without inventing timing', t => {
  const old = traceRun('legacy', 'completed', { history: { kind: 'legacy-unknown' }, modelSnapshot: null, protocolBinding: undefined, createdAt: 'unknown', updatedAt: undefined })
  const f = fixture(t, { runs: [old], position: { viewMode: 'runs' }, path: [] })
  f.state.events.set('legacy', []); f.panel.render()
  assert.match(f.find('.trajectory-group-heading').textContent, /旧版记录 · 起点未记录/)
  assert.match(f.find('.trajectory-group').textContent, /Answer legacy/)
  assert.doesNotMatch(f.find('.trajectory-group').textContent, /0 ms|NaN|undefined/)
  f.find('[data-duration]').click(); assert.match(f.find('.trajectory-timing-note').textContent, /暂无可用耗时记录/)
  f.find('.trajectory-row[data-role="assistant"]').click(); assert.match(f.find('.trajectory-inspector').textContent, /Answer legacy/)
})

test('native trajectory summaries remain searchable while a missing structured inspector shows status and metadata', t => {
  const f = fixture(t, { runs: [traceRun('first')], position: { viewMode: 'runs' } })
  f.state.events.set('first', [modelStarted('exchange', 0), operationObserved('exchange', 2)])
  f.state.views.clear(); f.state.traceLoading = { total: 1, loaded: 0, pending: 1, failed: 0, states: new Map([['first', 'loading']]), errors: new Map() }; f.panel.render()
  const row = f.find('.trajectory-row[data-role="assistant"]'); assert.match(row.textContent, /Answer first/); row.click()
  const inspector = f.find('.trajectory-inspector')
  assert.match(inspector.querySelector('.native-display-missing').textContent, /正在读取原生模型展示/)
  assert.doesNotMatch(inspector.textContent, /Answer first/); assert.match(inspector.textContent, /deepseek-chat|chat-completions/)
  assert.equal(inspector.querySelector('.protocol-turn'), null)
  f.state.traceLoading.states.set('first', 'failed'); f.panel.render()
  assert.match(inspector.querySelector('.native-display-missing').textContent, /原生模型展示暂不可用/)
  assert.doesNotMatch(inspector.textContent, /Answer first/)
  f.state.events.set('first', []); f.panel.render(); f.find('.trajectory-row[data-role="assistant"]').click()
  assert.match(inspector.querySelector('.native-display-missing').textContent, /原生模型展示暂不可用/)
  assert.doesNotMatch(inspector.textContent, /Answer first/)
})

test('a bounded native trajectory inspector keeps its truncation notice without rendering aggregate saved output', t => {
  const saved = `Flattened saved beginning NEEDLE ${'unbounded '.repeat(6000)}Saved end`
  const f = fixture(t, { runs: [traceRun('first', 'completed', { output: saved })], position: { viewMode: 'runs' } })
  f.state.events.set('first', [modelStarted('exchange', 0), operationObserved('exchange', 2)])
  f.state.views.set('first', { ...projection('first', 'Bounded native tail'), exchanges: [
    { id: 'display-limit', blocks: [{ id: 'display-limit', type: 'harness.display_limit', text: 'Native display content is truncated.' }] },
    ...projection('first', 'Bounded native tail').exchanges,
  ] }); f.panel.render()
  f.find('.trajectory-row[data-role="assistant"]').click()
  const inspector = f.find('.trajectory-inspector')
  assert.match(inspector.textContent, /Bounded native tail/)
  assert.equal(inspector.querySelector('.native-notice').textContent, 'Native display content is truncated.')
  assert.doesNotMatch(inspector.textContent, /Flattened saved beginning|unbounded|Saved end|已保存最终回复/)
  const input = f.find('.trajectory-search input'); input.value = 'NEEDLE'; input.dispatch('input')
  assert.ok(f.find('.trajectory-row[data-role="assistant"]'), 'derived search still finds complete saved text')
})

test('search preserves the selected row and scroll, indexes omitted content and reports unfinished reads', t => {
  const f = fixture(t, { runs: [traceRun('first')], position: { viewMode: 'runs' } })
  f.state.events.set('first', [modelStarted('exchange', 1), operationObserved('exchange', 2)])
  f.state.views.set('first', projection('first', `${'Long output '.repeat(40)}UNIQUE needle`)); f.panel.render()
  f.find('.trajectory-row[data-role="assistant"]').click()
  const selection = f.find('.trajectory-row[aria-selected="true"]').dataset.rowId, scroll = f.find('.trajectory-scroll')
  scroll.scrollTop = 123
  const input = f.find('.trajectory-search input'); input.value = 'unique NEEDLE'; input.dispatch('input')
  assert.equal(f.find('.trajectory-group').querySelectorAll('.trajectory-row').length, 1)
  assert.ok(f.calls.some(([kind, query]) => kind === 'search' && query === 'unique NEEDLE'))
  input.value = ''; input.dispatch('input'); assert.equal(scroll.scrollTop, 123)
  assert.equal(f.find('.trajectory-row[aria-selected="true"]').dataset.rowId, selection)
  f.state.traceLoading = { total: 1, loaded: 0, pending: 1, failed: 0, states: new Map([['first', 'loading']]), errors: new Map() }
  input.value = 'missing'; input.dispatch('input')
  assert.match(f.find('.run-history-empty').textContent, /正在搜索其余历史/)
  assert.doesNotMatch(f.find('.run-history-empty').textContent, /没有匹配/)
  input.dispatch('keydown', { key: 'Escape' }); assert.equal(input.value, '')
  input.value = 'UNIQUE'; input.dispatch('input')
  f.find('.trajectory-bar[data-role="user"]').click()
  assert.equal(input.value, '', 'timeline navigation clears a filter hiding its target')
  assert.equal(f.find('.trajectory-row[aria-selected="true"]').dataset.role, 'user')
})

test('inspector scroll survives hidden output updates without zero-size writes', t => {
  const f = fixture(t, { runs: [traceRun('first')], position: { viewMode: 'runs' } })
  f.state.events.set('first', [modelStarted('exchange', 1), operationObserved('exchange', 2)])
  f.panel.render(); f.find('.trajectory-row[data-role="assistant"]').click()
  const inspector = f.find('.trajectory-inspector')
  inspector.scrollTop = 230; inspector.dispatch('scroll')
  f.panel.element.hidden = true; inspector.scrollTop = 0
  f.state.views.set('first', projection('first', 'New hidden output', 'committed', 2)); f.panel.render()
  assert.equal(inspector.scrollTop, 0, 'hidden detail does not write layout')
  f.panel.element.hidden = false; f.panel.render()
  assert.equal(inspector.scrollTop, 230)
})

test('row keyboard selection and literal text keep safe content out of HTML', t => {
  const payload = '<img src=x onerror="attack()">'
  const f = fixture(t, { runs: [traceRun('first')], position: { viewMode: 'runs' } })
  f.state.events.set('first', [modelStarted('exchange', 1), operationObserved('exchange', 2),
    { kind: 'tool-started', requestId: 'literal', name: 'bash', command: payload, at: traceAt(2) },
    { kind: 'tool-observed', requestId: 'literal', name: 'bash', exitCode: 0, signal: null, stdout: '<script>attack()</script>', truncated: false, at: traceAt(3) }])
  f.state.views.set('first', projection('first', payload)); f.panel.render()
  const first = f.find('.trajectory-row'); first.dispatch('keydown', { key: 'ArrowDown' })
  assert.equal(f.find('.trajectory-row[aria-selected="true"]').dataset.role, 'assistant')
  assert.ok(f.find('.trajectory-inspector .native-text').textContent.includes(payload)); assert.equal(f.find('.trajectory-inspector .native-text').querySelectorAll('img, script, svg, iframe').length, 0)
  f.find('.trajectory-row[aria-selected="true"]').dispatch('keydown', { key: 'End' })
  assert.equal(f.find('.trajectory-row[aria-selected="true"]').dataset.role, 'tool')
  assert.equal(f.find('.tool-command').textContent, `$ ${payload}`); assert.equal(f.find('.tool-call').querySelectorAll('img, script, svg, iframe').length, 0)
  f.find('.trajectory-inspector').dispatch('keydown', { key: 'Escape' }); assert.equal(f.find('.trajectory-inspector').hidden, true)
})

for (const status of ['failed', 'cancelled', 'interrupted']) test(`${status} runs keep dialogue notices brief and link to the matching record`, t => {
  const item = { ...run('terminal', status, 'node-first'), error: 'Detailed provider diagnostic' }
  const f = fixture(t, { runs: [run('first'), item], position: { focusedRunId: item.id } })
  f.state.notice = status === 'failed' ? `本次运行失败：${item.error}` : status === 'cancelled' ? '本次运行已取消。' : '本次运行意外中断，请重新发送。'
  f.panel.render()
  const notice = f.find('.pane-notice')
  assert.equal(notice.hidden, false); assert.doesNotMatch(notice.textContent, /Detailed provider diagnostic/)
  assert.equal(f.find('.transcript').querySelectorAll('.run-card').length, 0)
  assert.equal(f.find('.transcript').querySelectorAll('.protocol-turn').length, 1, 'terminal runs do not become assistant turns')
  notice.querySelector('[data-show-run]').click()
  assert.equal(f.history().getAttribute('aria-selected'), 'true')
  const card = f.find('.trajectory-row[aria-selected="true"]')
  assert.equal(card.dataset.runId, item.id); assert.match(f.find('.trajectory-inspector').textContent, /Detailed provider diagnostic/)
  assert.ok(f.calls.some(([kind, id]) => kind === 'focus' && id === item.id))
  assert.equal(f.state.position.viewNodeId, 'node-first'); assert.equal(f.state.draft, 'Unsent draft')
})

test('each view retains its own scroll and ignores hidden or zero-size measurements', t => {
  const f = fixture(t, { initialScroll: { dialogue: 120 } })
  const transcript = f.find('.transcript'), history = f.find('.trajectory-scroll')
  assert.equal(transcript.scrollTop, 120, 'first connected render retains the supplied reading position')
  transcript.scrollTop = 240
  f.history().click()
  assert.equal(history.scrollTop, history.scrollHeight, 'first entry follows the latest record')
  history.scrollTop = 410
  f.dialogue().click()
  assert.equal(transcript.scrollTop, 240)
  transcript.scrollTop = 260
  f.history().click()
  assert.equal(history.scrollTop, 410)
  assert.deepEqual(f.panel.captureScroll(), { dialogue: 260, runs: 410 })
  f.panel.element.hidden = true; transcript.scrollTop = 0; history.scrollTop = 0
  f.state.runs = [...f.state.runs, run('background')]; f.panel.render()
  assert.deepEqual(f.panel.captureScroll(), { dialogue: 260, runs: 410 })
  f.panel.element.hidden = false; f.panel.element.clientWidth = 0
  f.state.runs = [...f.state.runs, run('resized')]; f.panel.render()
  assert.deepEqual(f.panel.captureScroll(), { dialogue: 260, runs: 410 })
  f.panel.element.clientWidth = 640
  f.panel.restoreScroll({ dialogue: 260, runs: 410 }); f.dialogue().click()
  assert.equal(transcript.scrollTop, 260)
  f.history().click(); assert.equal(history.scrollTop, 410)
})

test('initial dialogue and history offsets survive the first connected render without an explicit restore', t => {
  const f = fixture(t, { initialScroll: { dialogue: 240, runs: 410 } })
  assert.equal(f.find('.transcript').scrollTop, 240)
  f.history().click(); assert.equal(f.find('.trajectory-scroll').scrollTop, 410)
  f.dialogue().click(); assert.equal(f.find('.transcript').scrollTop, 240)
})

test('a panel restored directly to run history uses its saved offset on the first connected render', t => {
  const f = fixture(t, { position: { viewMode: 'runs' }, initialScroll: { dialogue: 240, runs: 410 } })
  assert.equal(f.find('.trajectory-scroll').scrollTop, 410)
  f.dialogue().click(); assert.equal(f.find('.transcript').scrollTop, 240)
  f.history().click(); assert.equal(f.find('.trajectory-scroll').scrollTop, 410)
})

test('closing and mounting the panel again preserves both reading positions and the selected view', t => {
  const f = fixture(t, { initialScroll: { dialogue: 240, runs: 410 } })
  f.find('.transcript').scrollTop = 280
  f.history().click(); f.find('.trajectory-scroll').scrollTop = 460
  const saved = f.panel.dispose()
  assert.deepEqual(saved, { dialogue: 280, runs: 460 })
  f.panel.element.remove()
  const reopened = f.mount(saved)
  assert.equal(f.history().getAttribute('aria-selected'), 'true')
  assert.equal(f.find('.trajectory-scroll').scrollTop, 460)
  f.dialogue().click(); assert.equal(f.find('.transcript').scrollTop, 280)
  f.history().click(); assert.equal(f.find('.trajectory-scroll').scrollTop, 460)
  assert.deepEqual(reopened.captureScroll(), saved)
})

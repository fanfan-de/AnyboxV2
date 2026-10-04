import assert from 'node:assert/strict'
import test from 'node:test'
import { getProtocolWebModule, decodeProtocolWebView } from '../dist/applications/harness/web/protocols/modules.js'
import { projectNativeExchange } from '../dist/applications/harness/core/protocol-agents/projection.js'

const content = {
  responses: [{ id: 'item-0', type: 'responses.message', phase: 'final_answer', content: [
    { id: 'item-0:part-0', type: 'output_text', text: 'Answer', signature: 'private' }] }],
  'anthropic-messages': [{ id: 'block-0', type: 'anthropic.text', text: 'Answer', signature: 'private' }],
  'chat-completions': [{ id: 'choice-0:content', type: 'chat.content', text: 'Answer', signature: 'private' }],
  'gemini-interactions': [{ id: 'step-0', type: 'gemini.model_output', content: [
    { id: 'step-0:part-0', type: 'text', text: 'Answer', signature: 'private' }] }],
}
const snapshot = protocolId => ({ envelopeVersion: 1, viewSchemaVersion: 2, protocolId,
  sessionId: 's', runId: 'r', viewRevision: 1, status: 'provisional',
  exchanges: [{ id: 'e', blocks: content[protocolId] ?? [] }] })

// The existing panel tests use a local DOM surface; this smaller surface also
// enforces insertBefore's detached-target rule to catch native child replacement.
function documentFixture() {
  const document = { activeElement: undefined }
  const matches = (node, selector) => {
    const type = /^\[data-native-type="([^"]+)"\]$/.exec(selector)?.[1]
    if (type) return node.dataset.nativeType === type
    return selector.startsWith('.') ? node.className.split(/\s+/).includes(selector.slice(1)) : node.tagName === selector
  }
  const createElement = tagName => {
    let ownText = ''
    const node = {
      ownerDocument: document, tagName, className: '', dataset: {}, attributes: {}, children: [], parentElement: undefined,
      hidden: false, inert: false, open: false, scrollTop: 0, listeners: new Map(),
      classList: {
        add(...names) { node.className = [...new Set([...node.className.split(/\s+/), ...names])].filter(Boolean).join(' ') },
        remove(...names) { node.className = node.className.split(/\s+/).filter(name => name && !names.includes(name)).join(' ') },
        contains(name) { return node.className.split(/\s+/).includes(name) },
        toggle(name, force) { const values = new Set(node.className.split(/\s+/).filter(Boolean)); if (force ?? !values.has(name)) values.add(name); else values.delete(name); node.className = [...values].join(' ') },
      },
      setAttribute(name, value) { this.attributes[name] = String(value) },
      getAttribute(name) { return this.attributes[name] ?? null },
      append(...children) { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child) } },
      insertBefore(child, target) {
        if (target !== null && target?.parentElement !== this) throw new Error('NotFoundError: insertBefore target is detached')
        if (child === target) return
        child.remove(); const index = target === null ? this.children.length : this.children.indexOf(target)
        child.parentElement = this; this.children.splice(index, 0, child)
      },
      replaceChildren(...children) { for (const child of this.children) child.parentElement = undefined; this.children = []; ownText = ''; this.append(...children) },
      remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = undefined },
      contains(child) { return child === this || this.children.some(node => node.contains(child)) },
      querySelectorAll(selector) { return this.children.flatMap(child => [...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector)]) },
      querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null },
      addEventListener(type, callback, options) { const listeners = this.listeners.get(type) ?? []; listeners.push({ callback, signal: options?.signal }); this.listeners.set(type, listeners) },
      click() { for (const listener of this.listeners.get('click') ?? []) if (!listener.signal?.aborted) listener.callback({ target: this }) },
      focus() { document.activeElement = this },
    }
    Object.defineProperties(node, {
      firstChild: { get: () => node.children[0] ?? null },
      childNodes: { get: () => node.children },
      isConnected: { get: () => node === document.body || Boolean(node.parentElement?.isConnected) },
      nextSibling: { get: () => node.parentElement?.children[node.parentElement.children.indexOf(node) + 1] ?? null },
      textContent: { get: () => ownText + node.children.map(child => child.textContent).join(''), set(value) { ownText = String(value); for (const child of node.children) child.parentElement = undefined; node.children = [] } },
    })
    return node
  }
  document.createElement = createElement
  document.createTextNode = text => { const node = createElement('#text'); node.textContent = text; return node }
  document.body = createElement('body')
  return document
}
function withDocument(t) {
  const previous = globalThis.document
  globalThis.document = documentFixture()
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous })
  return globalThis.document
}
const reasoningBlocks = text => ({
  responses: [{ id: 'item-0', type: 'responses.reasoning', summary: [{ id: 'item-0:summary-0', text }] }],
  'anthropic-messages': [{ id: 'block-0', type: 'anthropic.thinking', text }],
  'chat-completions': [{ id: 'choice-0:reasoning', type: 'chat.reasoning_content', text }],
  'gemini-interactions': [{ id: 'step-0', type: 'gemini.thought', summary: [{ id: 'step-0:summary-0', text }] }],
})

test('four independent Web bindings preserve text and own protocol decoding, reduction and mounts', () => {
  const ids = ['responses', 'chat-completions', 'anthropic-messages', 'gemini-interactions']
  const modules = ids.map(getProtocolWebModule)
  assert.equal(new Set(modules).size, 4)
  for (const module of modules) {
    const input = '  {{input}}\n<script>literal text</script> 中文  '
    assert.equal(module.encodeInput(input), input, 'no browser template expansion or semantic rewrite')
    assert.throws(() => module.encodeInput('   '), /请输入消息/)
    const decoded = module.decode(snapshot(module.protocolId))
    assert.equal(decoded.protocolId, module.protocolId)
    assert.doesNotMatch(JSON.stringify(decoded), /signature|private/)
    const other = snapshot(ids.find(id => id !== module.protocolId))
    assert.equal(module.decode(other), undefined)
    assert.equal(module.reduce(decoded, other), decoded)
    assert.throws(() => module.mount(other), /不兼容/, 'reject foreign mount before creating DOM')
    assert.equal(typeof module.mount, 'function')
    const latest = { ...decoded, viewRevision: 8, exchanges: [] }
    assert.equal(module.reduce(decoded, latest), latest)
    assert.equal(module.reduce(latest, decoded), latest)
    const committed = { ...decoded, status: 'committed' }
    assert.equal(module.reduce(latest, committed), committed)
    assert.equal(module.reduce(committed, latest), committed)
  }
})

test('unknown protocol and incompatible view schema never select a generic fallback', () => {
  for (const id of ['unknown', '__proto__', 'constructor', '', null, undefined]) {
    assert.equal(getProtocolWebModule(id), undefined)
    assert.equal(decodeProtocolWebView(snapshot(id)), undefined)
  }
  assert.equal(decodeProtocolWebView({ ...snapshot('responses'), viewSchemaVersion: 1 }), undefined)
  assert.equal(decodeProtocolWebView({ ...snapshot('responses'), viewSchemaVersion: 3 }), undefined)
  assert.equal(decodeProtocolWebView(null), undefined)
})

test('a protocol rejects a foreign content type even under its own protocol envelope', () => {
  const ids = Object.keys(content)
  for (const protocolId of ids) {
    const foreign = content[ids.find(id => id !== protocolId)]
    assert.equal(getProtocolWebModule(protocolId).decode({ ...snapshot(protocolId), exchanges: [{ id: 'e', blocks: foreign }] }), undefined)
  }
})

test('dedicated reasoning and hidden content whitelist only their public native semantics', () => {
  const reasoning = {
    responses: [{ id: 'item-0', type: 'responses.reasoning', summary: [{ id: 'item-0:summary-0', text: 'Summary' }], encrypted_content: 'private' }],
    'anthropic-messages': [{ id: 'block-0', type: 'anthropic.thinking', text: 'Thought', signature: 'private' },
      { id: 'block-1', type: 'anthropic.redacted_thinking', data: 'private' }],
    'chat-completions': [{ id: 'choice-0:reasoning', type: 'chat.reasoning_content', text: 'Reasoning', nativeReasoning: 'private' }],
    'gemini-interactions': [{ id: 'step-0', type: 'gemini.thought', summary: [{ id: 'step-0:summary-0', text: 'Summary' }], signature: 'private' }],
  }
  for (const [protocolId, blocks] of Object.entries(reasoning)) {
    const decoded = getProtocolWebModule(protocolId).decode({ ...snapshot(protocolId), exchanges: [{ id: 'e', blocks }] })
    assert.deepEqual(decoded.exchanges[0].blocks.map(block => block.type), blocks.map(block => block.type))
    assert.doesNotMatch(JSON.stringify(decoded), /private|signature|encrypted_content|nativeReasoning|"data"/)
  }
})

test('all four protocols encode image-only input and leave template expansion to the host', () => {
  for (const id of ['responses', 'anthropic-messages', 'gemini-interactions', 'chat-completions']) {
    const module = getProtocolWebModule(id)
    assert.equal(module.imageInput, true)
    assert.equal(module.encodeInput('', 2), '')
    assert.equal(module.encodeInput(' {{input}} ', 1), ' {{input}} ')
  }
})

test('native reasoning titles, default folds and focus survive active updates and committed replacement', t => {
  const document = withDocument(t)
  const titles = { responses: '推理摘要', 'anthropic-messages': '思考内容', 'chat-completions': '推理内容', 'gemini-interactions': '推理摘要' }
  const activeStates = { responses: { type: 'responses.state', status: 'in_progress' },
    'anthropic-messages': { type: 'anthropic.state' }, 'chat-completions': { type: 'chat.state' },
    'gemini-interactions': { type: 'gemini.state', status: 'in_progress' } }
  const returnedStates = { responses: { type: 'responses.state', status: 'completed' },
    'anthropic-messages': { type: 'anthropic.state', stopReason: 'end_turn' },
    'chat-completions': { type: 'chat.state', finishReason: 'stop' },
    'gemini-interactions': { type: 'gemini.state', status: 'completed' } }
  for (const protocolId of Object.keys(titles)) {
    const module = getProtocolWebModule(protocolId)
    const initial = { ...snapshot(protocolId), exchanges: [{ id: 'e', blocks: reasoningBlocks('First')[protocolId], nativeState: activeStates[protocolId] }] }
    const mounted = module.mount(initial); document.body.append(mounted.element)
    const block = mounted.element.querySelector('.native-reasoning'), toggle = block.querySelector('.native-reasoning-toggle')
    const body = block.querySelector('.native-reasoning-body')
    assert.ok(toggle.textContent.startsWith(titles[protocolId]), protocolId)
    assert.match(toggle.textContent, /生成中/, 'an active native state is not evidence that the response returned')
    assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(body.hidden, true); assert.equal(body.inert, true)
    toggle.click(); toggle.focus()
    mounted.update({ ...initial, viewRevision: 2, exchanges: [{ id: 'e', blocks: reasoningBlocks('Second')[protocolId], nativeState: activeStates[protocolId] }] })
    assert.equal(mounted.element.querySelector('.native-reasoning'), block)
    assert.equal(block.querySelector('.native-reasoning-toggle'), toggle)
    assert.equal(block.querySelector('.native-reasoning-body'), body)
    assert.equal(body.textContent, 'Second'); assert.equal(body.hidden, false)
    assert.equal(toggle.getAttribute('aria-expanded'), 'true'); assert.equal(document.activeElement, toggle)
    const committed = { ...initial, viewRevision: 3, status: 'committed', exchanges: [{ id: 'e', blocks: reasoningBlocks('Final')[protocolId], nativeState: returnedStates[protocolId] }] }
    mounted.update(committed)
    assert.equal(mounted.element.querySelector('.native-reasoning'), block)
    assert.equal(body.textContent, 'Final'); assert.equal(body.hidden, false); assert.equal(body.inert, false)
    assert.match(toggle.textContent, /已返回|已记录/)
    assert.equal(document.activeElement, toggle)
    const refreshed = module.mount(committed)
    assert.equal(refreshed.element.querySelector('.native-reasoning-body').hidden, true, 'a fresh panel restores the default fold')
    refreshed.dispose(); mounted.dispose()
    toggle.click(); assert.equal(body.hidden, false, 'disposed reasoning listeners cannot toggle')
  }
})

test('Responses safely replaces a same-ID text child with refusal while keeping the sibling and parent mounts', t => {
  const document = withDocument(t), module = getProtocolWebModule('responses')
  const initial = { ...snapshot('responses'), exchanges: [{ id: 'e', blocks: [{ id: 'item-0', type: 'responses.message', phase: 'commentary', content: [
    { id: 'part-0', type: 'output_text', text: 'Provisional' }, { id: 'part-1', type: 'output_text', text: 'Kept' }] }] }] }
  const mounted = module.mount(initial); document.body.append(mounted.element)
  const message = mounted.element.querySelector('[data-native-type="responses.message"]')
  const sibling = message.querySelectorAll('[data-native-type="responses.output_text"]')[1]
  mounted.update({ ...initial, status: 'committed', viewRevision: 2, exchanges: [{ id: 'e', blocks: [{ id: 'item-0', type: 'responses.message', phase: 'final_answer', content: [
    { id: 'part-0', type: 'refusal', text: 'Declined' }, { id: 'part-1', type: 'output_text', text: 'Kept' }] }] }] })
  assert.equal(mounted.element.querySelector('[data-native-type="responses.message"]'), message)
  assert.equal(message.querySelector('[data-native-type="responses.output_text"]'), sibling)
  assert.equal(message.querySelector('[data-native-type="responses.refusal"]').textContent, '请求被拒绝：Declined')
  assert.doesNotMatch(message.textContent, /Provisional/)
  assert.match(message.textContent, /最终回答/)
  mounted.dispose()
})

test('Gemini model output owns a separately identified nested native text component', t => {
  withDocument(t)
  const mounted = getProtocolWebModule('gemini-interactions').mount(snapshot('gemini-interactions'))
  const output = mounted.element.querySelector('[data-native-type="gemini.model_output"]')
  const text = output.querySelector('[data-native-type="gemini.text"]')
  assert.equal(text.textContent, 'Answer')
  assert.equal(text.dataset.partId, 'step-0:part-0')
  mounted.dispose()
})

test('block-level sources stay outside the text while positioned citations retain their source-list numbering', t => {
  withDocument(t)
  const module = getProtocolWebModule('responses')
  const body = citations => ({ ...snapshot('responses'), status: 'committed', exchanges: [{ id: 'e', blocks: [
    { id: 'item-0', type: 'responses.message', content: [{ id: 'part-0', type: 'output_text', text: 'Answer', citations }] }] }] })
  const blockSource = { start: 6, end: 6, url: 'https://example.test/block', title: 'Block source' }
  const mounted = module.mount(body([blockSource]))
  assert.equal(mounted.element.querySelectorAll('.markdown-citation').length, 0, 'missing positions cannot create an invented inline marker')
  assert.equal(mounted.element.querySelector('.native-sources').querySelectorAll('li').length, 1)
  mounted.update({ ...body([blockSource, { start: 0, end: 6, url: 'https://example.test/positioned', title: 'Positioned source' }]), viewRevision: 2 })
  const markers = mounted.element.querySelectorAll('.markdown-citation')
  assert.equal(markers.length, 1)
  assert.equal(markers[0].textContent, '[2]', 'inline citation numbers must identify the corresponding source row')
  assert.equal(mounted.element.querySelector('.native-sources').querySelectorAll('li').length, 2)
  mounted.dispose()
})

test('a mismatched Run context cannot attach another Run durable tool result to native requests', t => {
  withDocument(t)
  const requestTypes = { responses: 'responses.function_call', 'anthropic-messages': 'anthropic.tool_use',
    'chat-completions': 'chat.tool_call', 'gemini-interactions': 'gemini.function_call' }
  const fact = { exchangeId: 'e', requestId: 'call', name: 'bash', occurrence: 0, eventIndex: 1, modelEventIndex: 0,
    call: { id: 'call', name: 'bash', state: 'completed', command: 'pwd', exitCode: 0, signal: null, stdout: 'DURABLE-RESULT', stderr: '', truncated: false } }
  for (const [protocolId, type] of Object.entries(requestTypes)) {
    const initial = { ...snapshot(protocolId), exchanges: [{ id: 'e', blocks: [{ id: 'request', type, requestId: 'call', name: 'bash', arguments: '{"command":"pwd"}' }] }] }
    const toolContext = { runId: 'another-run', readiness: 'ready', runStatus: 'completed', facts: [fact] }
    const mounted = getProtocolWebModule(protocolId).mount(initial, { toolContext })
    assert.doesNotMatch(mounted.element.textContent, /DURABLE-RESULT/, 'matching exchange and call IDs alone are insufficient')
    mounted.update({ ...initial, viewRevision: 2 }, { toolContext: { ...toolContext, runId: 'r' } })
    assert.match(mounted.element.textContent, /DURABLE-RESULT/)
    mounted.update({ ...initial, viewRevision: 3 }, { toolContext: { ...toolContext, runId: 'r', readiness: 'failed', facts: [] } })
    assert.match(mounted.element.textContent, /执行记录读取失败/)
    assert.equal(mounted.element.querySelector('.native-tool-observation').hidden, true, 'stale facts are not visible after an unsuccessful read')
    mounted.dispose()
  }
})

const requestTypes = { responses: 'responses.function_call', 'anthropic-messages': 'anthropic.tool_use',
  'chat-completions': 'chat.tool_call', 'gemini-interactions': 'gemini.function_call' }
const toolRequest = (protocolId, id = 'request', requestId = 'call', arguments_ = '{"command":"pwd"}', name = 'bash') =>
  ({ id, type: requestTypes[protocolId], requestId, name, arguments: arguments_ })
const toolSnapshot = (protocolId, blocks, viewRevision = 1, exchanges) => ({ ...snapshot(protocolId), viewRevision,
  exchanges: exchanges ?? [{ id: 'e', blocks }] })
const toolFact = (requestId = 'call', extra = {}, exchangeId = 'e', occurrence = 0) => ({ exchangeId, requestId, name: extra.name ?? 'bash', occurrence,
  eventIndex: 1, modelEventIndex: 0, call: { id: requestId, name: 'bash', state: 'completed', command: 'pwd', exitCode: 0, signal: null, stdout: 'RESULT', stderr: '', truncated: false, ...extra } })
const compactOptions = (facts = [], readiness = 'ready') => ({ presentation: 'compact', toolContext: { runId: 'r', readiness, runStatus: 'running', facts } })

test('Chat hides empty native content between reasoning and tools without losing the text mount during updates', t => {
  const document = withDocument(t), protocolId = 'chat-completions', module = getProtocolWebModule(protocolId)
  const exchange = (id, text) => ({ id, ...projectNativeExchange(protocolId, { choices: [{ index: 0, finish_reason: 'tool_calls',
    message: { role: 'assistant', reasoning_content: 'Inspect the project', content: text,
      tool_calls: [{ id: 'call', type: 'function', function: { name: 'bash', arguments: '{"command":"pwd"}' } }] } }] }) })
  const view = (text, viewRevision) => ({ ...snapshot(protocolId), viewRevision, exchanges: [exchange('e', text), exchange('next', '')] })
  const initial = view('', 1)
  assert.deepEqual(initial.exchanges[0].blocks.map(block => block.type), ['chat.reasoning_content', 'chat.content', 'chat.tool_call'])
  assert.equal(initial.exchanges[0].blocks[1].text, '', 'native empty content remains in the projection')
  const mounted = module.mount(initial, compactOptions([toolFact(), toolFact('call', {}, 'next')]))
  document.body.append(mounted.element)
  const blocks = mounted.element.querySelectorAll('[data-native-type="chat.content"]'), content = blocks[0]
  const text = content.querySelector('.native-text'), reasoning = mounted.element.querySelector('.native-reasoning')
  const tool = mounted.element.querySelector('.native-function-request')
  assert.equal(blocks.length, 2)
  for (const block of blocks) { assert.equal(block.hidden, true); assert.equal(block.inert, true) }

  const visible = view('Checking the current directory.', 2)
  mounted.update(visible, compactOptions([toolFact(), toolFact('call', {}, 'next')]))
  assert.equal(mounted.element.querySelector('[data-native-type="chat.content"]'), content)
  assert.equal(content.querySelector('.native-text'), text)
  assert.equal(content.hidden, false); assert.equal(content.inert, false)
  assert.equal(content.textContent, 'Checking the current directory.')
  assert.equal(mounted.element.querySelector('.native-reasoning'), reasoning)
  assert.equal(mounted.element.querySelector('.native-function-request'), tool)
  assert.equal(blocks[1].hidden, true, 'another exchange with empty content remains hidden')

  const whitespace = view(' \n\t ', 3)
  mounted.update(whitespace, compactOptions([toolFact(), toolFact('call', {}, 'next')]))
  assert.equal(mounted.element.querySelector('[data-native-type="chat.content"]'), content)
  assert.equal(content.querySelector('.native-text'), text)
  assert.equal(content.hidden, true); assert.equal(content.inert, true)
  assert.equal(whitespace.exchanges[0].blocks[1].text, ' \n\t ', 'display visibility does not rewrite native text')
  assert.equal(mounted.element.querySelector('.native-reasoning'), reasoning)
  assert.equal(mounted.element.querySelector('.native-function-request'), tool)
  mounted.dispose()
})

test('four protocols fold local tools and retain detail controls, raw arguments, focus and scroll during fact updates', t => {
  const document = withDocument(t)
  for (const protocolId of Object.keys(requestTypes)) {
    const module = getProtocolWebModule(protocolId), initial = toolSnapshot(protocolId, [toolRequest(protocolId, 'request', 'call', '{"command":')])
    const mounted = module.mount(initial, compactOptions([], 'loading')); document.body.append(mounted.element)
    const request = mounted.element.querySelector('.native-function-request'), toggle = request.querySelector('.native-tool-summary'), body = request.querySelector('.native-tool-details')
    assert.ok(toggle, protocolId); assert.equal(toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(body.hidden, true); assert.equal(body.inert, true); assert.match(toggle.textContent, /参数生成中/)
    toggle.click(); toggle.focus(); body.scrollTop = 71
    mounted.update(toolSnapshot(protocolId, [toolRequest(protocolId)], 2), compactOptions([toolFact('call', { state: 'running', exitCode: undefined, stdout: undefined })]))
    const commandCopy = body.querySelectorAll('.tool-copy').find(button => button.dataset.copyField === 'command'); assert.ok(commandCopy, protocolId); commandCopy.focus()
    mounted.update({ ...toolSnapshot(protocolId, [toolRequest(protocolId)], 3), status: 'committed' }, compactOptions([toolFact('call', { stdout: 'FIRST\n<script>literal</script>', truncated: true })]))
    assert.equal(request.querySelector('.native-tool-summary'), toggle); assert.equal(request.querySelector('.native-tool-details'), body)
    assert.equal(toggle.getAttribute('aria-expanded'), 'true'); assert.equal(body.hidden, false); assert.equal(body.inert, false)
    assert.equal(body.scrollTop, 71); assert.equal(body.querySelectorAll('.tool-copy').find(button => button.dataset.copyField === 'command'), commandCopy); assert.equal(document.activeElement, commandCopy)
    assert.match(body.textContent, /FIRST/); assert.match(body.textContent, /输出摘要已截断/)
    assert.equal(body.querySelectorAll('script').length, 0, 'operational output stays literal')
    const raw = body.querySelector('.native-tool-raw'); assert.ok(raw); assert.equal(raw.open, false)
    assert.equal(raw.querySelector('.native-tool-arguments').textContent, '{"command":"pwd"}')
    toggle.click(); assert.equal(document.activeElement, toggle, 'folding a focused detail returns focus to its summary')
    assert.equal(body.hidden, true); assert.equal(body.inert, true)
    const fresh = module.mount({ ...initial, status: 'committed' }, compactOptions())
    assert.equal(fresh.element.querySelector('.native-tool-details').hidden, true, 'a new panel resets the default fold')
    fresh.dispose(); mounted.dispose(); toggle.click(); assert.equal(body.hidden, true, 'disposed toggles are inactive')
  }
})

test('local grouping grows from one to three tools without replacing controls or overriding user folds', t => {
  const document = withDocument(t), protocolId = 'responses', module = getProtocolWebModule(protocolId)
  const request = n => toolRequest(protocolId, `request-${n}`, `call-${n}`)
  const mounted = module.mount(toolSnapshot(protocolId, [request(1)]), compactOptions([toolFact('call-1')]))
  document.body.append(mounted.element)
  const first = mounted.element.querySelector('.native-function-request').querySelector('.native-tool-summary'); first.click(); first.focus()
  mounted.update(toolSnapshot(protocolId, [request(1), request(2)], 2), compactOptions([toolFact('call-1'), toolFact('call-2', { state: 'failed', exitCode: 2 })]))
  const group = mounted.element.querySelector('.native-tool-group-toggle'), body = mounted.element.querySelector('.native-tool-group-body')
  assert.equal(group.getAttribute('aria-expanded'), 'true'); assert.equal(body.hidden, false); assert.equal(document.activeElement, first)
  assert.equal(body.querySelector('.native-tool-summary'), first); assert.match(group.textContent, /2 个工具|2 个调用/)
  group.click(); group.focus(); assert.equal(body.hidden, true); assert.equal(body.inert, true)
  mounted.update(toolSnapshot(protocolId, [request(1), request(2), request(3)], 3), compactOptions([toolFact('call-1'), toolFact('call-2', { state: 'failed', exitCode: 2 }), toolFact('call-3', { state: 'running' })]))
  assert.equal(mounted.element.querySelector('.native-tool-group-toggle'), group); assert.equal(body.hidden, true)
  assert.equal(document.activeElement, group); assert.match(group.textContent, /3 个工具|3 个调用/)
  assert.match(group.textContent, /执行中/); assert.match(group.textContent, /需关注/)
  const reason = mounted.element.querySelector('.native-tool-group-reason')
  assert.ok(reason); assert.equal(reason.hidden, false); assert.match(reason.textContent, /退出码：2/)
  mounted.dispose(); group.click(); assert.equal(body.hidden, true)
})

test('tool groups remain within adjacent local blocks and each exchange while reused request IDs keep distinct facts', t => {
  withDocument(t)
  const protocolId = 'responses', requests = [toolRequest(protocolId, 'a'), toolRequest(protocolId, 'b'),
    { id: 'text', type: 'responses.message', content: [{ id: 'part', type: 'output_text', text: 'Between calls' }] }, toolRequest(protocolId, 'c'),
    { id: 'search', type: 'responses.web_search_call', status: 'completed', query: 'query', sources: [] }, toolRequest(protocolId, 'd'), toolRequest(protocolId, 'f'),
    { id: 'limit', type: 'harness.display_limit', text: '投影截断' }, toolRequest(protocolId, 'g')]
  const mounted = getProtocolWebModule(protocolId).mount(toolSnapshot(protocolId, [], 1, [{ id: 'e', blocks: requests },
    { id: 'other', blocks: [toolRequest(protocolId, 'a'), toolRequest(protocolId, 'b')] }]), compactOptions([
    ...[0, 1, 2, 3, 4, 5].map(occurrence => toolFact('call', { stdout: `E-${occurrence}` }, 'e', occurrence)),
    toolFact('call', { stdout: 'OTHER-0' }, 'other', 0), toolFact('call', { stdout: 'OTHER-1' }, 'other', 1),
  ]))
  assert.equal(mounted.element.querySelectorAll('.native-tool-group-toggle').filter(toggle => !toggle.hidden).length, 3)
  assert.deepEqual(mounted.element.querySelectorAll('.native-tool-group-body').filter(body => body.querySelectorAll('.native-tool-summary').length > 1)
    .map(body => body.querySelectorAll('.native-tool-summary').length), [2, 2, 2])
  assert.deepEqual(mounted.element.querySelectorAll('.tool-output').map(output => output.textContent).filter(text => /^(E-|OTHER-)/.test(text)),
    ['E-0', 'E-1', 'E-2', 'E-3', 'E-4', 'E-5', 'OTHER-0', 'OTHER-1'])
  mounted.dispose()
})

test('a closed growing group stays closed and unresolved facts never become execution success', t => {
  withDocument(t)
  const protocolId = 'chat-completions', module = getProtocolWebModule(protocolId), requests = [toolRequest(protocolId, 'a'), toolRequest(protocolId, 'b', 'second')]
  const mounted = module.mount(toolSnapshot(protocolId, requests.slice(0, 1)), compactOptions([], 'loading'))
  mounted.update(toolSnapshot(protocolId, requests, 2), compactOptions([], 'loading'))
  const group = mounted.element.querySelector('.native-tool-group-toggle'), body = mounted.element.querySelector('.native-tool-group-body')
  assert.equal(body.hidden, true); assert.match(group.textContent, /待同步/); assert.doesNotMatch(group.textContent, /已完成|需关注/)
  mounted.update(toolSnapshot(protocolId, requests, 3), compactOptions([], 'failed'))
  assert.equal(body.hidden, true); assert.match(group.textContent, /需关注/); assert.match(mounted.element.querySelector('.native-tool-group-reason').textContent, /执行记录读取失败/)
  mounted.dispose()
})

test('compact tool copy preserves raw text, reports failure and stops after disposal', async t => {
  withDocument(t)
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), copied = []
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async value => { copied.push(value) } } } })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'navigator', previous); else delete globalThis.navigator })
  const protocolId = 'responses', payload = '<script>literal()</script>\nraw output'
  const mounted = getProtocolWebModule(protocolId).mount(toolSnapshot(protocolId, [toolRequest(protocolId)]), compactOptions([toolFact('call', { stdout: payload, truncated: true })]))
  mounted.element.querySelector('.native-function-request').querySelector('.native-tool-summary').click()
  assert.equal(mounted.element.querySelector('.native-tool-details').hidden, false)
  const stdoutCopy = mounted.element.querySelectorAll('.tool-copy').find(button => button.dataset.copyField === 'stdout')
  assert.ok(stdoutCopy); stdoutCopy.click(); await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(copied, [payload]); assert.match(mounted.element.textContent, /输出摘要已截断/)
  globalThis.navigator.clipboard.writeText = async () => { throw new Error('denied') }
  stdoutCopy.click(); await Promise.resolve(); await Promise.resolve(); assert.match(stdoutCopy.textContent, /失败/)
  mounted.dispose(); stdoutCopy.click(); await Promise.resolve(); assert.deepEqual(copied, [payload])
})

test('native search tools fold independently and keep their protocol query, sources and error states', t => {
  const document = withDocument(t)
  const sources = [{ url: 'https://example.test/search', title: 'Search source' }]
  const blocksByProtocol = {
    responses: [{ id: 'search', type: 'responses.web_search_call', query: '<literal query>', action: 'search', status: 'searching', sources: [] }],
    'anthropic-messages': [{ id: 'request', type: 'anthropic.server_tool_use', name: 'web_search', requestId: 'search', arguments: '{"query":"<literal query>"}' },
      { id: 'result', type: 'anthropic.web_search_tool_result', requestId: 'search', status: 'failed', errorCode: 'max_uses_exceeded', sources: [] }],
  }
  for (const [protocolId, blocks] of Object.entries(blocksByProtocol)) {
    const module = getProtocolWebModule(protocolId), mounted = module.mount(toolSnapshot(protocolId, blocks), compactOptions())
    document.body.append(mounted.element)
    assert.equal(mounted.element.querySelectorAll('.native-tool-group-toggle').length, 0, 'server requests/results are not local tools')
    const requests = mounted.element.querySelectorAll('.native-server-tool'), first = requests[0]
    const toggle = first.querySelector('.native-tool-summary'), body = first.querySelector('.native-tool-details')
    assert.equal(body.hidden, true); assert.equal(body.inert, true); assert.match(toggle.textContent, /<literal query>/)
    if (protocolId === 'anthropic-messages') {
      assert.equal(requests.length, 2, 'server request and result remain distinct ordered blocks')
      assert.match(requests[1].querySelector('.native-tool-summary').textContent, /0 个来源.*失败/)
      assert.match(requests[1].querySelector('.native-tool-reason').textContent, /max_uses_exceeded/)
    }
    toggle.click(); toggle.focus()
    const nextBlocks = protocolId === 'responses' ? [{ ...blocks[0], status: 'completed', sources }] : [blocks[0], { ...blocks[1], status: 'completed', errorCode: undefined, sources }]
    mounted.update(toolSnapshot(protocolId, nextBlocks, 2), compactOptions())
    assert.equal(first.querySelector('.native-tool-summary'), toggle); assert.equal(first.querySelector('.native-tool-details'), body)
    assert.equal(body.hidden, false); assert.equal(document.activeElement, toggle)
    const result = mounted.element.querySelectorAll('.native-server-tool').at(-1)
    assert.match(result.querySelector('.native-tool-summary').textContent, /1 个来源/)
    assert.equal(result.querySelector('.native-tool-duration').hidden, true, 'server-tool timing is not invented')
    assert.equal(mounted.element.querySelector('a').textContent, 'Search source')
    assert.equal(mounted.element.querySelectorAll('script').length, 0)
    mounted.dispose(); toggle.click(); assert.equal(body.hidden, false)
  }
})

test('four protocols keep unfactored active requests neutral and transfer focus before hiding request or result controls', t => {
  const document = withDocument(t)
  for (const protocolId of Object.keys(requestTypes)) {
    const module = getProtocolWebModule(protocolId), requests = [toolRequest(protocolId)]
    const mounted = module.mount(toolSnapshot(protocolId, requests), compactOptions([], 'ready')); document.body.append(mounted.element)
    const request = mounted.element.querySelector('.native-function-request'), toggle = request.querySelector('.native-tool-summary')
    const body = request.querySelector('.native-tool-details')
    assert.match(toggle.textContent, /执行事实待同步/); assert.doesNotMatch(toggle.textContent, /执行结果未记录/)
    assert.equal(toggle.dataset.tone, 'neutral'); assert.equal(request.querySelector('.native-tool-reason').hidden, true)
    toggle.click()
    const pendingCopy = body.querySelectorAll('.tool-copy').find(button => button.dataset.copyField === 'request')
    assert.ok(pendingCopy); pendingCopy.focus(); body.scrollTop = 37
    mounted.update(toolSnapshot(protocolId, requests, 2), compactOptions([toolFact('call', { state: 'running', exitCode: undefined, stdout: undefined })]))
    assert.equal(pendingCopy.parentElement.parentElement.hidden, true)
    assert.equal(pendingCopy.parentElement.parentElement.inert, true)
    assert.equal(document.activeElement, body, 'incoming facts cannot strand focus inside the hidden request field')
    assert.equal(body.hidden, false); assert.equal(body.scrollTop, 37)
    const factCopy = body.querySelectorAll('.tool-copy').find(button => button.dataset.copyField === 'command')
    assert.ok(factCopy); factCopy.focus()
    mounted.update(toolSnapshot(protocolId, requests, 3), compactOptions([], 'failed'))
    assert.equal(body.querySelector('.native-tool-observation').hidden, true)
    assert.equal(body.querySelector('.native-tool-observation').inert, true)
    assert.equal(document.activeElement, body, 'an unsuccessful fact read cannot strand focus in the hidden result')
    assert.equal(body.scrollTop, 37); assert.match(toggle.textContent, /执行记录读取失败/)
    mounted.dispose()
  }
})

test('Apply Patch request copies choose patch by tool name when arguments also contain a command', async t => {
  withDocument(t)
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), copied = []
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async value => { copied.push(value) } } } })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'navigator', previous); else delete globalThis.navigator })
  const patchText = '*** Begin Patch\n*** Add File: example.txt\n+literal <text>\n*** End Patch'
  for (const protocolId of Object.keys(requestTypes)) {
    const arguments_ = JSON.stringify({ command: 'never copy this unrelated field', patch: patchText })
    const mounted = getProtocolWebModule(protocolId).mount(toolSnapshot(protocolId, [toolRequest(protocolId, 'request', 'patch', arguments_, 'apply_patch')]), compactOptions([], 'loading'))
    const request = mounted.element.querySelector('.native-function-request'); request.querySelector('.native-tool-summary').click()
    assert.equal(request.querySelector('.native-tool-details').hidden, false)
    assert.equal(request.querySelector('.native-request-input').textContent, patchText)
    const copy = request.querySelectorAll('.tool-copy').find(button => button.dataset.copyField === 'request')
    copy.click(); await Promise.resolve(); await Promise.resolve()
    mounted.dispose()
  }
  assert.deepEqual(copied, Object.keys(requestTypes).map(() => patchText))
})

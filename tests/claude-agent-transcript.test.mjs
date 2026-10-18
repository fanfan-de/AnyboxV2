import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderMarkdown, safeMarkdownUrl } from '../packages/app-claude-agent/dist/web/markdown.js'
import { renderItem, syncTranscript } from '../packages/app-claude-agent/dist/web/view.js'
import { installClaudeAgentDOM } from './helpers/claude-agent-dom.mjs'

const installDOM = t => {
  const dom = installClaudeAgentDOM(t)
  // Text nodes are represented as literal strings by this intentionally small test DOM.
  dom.document.createTextNode = value => String(value)
  return dom
}
const text = value => ({ kind: 'text', text: value, truncated: false })
const thinking = value => ({ kind: 'thinking', text: value, truncated: false })
const use = (id = 'tool-1', command = 'npm run check') => ({ kind: 'tool_use', toolUseId: id, name: 'Bash', input: { command }, inputTruncated: false })
const result = (id = 'tool-1', value = 'All checks passed', isError = false) => ({ kind: 'tool_result', toolUseId: id, text: value, isError, truncated: false })
const item = (id, blocks, streaming = false, role = 'assistant') => ({ id, blocks, streaming, role })

test('Claude assistant Markdown renders structure, code copy and tables while user text stays literal', async t => {
  const dom = installDOM(t), copied = []
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async value => { copied.push(value) } } } })
  t.after(() => { if (original) Object.defineProperty(globalThis, 'navigator', original); else delete globalThis.navigator })
  const source = '# A useful answer\n\nUse **bold** and `inline`.\n\n- first\n- second\n\n| Name | Result |\n| --- | ---: |\n| Check | Passed |\n\n```bash\nnpm run check\n```'
  dom.container.append(renderItem(item('assistant', [text(source)])), renderItem(item('user', [text('**literal** <b>text</b>')], false, 'user')))
  assert.equal(dom.find('h1').textContent, 'A useful answer'); assert.equal(dom.find('strong').textContent, 'bold')
  assert.equal(dom.all('ul li').length, 2); assert.equal(dom.all('th').length, 2); assert.equal(dom.find('td[data-align="right"]').textContent, 'Passed')
  assert.equal(dom.find('pre code').textContent, 'npm run check')
  dom.find('.ca-code-copy').click(); await dom.flush()
  assert.deepEqual(copied, ['npm run check']); assert.equal(dom.find('.ca-code-copy').textContent, '已复制')
  assert.equal(dom.find('.ca-user').textContent, '你**literal** <b>text</b>'); assert.equal(dom.find('.ca-user strong'), null)
})

test('Markdown keeps raw HTML inert, allows only explicit http(s) links and never loads model images', t => {
  const dom = installDOM(t)
  dom.container.append(renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert%281%29) [file](file:///etc/passwd) [app](/settings) [data](data:text/html,hello) [good](https://example.com/a?q=1)\n\n![diagram](https://images.example/diagram.png)\n\n[reference][ref]\n\n[ref]: https://example.com/reference'))
  assert.equal(dom.find('script'), null); assert.equal(dom.find('img'), null)
  assert.match(dom.container.textContent, /<script>alert\(1\)<\/script>/); assert.match(dom.container.textContent, /<img src=x onerror=alert\(1\)>/)
  const links = dom.all('a')
  assert.deepEqual(links.map(link => link.getAttribute('href')), ['https://example.com/a?q=1', 'https://images.example/diagram.png', 'https://example.com/reference'])
  for (const link of links) { assert.equal(link.getAttribute('target'), '_blank'); assert.equal(link.getAttribute('rel'), 'noopener noreferrer') }
  assert.equal(dom.find('.ca-image-link').textContent, '[图片：diagram]')
  for (const value of ['javascript:alert(1)', 'https://secret:password@example.com', 'https://user@example.com', '//example.com', 'https://example.com/\nunsafe', 'https://', 'file:///tmp/readme', 'https:\\evil.example']) assert.equal(safeMarkdownUrl(value), undefined)
  assert.equal(safeMarkdownUrl('HTTP://EXAMPLE.COM'), 'http://example.com/')
})

test('Markdown has bounded source size and nesting with a plain-text fallback', t => {
  const dom = installDOM(t)
  const large = renderMarkdown('a'.repeat(1_048_577)), deep = '> '.repeat(70) + '**deep**'
  dom.container.append(large, renderMarkdown(deep))
  assert.match(large.className, /ca-markdown-plain/); assert.equal(large.textContent.length, 1_048_576 + '\n…（显示内容已截断）'.length)
  assert.equal(dom.all('blockquote').length, 0); assert.equal(dom.find('strong'), null); assert.match(dom.container.textContent, /\*\*deep\*\*/)
})

test('tool disclosures show command, name and outcome while keeping IDs and full payload inside details', t => {
  const dom = installDOM(t)
  syncTranscript(dom.container, [item('call', [use()]), item('result', [result()]), item('error', [result('tool-2', 'Permission denied', true)])])
  const tool = dom.find('details.ca-tool'), output = dom.find('details.ca-tool-result'), error = dom.find('details.ca-error')
  assert.equal(tool.open, false); assert.equal(output.open, false); assert.equal(error.open, true)
  assert.equal(tool.querySelector('.ca-tool-name').textContent, 'Bash'); assert.equal(tool.querySelector('.ca-tool-preview').textContent, 'npm run check')
  assert.equal(output.querySelector('.ca-tool-name').textContent, 'Bash'); assert.equal(output.querySelector('.ca-tool-status').textContent, '已返回')
  assert.equal(error.querySelector('.ca-tool-status').textContent, '出错')
  assert.doesNotMatch(tool.querySelector('summary').textContent, /tool-1/); assert.equal(tool.querySelector('.ca-tool-id').textContent, '调用 ID：tool-1')
  assert.match(tool.querySelector('pre').textContent, /"command": "npm run check"/); assert.equal(output.querySelector('pre').textContent, 'All checks passed')
  assert.equal(dom.all('.ca-item-tools .ca-role').length, 0)
})

test('stream replacement and history reconciliation preserve individual disclosures and refresh same-ID contents', t => {
  const dom = installDOM(t)
  const first = item('live:message', [thinking('Let me check'), use(), result()], true)
  syncTranscript(dom.container, [first])
  dom.find('.ca-thinking').open = true; dom.find('.ca-tool').open = true
  syncTranscript(dom.container, [item('live:message', [thinking('Let me check carefully'), use('tool-1', 'npm test'), result('tool-1', 'More output')], true)])
  assert.equal(dom.find('.ca-thinking').open, true); assert.equal(dom.find('.ca-tool').open, true); assert.equal(dom.find('.ca-tool-result').open, false)
  assert.match(dom.find('.ca-thinking').textContent, /carefully/); assert.equal(dom.find('.ca-tool-preview').textContent, 'npm test')
  syncTranscript(dom.container, [item('message', [thinking('Done'), use('tool-1', 'npm test'), result('tool-1', 'Final output')])])
  assert.equal(dom.find('.ca-thinking').open, true); assert.equal(dom.find('.ca-tool').open, true)
  assert.equal(dom.find('.ca-tool-result pre').textContent, 'Final output')
  const stable = dom.find('[data-item-id="message"]')
  syncTranscript(dom.container, [item('message', [thinking('Done'), use('tool-1', 'npm test'), result('tool-1', 'Final output')])])
  assert.equal(dom.find('[data-item-id="message"]'), stable, 'unchanged frames retain their DOM nodes')
  syncTranscript(dom.container, [item('message', [thinking('Updated history'), use('tool-1', 'npm test'), result('tool-1', 'Corrected output')])])
  assert.equal(dom.find('.ca-tool-result pre').textContent, 'Corrected output', 'a completed item can be corrected without changing its ID')
  assert.equal(dom.find('.ca-thinking').open, true); assert.equal(dom.find('.ca-tool').open, true)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { applyPatchText, parsePatch, validatePatchText } from '../dist/tool/apply-patch-domain.js'
import { patchDiagnostic } from '../dist/tool/apply-patch-types.js'

const patch = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n')
const chunks = (...lines) => parsePatch(patch('*** Update File: example.txt', ...lines))[0].chunks
const apply = (input, ...lines) => applyPatchText(Buffer.from(input), chunks(...lines)).toString('utf8')
const rejects = (action, code) => assert.throws(action, error => {
  const diagnostic = patchDiagnostic(error)
  assert.ok(diagnostic, 'expected a project-owned patch rejection')
  assert.equal(diagnostic.code, code)
  assert.ok(diagnostic.message)
  assert.ok(diagnostic.path !== undefined || Number.isInteger(diagnostic.line))
  return true
})

test('parses Add, empty Add, Delete, Update, Move and multiple anchored hunks', () => {
  const operations = parsePatch(patch(
    '*** Add File: 新文件.txt', '+第一行', '+🙂',
    '*** Add File: empty.txt',
    '*** Delete File: stale.txt',
    '*** Update File: before.txt', '*** Move to: after.txt',
    '@@ section one', ' unchanged', '-old', '+new',
    '@@ section two', '-last', '+replacement', '*** End of File',
  ))
  assert.deepEqual(operations, [
    { kind: 'add', path: '新文件.txt', content: '第一行\n🙂\n' },
    { kind: 'add', path: 'empty.txt', content: '' },
    { kind: 'delete', path: 'stale.txt' },
    { kind: 'update', path: 'before.txt', moveTo: 'after.txt', chunks: [
      { anchor: 'section one', oldLines: ['unchanged', 'old'], newLines: ['unchanged', 'new'], eof: false },
      { anchor: 'section two', oldLines: ['last'], newLines: ['replacement'], eof: true },
    ] },
  ])
  assert.ok(Object.isFrozen(operations))
  assert.ok(Object.isFrozen(operations[3].chunks[0].oldLines))
})

test('parses a pure rename and an update whose first hunk omits @@', () => {
  assert.deepEqual(parsePatch(patch('*** Update File: a', '*** Move to: b')),
    [{ kind: 'update', path: 'a', moveTo: 'b', chunks: [] }])
  assert.equal(apply('old\n', '-old', '+new'), 'new\n')
  const original = Buffer.from('\uFEFFline\r\n')
  assert.deepEqual(applyPatchText(original, []), original)
})

test('Add blank lines generate LF and patch syntax accepts CRLF plus one final newline', () => {
  const value = `${patch('*** Add File: blank', '+', '+two')}\n`.replaceAll('\n', '\r\n')
  assert.equal(parsePatch(value)[0].content, '\ntwo\n')
})

test('rejects empty patches, non-patch envelopes and alternate command or diff languages', () => {
  for (const value of [
    '', patch(), `${patch('*** Add File: a')}\necho done`,
    `apply_patch <<'PATCH'\n${patch('*** Add File: a')}\nPATCH`,
    '--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new',
    patch('*** Update File: a', '@@ -1,2 +1,2 @@', '-old', '+new'),
    patch('*** Set Working Directory: /tmp', '*** Add File: a'),
    patch('*** Add File: '), patch('*** Add File: a', 'unprefixed'),
    patch('*** Delete File: a', '+unexpected'),
    patch('*** Update File: a'), patch('*** Update File: a', '@@'),
    patch('*** Update File: a', '@@ ', '+new'),
    patch('*** Update File: a', '*** Move to: '),
    patch('*** Update File: a', '@@', '-a', '+b', '*** Move to: b'),
    patch('*** Update File: a', '@@', '-a', '+b', '*** End of File', '@@', '+later'),
    patch('*** Add File: a', '+NUL\0'), patch('*** Add File: a', '+bad\ud800'),
    patch('*** Add File: a', '+bare\rCR'),
  ]) rejects(() => parsePatch(value), 'invalid-patch')
})

test('syntax diagnostics identify the source path and one-based patch line', () => {
  assert.throws(() => parsePatch(patch('*** Add File: example.txt', 'missing prefix')), error => {
    assert.deepEqual(patchDiagnostic(error), {
      code: 'invalid-patch', message: 'Added file lines must start with +.', path: 'example.txt', line: 3,
    })
    return true
  })
})

test('validates UTF-8, NUL and line ending conventions before any text transformation', () => {
  for (const [bytes, code] of [
    [Buffer.from([0xc3, 0x28]), 'invalid-utf8'],
    [Buffer.from([0xe2, 0x82]), 'invalid-utf8'],
    [Buffer.from([0xc0, 0x80]), 'invalid-utf8'],
    [Buffer.from([0xff, 0xfe, 0x61, 0]), 'invalid-utf8'],
    [Buffer.from('hello\0world'), 'binary-file'],
    [Buffer.from('a\r\nb\n'), 'mixed-line-endings'],
    [Buffer.from('a\nb\r\n'), 'mixed-line-endings'],
    [Buffer.from('a\rb'), 'unsupported-line-ending'],
  ]) {
    rejects(() => validatePatchText(bytes), code)
    rejects(() => applyPatchText(bytes, []), code)
  }
  for (const text of ['', '\n', '无换行🙂', '\uFEFF', '\uFEFFa\r\nb\r\n']) {
    assert.doesNotThrow(() => validatePatchText(Buffer.from(text)))
  }
})

test('preserves Unicode, BOM, EOL and the original final newline choice', () => {
  for (const [original, expected] of [
    ['前🙂\n旧\n尾\n', '前🙂\n新é\n另一行\n尾\n'],
    ['前🙂\n旧\n尾', '前🙂\n新é\n另一行\n尾'],
    ['前🙂\r\n旧\r\n尾\r\n', '前🙂\r\n新é\r\n另一行\r\n尾\r\n'],
    ['前🙂\r\n旧\r\n尾', '前🙂\r\n新é\r\n另一行\r\n尾'],
    ['\uFEFF前🙂\r\n旧\r\n尾', '\uFEFF前🙂\r\n新é\r\n另一行\r\n尾'],
    ['\uFEFF旧', '\uFEFF新é\n另一行'],
  ]) assert.equal(apply(original, '@@', '-旧', '+新é', '+另一行'), expected)
})

test('empty files receive normal LF lines, including BOM-only files and empty inserted lines', () => {
  assert.equal(apply('', '@@', '+first', '+second'), 'first\nsecond\n')
  assert.equal(apply('\uFEFF', '@@', '+first'), '\uFEFFfirst\n')
  assert.equal(apply('', '@@', '+'), '\n')
  assert.equal(apply('', '@@', '+first', '*** End of File'), 'first\n')
  assert.equal(apply('old\n', '@@', '-old'), '')
  assert.equal(apply('\uFEFFold\r\n', '@@', '-old'), '\uFEFF')
  assert.equal(apply('old', '@@', '-old', '+'), '')
  assert.equal(apply('old\n', '@@', '-old', '+'), '\n')
})

test('a blank first or last line is real context, not an empty file', () => {
  assert.equal(apply('\nold\n\n', '@@', ' ', '-old', '+new', ' '), '\nnew\n\n')
  assert.equal(apply('\n', '@@', '-', '+not blank'), 'not blank\n')
  rejects(() => apply('\n', '@@', '+unlocated'), 'ambiguous-insertion')
})

test('context requires exact whitespace and Unicode normalization with no fuzzy fallback', () => {
  rejects(() => apply('value \n', '@@', '-value', '+new'), 'context-not-found')
  rejects(() => apply('\tvalue\n', '@@', '- value', '+new'), 'context-not-found')
  rejects(() => apply('cafe\u0301\n', '@@', '-café', '+new'), 'context-not-found')
  assert.equal(apply('value \n', '@@', '-value ', '+new'), 'new\n')
})

test('ambiguous context is rejected and an EOF marker selects only the final occurrence', () => {
  rejects(() => apply('same\nmiddle\nsame\n', '@@', '-same', '+new'), 'ambiguous-context')
  assert.equal(apply('same\nmiddle\nsame\n', '@@', '-same', '+new', '*** End of File'), 'same\nmiddle\nnew\n')
  rejects(() => apply('same\ntail\n', '@@', '-same', '+new', '*** End of File'), 'context-not-found')
  rejects(() => apply('a\na\na\n', '@@', '-a', '-a', '+b'), 'ambiguous-context')
})

test('anchors are unique exact lines and locate context strictly after the anchor', () => {
  assert.equal(apply('same\nsection\nsame\n', '@@ section', '-same', '+new'), 'same\nsection\nnew\n')
  rejects(() => apply('section\na\nsection\nb\n', '@@ section', '-b', '+new'), 'ambiguous-anchor')
  rejects(() => apply('section \na\n', '@@ section', '-a', '+new'), 'anchor-not-found')
  rejects(() => apply('section\nsame\nsame\n', '@@ section', '-same', '+new'), 'ambiguous-context')
  rejects(() => apply('section\nbody\n', '@@ section', '-section', '+new'), 'context-not-found')
})

test('multiple hunks match original lines in order and never overlap or match prior output', () => {
  assert.equal(apply('a\nb\nc\nd\n', '@@', '-a', '+A', '@@', '-c', '+C'), 'A\nb\nC\nd\n')
  assert.equal(apply('same\nseparator\nsame\n', '@@', '-same', ' separator', '+middle', '@@', '-same', '+last'),
    'separator\nmiddle\nlast\n')
  rejects(() => apply('a\nb\nc\n', '@@', '-a', ' b', '+A', '@@', '-b', '+B'), 'context-not-found')
  rejects(() => apply('a\nb\n', '@@', '-b', '+B', '@@', '-a', '+A'), 'context-not-found')
  rejects(() => apply('a\nb\n', '@@', '-a', '+A', '@@', '-A', '+again'), 'context-not-found')
})

test('anchor searches continue after the preceding hunk and cannot move backward', () => {
  assert.equal(apply('first\na\nsecond\nb\n', '@@ first', '-a', '+A', '@@ second', '-b', '+B'), 'first\nA\nsecond\nB\n')
  rejects(() => apply('first\na\nsecond\nb\n', '@@ second', '-b', '+B', '@@ first', '+late'), 'anchor-not-found')
  assert.equal(apply('section\na\nsection\nb\n', '@@', ' section', '-a', '+A', '@@ section', '-b', '+B'),
    'section\nA\nsection\nB\n')
})

test('pure insertions need empty input, a unique anchor or an explicit EOF marker', () => {
  rejects(() => apply('a\nb\n', '@@', '+new'), 'ambiguous-insertion')
  assert.equal(apply('a\nb\n', '@@ a', '+new'), 'a\nnew\nb\n')
  assert.equal(apply('a\nb\n', '@@', '+new', '*** End of File'), 'a\nb\nnew\n')
  assert.equal(apply('a\nb', '@@', '+new', '*** End of File'), 'a\nb\nnew')
  assert.equal(apply('a\r\nb\r\n', '@@ b', '+new', '*** End of File'), 'a\r\nb\r\nnew\r\n')
  rejects(() => apply('a\nb\n', '@@ a', '+new', '*** End of File'), 'eof-mismatch')
})

test('markers and header-like text remain ordinary file content when prefixed', () => {
  assert.equal(apply('*** End Patch\n@@ anchor\n', '@@', '-*** End Patch', '+*** Begin Patch', ' @@ anchor'),
    '*** Begin Patch\n@@ anchor\n')
})

test('large line counts and repetitive failed context do not require spreading or quadratic matching', () => {
  const original = Buffer.from(`${'a\n'.repeat(100_000)}tail\n`)
  const noMatch = { oldLines: [...Array(50_000).fill('a'), 'missing'], newLines: ['new'], eof: false }
  rejects(() => applyPatchText(original, [noMatch]), 'context-not-found')
  const result = applyPatchText(original, [{ oldLines: ['tail'], newLines: ['end'], eof: true }])
  assert.equal(result.toString('utf8'), `${'a\n'.repeat(100_000)}end\n`)
  assert.equal(original.toString('utf8'), `${'a\n'.repeat(100_000)}tail\n`)
})

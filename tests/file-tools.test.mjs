import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@nya/core'
import sharp from 'sharp'
import { projectServiceKey } from '../dist/applications/harness/core/project/component.js'
import { createApplyPatchComponent } from '../dist/applications/harness/core/tool/apply-patch-component.js'
import { createFileToolsComponent, fileToolsServiceKey, searchBinaryPath } from '../dist/applications/harness/core/tool/files-component.js'
import { imageAssetsServiceKey } from '../dist/applications/harness/core/image/port.js'

function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }

test('packaged search uses the physical unpacked executable while ordinary paths stay unchanged', () => {
  assert.equal(searchBinaryPath('/Applications/Anybox.app/Contents/Resources/app.asar/node_modules/@vscode/rg'),
    '/Applications/Anybox.app/Contents/Resources/app.asar.unpacked/node_modules/@vscode/rg')
  assert.equal(searchBinaryPath('C:\\Anybox\\app.asar\\node_modules\\rg.exe'), 'C:\\Anybox\\app.asar.unpacked\\node_modules\\rg.exe')
  for (const path of ['/project/node_modules/rg', '/path/app.asar.unpacked/rg', '/path/app.asar-backup/rg']) assert.equal(searchBinaryPath(path), path)
})
async function fixture(options = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'anybox-file-tools-')))
  const root = new Context(), imported = []
  await root.installComponent({ name: 'file-tool-test-dependencies', apply(ctx) {
    ctx.provide(projectServiceKey, { async requireAvailable(id) {
      if (options.lookup) await options.lookup()
      return { id, path: directory, available: true }
    } })
    ctx.provide(imageAssetsServiceKey, { importImage(input, signal) {
      if (options.importImage) return options.importImage(input, signal)
      const operation = (async () => {
        const chunks = []; for await (const chunk of input.bytes) { signal?.throwIfAborted(); chunks.push(Buffer.from(chunk)) }
        imported.push({ scopeId: input.scopeId, bytes: Buffer.concat(chunks) })
        return { assetId: 'image-1', sha256: 'a'.repeat(64), mediaType: 'image/png', byteLength: imported.at(-1).bytes.length, width: 2, height: 2 }
      })()
      return { result: operation, done: operation.then(() => {}), cancel() {} }
    } })
  } })
  await root.installComponent(createApplyPatchComponent(options.patchOptions))
  await root.installComponent(createFileToolsComponent())
  const files = root.get(fileToolsServiceKey)
  const call = (name, args, imageInput = false, signal) => files.execute({ runId: 'run-1', sessionId: 'session-1', projectId: 'project-1', name, args, imageInput, signal })
  return { root, directory, imported, call,
    async execute(name, args, imageInput = false) { const operation = call(name, args, imageInput); const result = await operation.result; await operation.done; return result },
    async close() { try { await root.fiber.dispose() } finally { await fs.rm(directory, { recursive: true, force: true }) } },
  }
}

test('file reads paginate from 1, preserve line numbers and reject unsafe text targets', async () => {
  const f = await fixture()
  try {
    await fs.writeFile(join(f.directory, 'file'), 'one\r\ntwo\r\nthree')
    const page = await f.execute('deepseek_harness_read', { file_path: 'file', offset: 2, limit: 1 })
    assert.equal(page.result.text, '2: two'); assert.equal(page.result.nextOffset, 3)
    await fs.symlink('file', join(f.directory, 'link'))
    assert.equal((await f.execute('claude_code_Read', { file_path: 'link' })).result.code, 'symbolic-link')
    await fs.link(join(f.directory, 'file'), join(f.directory, 'hard'))
    assert.equal((await f.execute('deepseek_harness_read', { file_path: 'file' })).result.code, 'hard-link')
    await fs.writeFile(join(f.directory, 'binary'), Buffer.from([0, 255]))
    assert.equal((await f.execute('deepseek_harness_read', { file_path: 'binary' })).result.status, 'error')
    assert.equal((await f.execute('claude_code_Read', { file_path: 'document.pdf' })).result.code, 'unsupported-format')
    assert.equal((await f.execute('deepseek_harness_read', { file_path: 'notebook.ipynb' })).result.code, 'unsupported-format')
  } finally { await f.close() }
})

test('read honors catalog line limits and offsets beyond one million', async () => {
  const f = await fixture()
  try {
    await fs.writeFile(join(f.directory, 'many-lines'), 'x\n'.repeat(3000))
    const page = await f.execute('claude_code_Read', { file_path: 'many-lines', limit: 3000 })
    assert.equal(page.result.text.split('\n').length, 3000)
    assert.equal(page.result.nextOffset, null)
    const beyond = await f.execute('deepseek_harness_read', { file_path: 'many-lines', offset: 1_000_001 })
    assert.equal(beyond.result.text, '')
    assert.equal(beyond.result.nextOffset, null)
  } finally { await f.close() }
})

test('writes and literal edits reuse guarded patch commits with exact Unicode and newline behavior', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.execute('claude_code_Write', { file_path: 'nested/text', content: 'old $& old' })).result.status, 'applied')
    const conflict = await f.execute('deepseek_harness_edit', { file_path: 'nested/text', old_string: 'old', new_string: '新' })
    assert.equal(conflict.result.diagnostic.code, 'ambiguous-context')
    assert.equal((await f.execute('claude_code_Edit', { file_path: 'nested/text', old_string: 'old', new_string: '$&', replace_all: true })).result.status, 'applied')
    assert.equal(await fs.readFile(join(f.directory, 'nested/text'), 'utf8'), '$& $& $&')
    assert.equal((await f.execute('deepseek_harness_write', { file_path: 'nested/text', content: '' })).result.status, 'applied')
    assert.equal(await fs.readFile(join(f.directory, 'nested/text'), 'utf8'), '')
    assert.equal((await f.execute('claude_code_Write', { file_path: 'bad', content: 'one\nsecond\r\n' })).result.status, 'rejected')
    await f.execute('claude_code_Write', { file_path: 'overlap', content: 'aaa' })
    assert.equal((await f.execute('claude_code_Edit', { file_path: 'overlap', old_string: 'aa', new_string: 'b' })).result.diagnostic.code, 'ambiguous-context')
  } finally { await f.close() }
})

test('search includes hidden and ignored files, excludes dependencies and does not follow links', async () => {
  const f = await fixture()
  try {
    await fs.mkdir(join(f.directory, 'nested')); await fs.mkdir(join(f.directory, 'node_modules'))
    await fs.mkdir(join(f.directory, '.git'))
    await fs.writeFile(join(f.directory, '.gitignore'), '.hidden\n')
    await fs.writeFile(join(f.directory, '.hidden'), 'needle hidden\n')
    await fs.writeFile(join(f.directory, 'nested/a.ts'), 'needle one\nnone\nneedle two\n')
    await fs.writeFile(join(f.directory, 'node_modules/a.ts'), 'needle excluded\n')
    await fs.writeFile(join(f.directory, '.git/config'), 'needle excluded\n')
    await fs.symlink('nested/a.ts', join(f.directory, 'link.ts'))
    await fs.symlink('nested', join(f.directory, 'directory-link'))
    const glob = await f.execute('deepseek_harness_glob', { pattern: '*.ts' })
    assert.deepEqual(glob.result.paths, ['nested/a.ts'])
    const hidden = await f.execute('claude_code_Grep', { pattern: 'needle' })
    assert.deepEqual(hidden.result.matches.map(value => value.slice(f.directory.length + 1)).sort(), ['.hidden', 'nested/a.ts'])
    const deepseek = await f.execute('deepseek_harness_grep', { pattern: 'needle', include: '*.ts' })
    assert.equal(deepseek.result.matches.length, 2)
    assert.deepEqual(deepseek.result.matches.map(value => value.line), [1, 3])
    assert.equal((await f.execute('deepseek_harness_grep', { pattern: 'needle', include: '*.ts,*.js' })).result.code, 'invalid-input')
    assert.equal((await f.execute('claude_code_Grep', { pattern: '[' })).result.code, 'invalid-pattern')
    assert.equal((await f.execute('claude_code_Read', { file_path: 'directory-link/a.ts' })).result.code, 'symbolic-link')
    assert.equal((await f.execute('claude_code_Glob', { pattern: '*', path: 'directory-link' })).result.code, 'symbolic-link')
    const only = await f.execute('claude_code_Grep', { pattern: 'needle', glob: '*.ts', output_mode: 'content', '-o': true, '-n': false })
    assert.deepEqual(only.result.matches, [{ path: join(f.directory, 'nested/a.ts'), text: 'needle' }, { path: join(f.directory, 'nested/a.ts'), text: 'needle' }])
    const counted = await f.execute('claude_code_Grep', { pattern: 'needle one\\nnone', glob: '*.ts', output_mode: 'count', multiline: true })
    assert.deepEqual(counted.result.matches, [{ path: join(f.directory, 'nested/a.ts'), count: 1 }])
  } finally { await f.close() }
})

test('image reads enforce model capabilities and return immutable refs without inline bytes', async () => {
  const f = await fixture()
  try {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } }).png().toBuffer()
    await fs.writeFile(join(f.directory, 'image'), png)
    assert.equal((await f.execute('codex_view_image', { path: 'image' })).result.code, 'image-input-unavailable')
    assert.equal(f.imported.length, 0)
    const result = await f.execute('claude_code_Read', { file_path: 'image' }, true)
    assert.equal(result.images[0].assetId, 'image-1')
    assert.equal(f.imported[0].scopeId, 'session-1')
    assert.deepEqual(f.imported[0].bytes, png)
    assert.ok(!JSON.stringify(result).includes(png.toString('base64')))
  } finally { await f.close() }
})

test('file-tool cancellation joins accepted lookups and prevents mutations', async () => {
  const entered = deferred(), release = deferred()
  const f = await fixture({ lookup: async () => { entered.resolve(); await release.promise } })
  try {
    const operation = f.call('claude_code_Write', { file_path: 'cancelled', content: 'text' })
    await entered.promise
    operation.cancel('user-requested')
    let done = false; void operation.done.then(() => { done = true })
    await Promise.resolve(); assert.equal(done, false)
    release.resolve()
    assert.equal((await operation.result).result.status, 'cancelled')
    await operation.done
    await assert.rejects(fs.stat(join(f.directory, 'cancelled')), error => error.code === 'ENOENT')
  } finally { release.resolve(); await f.close() }
})

test('file-tool done propagates underlying mutation cleanup failure after recording committed facts', async () => {
  const f = await fixture({ patchOptions: { filesystem: { async unlink(path) {
    if (path.endsWith('/content')) throw Object.assign(new Error('private'), { code: 'EPERM' })
    await fs.unlink(path)
  } } } })
  try {
    const operation = f.call('deepseek_harness_write', { file_path: 'committed', content: 'text' })
    assert.equal((await operation.result).result.status, 'applied')
    await assert.rejects(operation.done, error => error.category === 'cleanup-failure')
    assert.equal(await fs.readFile(join(f.directory, 'committed'), 'utf8'), 'text')
  } finally { await f.close().catch(() => {}) }
})

test('failed nested actual exit releases a file call even when its result never settles', { timeout: 5000 }, async () => {
  const failure = new Error('image exit failed')
  const f = await fixture({ importImage() {
    return { result: new Promise(() => {}), done: Promise.reject(failure), cancel() {} }
  } })
  try {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } }).png().toBuffer()
    await fs.writeFile(join(f.directory, 'image'), png)
    const operation = f.call('codex_view_image', { path: 'image' }, true)
    await assert.rejects(operation.result, error => error.code === 'cleanup-failed')
    await assert.rejects(operation.done, error => error === failure)
  } finally { await f.close().catch(() => {}) }
})

test('nested result failure requests cancellation and waits for its actual exit', { timeout: 5000 }, async () => {
  const entered = deferred(), release = deferred()
  let cancelled = 0
  const f = await fixture({ importImage() {
    entered.resolve()
    return { result: Promise.reject(new Error('image import failed')), done: release.promise, cancel() { cancelled++ } }
  } })
  try {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } }).png().toBuffer()
    await fs.writeFile(join(f.directory, 'image'), png)
    const operation = f.call('codex_view_image', { path: 'image' }, true)
    await entered.promise
    await Promise.resolve()
    assert.equal(cancelled, 1)
    let exited = false; void operation.done.then(() => { exited = true })
    await Promise.resolve(); assert.equal(exited, false)
    release.resolve()
    await assert.rejects(operation.result, error => error.code === 'unavailable')
    await operation.done
  } finally { release.resolve(); await f.close() }
})

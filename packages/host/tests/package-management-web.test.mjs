import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { setupPackageManagement, validateLocalApplicationArchive, maximumLocalApplicationArchiveSize } from '../dist/web/package-management.js'
import { browserApplicationDirectory } from '../dist/web/package-directory.js'
import { decodeApplicationDirectory } from '../dist/package-management/directory-format.js'

class Element extends EventTarget {
  tagName; hidden = false; disabled = false; value = ''; className = ''; dataset = {}; attributes = {}; children = []; parentElement = null; ownText = ''
  constructor(tag = 'section') { super(); this.tagName = tag }
  set textContent(value) { this.replaceChildren(); this.ownText = String(value) }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join('') }
  append(...children) { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child) } }
  replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; this.ownText = ''; this.append(...children) }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null }
  setAttribute(name, value) { this.attributes[name] = String(value) }
  find(predicate) { if (predicate(this)) return this; for (const child of this.children) { const match = child.find(predicate); if (match) return match } }
}
const flush = async () => { for (let n = 0; n < 8; n++) await new Promise(resolve => setImmediate(resolve)) }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const identity = { appId: 'sample', version: '1.0.0', digest: 'a'.repeat(64), target: { os: 'darwin', arch: 'arm64' } }
const job = (phase, extra = {}) => ({ id: 'operation-1', requestId: 'request-1', phase, identity: null, ...extra })
const state = (operations = [], installations = []) => ({ available: true, trustedPublisherCount: 1, installations, operations })
const payload = () => new File(['signed application archive'], 'sample.anybox-app', { type: 'application/octet-stream' })
function directoryFile(path, content) { const file = new File([content], path.split('/').at(-1)); Object.defineProperty(file, 'webkitRelativePath', { value: `sample/${path}`, configurable: true }); return file }
const localDirectory = () => [directoryFile('manifest.json', '{"schemaVersion":1}'), directoryFile('payload/app.js', 'export async function mount(){}'), directoryFile('licenses/LICENSE', 'MIT')]
function fixture(t, handler, options = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  globalThis.document = { hidden: false, createElement: tag => new Element(tag) }
  const container = new Element(), calls = []
  const view = setupPackageManagement(container, { pollMs: 0, requestId: () => 'request-1', fetch: async (url, init = {}) => { calls.push({ url, init }); return handler(url, init) }, ...options })
  t.after(async () => { await view.dispose(); if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document })
  return { view, calls, container, find: predicate => container.find(predicate) }
}

test('local package selection rejects paths, empty files and oversized archives before any upload', () => {
  assert.equal(maximumLocalApplicationArchiveSize, 256 * 1024 * 1024)
  for (const file of [{ name: 'x.zip', size: 1 }, { name: '../x.anybox-app', size: 1 }, { name: 'C:\\x.anybox-app', size: 1 }, { name: 'x.anybox-app', size: 0 }, { name: 'x.anybox-app', size: maximumLocalApplicationArchiveSize + 1 }]) assert.equal(typeof validateLocalApplicationArchive(file), 'string')
  assert.equal(validateLocalApplicationArchive({ name: 'x.anybox-app', size: maximumLocalApplicationArchiveSize }), undefined)
})

test('install hashes the browser file, accepts one request, uploads raw bytes once and leaves the installed version pending', async t => {
  let current = state()
  const f = fixture(t, async (url, init) => {
    if (init.method === 'GET') return Response.json(current)
    if (init.method === 'POST') return Response.json(job('accepted'), { status: 202 })
    current = state([job('installed', { identity })], [{ appId: 'sample', installed: [{ identity, state: 'installed', source: { reference: '/private/server/path', publisher: 'trusted' } }], selected: null, pending: identity }])
    return Response.json(current.operations[0], { status: 202 })
  })
  await f.view.refresh()
  const file = payload(); f.view.select(file); await f.view.install(); await f.view.refresh()
  const accept = f.calls.filter(call => call.init.method === 'POST'), upload = f.calls.filter(call => call.init.method === 'PUT')
  assert.equal(accept.length, 1); assert.equal(upload.length, 1)
  assert.deepEqual(JSON.parse(accept[0].init.body), { requestId: 'request-1', filename: file.name, archiveDigest: createHash('sha256').update('signed application archive').digest('hex'), archiveSize: file.size })
  assert.equal(upload[0].init.body, file); assert.equal(upload[0].init.headers['Content-Type'], 'application/octet-stream')
  assert.equal(upload[0].url, '/api/client/v1/app-packages/operations/operation-1/archive')
  assert.match(f.container.textContent, /sample 1\.0\.0 · 已安装，待生效/)
  assert.doesNotMatch(f.container.textContent, /private\/server|激活/)
  assert.equal(f.view.snapshot().selectedFilename, null)
  assert.ok(f.calls.every(call => !call.url.includes('/products/')))
})

test('a folder installs directly after explicit local trust even without trusted publishers or signed metadata', async t => {
  const f = fixture(t, async (_url, init) => init.method === 'GET' ? Response.json({ ...state(), trustedPublisherCount: 0 }) : Response.json(job(init.method === 'POST' ? 'accepted' : 'installed')))
  await f.view.refresh()
  const folderInput = f.find(node => node.tagName === 'input' && 'webkitdirectory' in node.attributes)
  assert.ok(folderInput); assert.equal(folderInput.disabled, false)
  f.view.selectDirectory(localDirectory()); await f.view.install()
  assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 0, 'selection alone does not trust local executable content')
  f.view.trustDirectory(true); await f.view.install()
  const accepted = f.calls.filter(call => call.init.method === 'POST'), uploads = f.calls.filter(call => call.init.method === 'PUT')
  assert.equal(accepted.length, 1); assert.equal(uploads.length, 1)
  const file = uploads[0].init.body, bytes = new Uint8Array(await file.arrayBuffer()), input = JSON.parse(accepted[0].init.body)
  assert.deepEqual(input, { requestId: 'request-1', filename: 'sample', sourceFormat: 'directory', localTrust: true, archiveDigest: createHash('sha256').update(bytes).digest('hex'), archiveSize: bytes.length })
  assert.deepEqual(decodeApplicationDirectory(bytes).map(entry => entry.path), ['licenses/LICENSE', 'manifest.json', 'payload/app.js'])
  assert.equal(f.view.snapshot().selectedFilename, null); assert.equal(f.view.snapshot().trustedDirectory, false)
})

test('folder selection rejects mixed roots, malformed names and oversized metadata before upload and resets content-specific trust', async t => {
  const f = fixture(t, async () => Response.json(state())); await f.view.refresh()
  const otherRoot = directoryFile('payload/other.js', 'other'); Object.defineProperty(otherRoot, 'webkitRelativePath', { value: 'other/payload/other.js' })
  for (const files of [[], [directoryFile('payload/app.js', 'missing manifest')], [...localDirectory(), otherRoot], [...localDirectory(), directoryFile('payload/../escape', 'unsafe')], [...localDirectory(), directoryFile('payload/App.js', 'case conflict')]]) {
    if (!files.length) assert.throws(() => browserApplicationDirectory(files))
    f.view.selectDirectory(files); assert.equal(f.view.snapshot().selectedFilename, null)
  }
  const large = directoryFile('manifest.json', '{}'); Object.defineProperty(large, 'size', { value: 4 * 1024 * 1024 + 1 })
  assert.throws(() => browserApplicationDirectory([large]))
  f.view.selectDirectory(localDirectory()); f.view.trustDirectory(true); assert.equal(f.view.snapshot().trustedDirectory, true)
  f.view.selectDirectory(localDirectory()); assert.equal(f.view.snapshot().trustedDirectory, false)
  await f.view.install(); assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 0)
  f.view.select(payload()); assert.equal(f.view.snapshot().selectedSourceFormat, 'archive'); assert.equal(f.view.snapshot().trustedDirectory, false)
})

test('browser folder transport preserves executable modes declared in the file index', async t => {
  const files = localDirectory(), indexed = files.filter(file => !file.webkitRelativePath.endsWith('/manifest.json')).map(file => ({ path: file.webkitRelativePath.slice('sample/'.length), mode: file.name === 'app.js' ? 493 : 420 }))
  files.push(directoryFile('files.json', JSON.stringify({ schemaVersion: 1, files: indexed })))
  const f = fixture(t, async (_url, init) => init.method === 'GET' ? Response.json(state()) : Response.json(job(init.method === 'POST' ? 'accepted' : 'installed')))
  await f.view.refresh(); f.view.selectDirectory(files); f.view.trustDirectory(true); await f.view.install()
  const uploaded = f.calls.find(call => call.init.method === 'PUT')
  const entries = decodeApplicationDirectory(new Uint8Array(await uploaded.init.body.arrayBuffer()))
  assert.equal(entries.find(entry => entry.path === 'payload/app.js').mode, 493)
})

test('closing during a folder file read clears the selection, joins the read and never accepts the late content', async t => {
  const reading = deferred(), files = localDirectory(), file = files.find(file => file.name === 'app.js')
  Object.defineProperty(file, 'arrayBuffer', { value: () => reading.promise })
  const f = fixture(t, async () => Response.json(state())); await f.view.refresh()
  f.view.selectDirectory(files); f.view.trustDirectory(true); const installing = f.view.install(); await flush()
  let closed = false; const closing = f.view.dispose().then(() => { closed = true })
  assert.equal(f.view.snapshot().selectedFilename, null); assert.equal(f.view.snapshot().trustedDirectory, false); assert.equal(closed, false)
  reading.resolve(new TextEncoder().encode('export async function mount(){}').buffer); await Promise.all([installing, closing])
  assert.equal(closed, true); assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 0)
})

test('a lost acceptance response queries its request ID without repeating acceptance or beginning an upload', async t => {
  let current = state()
  const f = fixture(t, async (_url, init) => {
    if (init.method === 'POST') { current = state([job('accepted')]); throw new TypeError('response lost after commit') }
    return Response.json(current)
  })
  await f.view.refresh(); f.view.select(payload()); await f.view.install(); await f.view.refresh()
  assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 1)
  assert.equal(f.calls.filter(call => call.init.method === 'PUT').length, 0)
  assert.equal(f.view.snapshot().operations[0].requestId, 'request-1')
  assert.deepEqual(f.view.snapshot().uncertainRequestIds, [])
  assert.match(f.view.snapshot().message, /不会自动重复上传/)
})

test('a lost upload response observes the committed installation without automatically uploading again', async t => {
  let current = state()
  const f = fixture(t, async (_url, init) => {
    if (init.method === 'POST') return Response.json(job('accepted'))
    if (init.method === 'PUT') { current = state([job('installed', { identity })]); throw new TypeError('upload response lost') }
    return Response.json(current)
  })
  await f.view.refresh(); f.view.select(payload()); await f.view.install(); await f.view.refresh()
  assert.equal(f.view.snapshot().operations[0].phase, 'installed')
  assert.equal(f.calls.filter(call => call.init.method === 'PUT').length, 1)
  assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 1)
})

test('closing during file hashing clears the local selection, joins the read and prevents any late acceptance', async t => {
  const hashing = deferred()
  const f = fixture(t, async () => Response.json(state()), { hash: () => hashing.promise })
  await f.view.refresh(); f.view.select(payload()); const installing = f.view.install()
  let closed = false; const closing = f.view.dispose().then(() => { closed = true })
  assert.equal(f.view.snapshot().selectedFilename, null); assert.equal(f.container.children.length, 0)
  assert.equal(closed, false)
  const replacement = new Element(); replacement.textContent = 'replacement application management'; f.container.append(replacement)
  hashing.resolve('b'.repeat(64)); await Promise.all([installing, closing])
  assert.equal(closed, true); assert.deepEqual(f.container.children, [replacement])
  assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 0)
})

test('closing after acceptance starts joins the response and leaves the accepted server operation uncancelled', async t => {
  const accepting = deferred()
  const f = fixture(t, async (_url, init) => init.method === 'POST' ? accepting.promise : Response.json(state()), { hash: async () => 'b'.repeat(64) })
  await f.view.refresh(); f.view.select(payload()); const installing = f.view.install(); await flush()
  let closed = false; const closing = f.view.dispose().then(() => { closed = true })
  assert.equal(closed, false); assert.equal(f.view.snapshot().selectedFilename, null)
  accepting.resolve(Response.json(job('accepted'))); await Promise.all([installing, closing])
  assert.equal(closed, true); assert.equal(f.calls.filter(call => call.init.method === 'PUT').length, 0)
  assert.equal(f.calls.filter(call => call.url.endsWith('/cancel')).length, 0)
})

test('an upload pending in the server can still be observed and cancelled explicitly while the file controls are busy', async t => {
  const uploading = deferred(), cancellation = deferred(); let current = state()
  const f = fixture(t, async (url, init) => {
    if (url.endsWith('/cancel')) return cancellation.promise
    if (init.method === 'POST') { current = state([job('accepted')]); return Response.json(current.operations[0]) }
    if (init.method === 'PUT') { current = state([job('verifying')]); return uploading.promise }
    return Response.json(current)
  }, { hash: async () => 'b'.repeat(64) })
  await f.view.refresh(); f.view.select(payload()); const installing = f.view.install(); await flush(); await f.view.refresh()
  assert.equal(f.view.snapshot().busy, true); assert.equal(f.view.snapshot().operations[0].phase, 'verifying')
  let cancelled = false; const cancelling = f.view.cancel('operation-1').then(() => { cancelled = true }); await flush()
  assert.equal(cancelled, false); assert.match(f.container.textContent, /等待宿主确认操作已退出/)
  assert.equal(f.view.snapshot().operations[0].phase, 'verifying')
  current = state([job('cancelled')]); cancellation.resolve(Response.json(current.operations[0])); uploading.resolve(Response.json(current.operations[0]))
  await Promise.all([installing, cancelling]); await f.view.refresh()
  assert.equal(cancelled, true); assert.equal(f.view.snapshot().operations[0].phase, 'cancelled')
})

test('closing during an accepted upload joins it without sending cancellation or publishing late state into a replacement', async t => {
  const uploading = deferred()
  const f = fixture(t, async (_url, init) => init.method === 'POST' ? Response.json(job('accepted')) : init.method === 'PUT' ? uploading.promise : Response.json(state()), { hash: async () => 'b'.repeat(64) })
  await f.view.refresh(); f.view.select(payload()); const installing = f.view.install(); await flush()
  let closed = false; const closing = f.view.dispose().then(() => { closed = true })
  const replacement = new Element(); replacement.textContent = 'new panel'; f.container.append(replacement)
  assert.equal(closed, false); uploading.resolve(Response.json(job('installed', { identity }))); await Promise.all([installing, closing])
  assert.equal(closed, true); assert.deepEqual(f.container.children, [replacement]); assert.equal(replacement.textContent, 'new panel')
  assert.equal(f.calls.filter(call => call.url.endsWith('/cancel')).length, 0)
  assert.equal(f.calls.filter(call => call.init.method === 'PUT').length, 1)
})

test('explicit recovery and staging cleanup use distinct recovery actions and never expose private error details', async t => {
  const current = state([job('recovery-required', { identity, error: { code: 'private-error', message: '/private/user/token SECRET' } })])
  const f = fixture(t, async (_url, init) => init.method === 'POST' ? Response.json(current.operations[0]) : Response.json(current))
  await f.view.refresh()
  assert.match(f.container.textContent, /核对并恢复安装/); assert.match(f.container.textContent, /清理本次暂存/)
  assert.doesNotMatch(f.container.textContent, /private\/user|SECRET|private-error/)
  await f.view.recover('operation-1'); await f.view.discard('operation-1')
  assert.deepEqual(f.calls.filter(call => call.init.method === 'POST').map(call => ({ url: call.url, body: JSON.parse(call.init.body) })), [
    { url: '/api/client/v1/app-packages/operations/operation-1/recover', body: { action: 'resume' } },
    { url: '/api/client/v1/app-packages/operations/operation-1/recover', body: { action: 'discard' } },
  ])
})

test('installer failures use actionable lifecycle messages without displaying private error data', async t => {
  let current = state()
  const f = fixture(t, async () => Response.json(current))
  await f.view.refresh()
  for (const [code, expected] of [
    ['publisher-not-authorized', /签名或发布者/], ['archive-size-limit', /超过 256 MiB/], ['installation-upload-integrity-mismatch', /内容校验失败/],
    ['installation-upload-size-mismatch', /不完整/], ['installation-preparation-unavailable', /运行环境/], ['installation-work-exit-unconfirmed', /退出尚未确认/], ['installation-committed-retained', /核对安装登记/],
  ]) {
    current = state([job('recovery-required', { error: { code, message: '/private/secret' } })]); await f.view.refresh()
    assert.match(f.container.textContent, expected); assert.doesNotMatch(f.container.textContent, /private\/secret/)
  }
})

test('a completed upload response shows its failed, cancelled or recovery result instead of claiming background success', async t => {
  let result = job('failed', { error: { code: 'publisher-not-authorized' } })
  const f = fixture(t, async (_url, init) => init.method === 'POST' ? Response.json(job('accepted')) : init.method === 'PUT' ? Response.json(result) : Response.json(state([result])))
  await f.view.refresh()
  for (const [phase, expected] of [['failed', /签名或发布者/], ['cancelled', /已取消/], ['recovery-required', /退出尚未确认/]]) {
    result = job(phase, { error: { code: phase === 'failed' ? 'publisher-not-authorized' : 'installation-work-exit-unconfirmed' } })
    f.view.select(payload()); await f.view.install(); await f.view.refresh()
    assert.match(f.view.snapshot().message, expected); assert.doesNotMatch(f.view.snapshot().message, /已交给宿主处理/)
  }
})

test('an explicit recovery remains cancellable from the same open management panel', async t => {
  const recovering = deferred(); let current = state([job('recovery-required')])
  const f = fixture(t, async (url, init) => {
    if (url.endsWith('/recover') && init.method === 'POST') return recovering.promise
    if (url.endsWith('/cancel') && init.method === 'POST') { current = state([job('cancelled')]); return Response.json(current.operations[0]) }
    return Response.json(current)
  })
  await f.view.refresh(); const resumed = f.view.recover('operation-1'); await flush()
  current = state([job('verifying')]); await f.view.refresh()
  const cancel = f.find(node => node.tagName === 'button' && node.textContent === '取消安装')
  assert.ok(cancel); assert.equal(cancel.disabled, false, 'recovery observation does not block cancellation admission')
  cancel.dispatchEvent(new Event('click')); await flush()
  assert.equal(f.calls.filter(call => call.url.endsWith('/cancel')).length, 1)
  assert.equal(f.view.snapshot().operations[0].phase, 'cancelled')
  recovering.resolve(Response.json(job('cancelled'))); await resumed; await f.view.refresh()
  assert.equal(f.view.snapshot().operations[0].phase, 'cancelled')
})

test('a delayed status read preserves a newer cancellation receipt and then refreshes complete installation facts', async t => {
  const staleRead = deferred(), freshRead = deferred(), cancelling = deferred(); let hold = false, reads = 0
  t.after(() => { staleRead.resolve(Response.json(state())); freshRead.resolve(Response.json(state())); cancelling.resolve(Response.json(job('cancelled', { revision: 3 }))) })
  const f = fixture(t, async (url, init) => {
    if (url.endsWith('/cancel') && init.method === 'POST') return cancelling.promise
    if (hold) return ++reads === 1 ? staleRead.promise : freshRead.promise
    return Response.json(state([job('verifying', { revision: 2 })]))
  })
  await f.view.refresh(); const cancel = f.view.cancel('operation-1'); await flush()
  hold = true; const poll = f.view.refresh(); await flush()
  cancelling.resolve(Response.json(job('cancelled', { revision: 3 }))); await cancel
  assert.equal(f.view.snapshot().operations[0].phase, 'cancelled')
  staleRead.resolve(Response.json(state([job('verifying', { revision: 2 })]))); await poll
  assert.equal(f.view.snapshot().operations[0].phase, 'cancelled', 'an older list does not restore an active operation')
  const facts = [{ appId: 'sample', installed: [{ identity, state: 'installed' }], selected: null, pending: identity }]
  freshRead.resolve(Response.json(state([job('cancelled', { revision: 3 })], facts))); await f.view.refresh()
  assert.deepEqual(f.view.snapshot().installations, facts, 'post-control reconciliation still reads all installation facts')
})

test('a delayed upload response derives its message from the latest confirmed cancellation', async t => {
  const uploading = deferred(); let current = state()
  t.after(() => uploading.resolve(Response.json(job('cancelled', { revision: 3 }))))
  const f = fixture(t, async (url, init) => {
    if (url.endsWith('/cancel')) { current = state([job('cancelled', { revision: 3 })]); return Response.json(current.operations[0]) }
    if (init.method === 'POST') return Response.json(job('accepted', { revision: 1 }))
    if (init.method === 'PUT') return uploading.promise
    return Response.json(current)
  }, { hash: async () => 'a'.repeat(64) })
  await f.view.refresh(); f.view.select(payload()); const install = f.view.install(); await flush()
  await f.view.cancel('operation-1'); await f.view.refresh()
  uploading.resolve(Response.json(job('verifying', { revision: 2 }))); await install; await f.view.refresh()
  assert.equal(f.view.snapshot().operations[0].phase, 'cancelled'); assert.match(f.view.snapshot().message, /本次安装已取消/)
  assert.doesNotMatch(f.view.snapshot().message, /已交给宿主处理/)
})

const activationState = (phase = 'prepared', extra = {}) => ({ id: 'activation-1', requestId: 'request-1', revision: 1, phase, protected: true, targets: [{ identity }], roles: [{ role: 'client', ready: phase === 'completed' }], ...extra })
const pendingState = (activations = []) => ({ ...state([], [{ appId: 'sample', installed: [{ identity, state: 'installed' }], selected: null, pending: identity }]), registryRevision: 7, lifecycleAvailable: true, actual: [], activations })

test('applying versions protects interfaces, awaits all disposal, commits once and reloads only after actual role readiness', async t => {
  const exit = deferred(), calls = []; let current = activationState('handoff'), reloaded = 0
  const f = fixture(t, async (url, init) => {
    if (url.endsWith('/activations') && init.method === 'POST') { calls.push('prepare'); assert.deepEqual(JSON.parse(init.body), { requestId: 'request-1', expectedRegistryRevision: 7 }); return Response.json(activationState()) }
    if (url.endsWith('/commit')) { calls.push('commit'); return Response.json(current, { status: 202 }) }
    if (url.endsWith('/activations/activation-1')) return Response.json(current)
    return Response.json(pendingState())
  }, { activation: { async prepare() { calls.push('interface-guard'); return { async disposeForRestart() { calls.push('dispose-start'); await exit.promise; calls.push('dispose-exit') }, release() { calls.push('release') } } } }, reload() { reloaded++ } })
  await f.view.refresh(); const applying = f.view.applyChanges(); await flush()
  assert.deepEqual(calls, ['interface-guard', 'prepare', 'dispose-start']); assert.equal(reloaded, 0)
  exit.resolve(); await applying; assert.deepEqual(calls, ['interface-guard', 'prepare', 'dispose-start', 'dispose-exit', 'commit']); assert.equal(reloaded, 0)
  current = activationState('completed', { revision: 2, roles: [{ role: 'client', ready: false }] }); await f.view.refresh(); assert.equal(reloaded, 0)
  current = activationState('completed', { revision: 3 }); await f.view.refresh(); assert.equal(reloaded, 1)
  assert.equal(f.calls.filter(call => call.url.endsWith('/commit')).length, 1)
  assert.ok(f.calls.every(call => !call.url.includes('/products/')), 'newly installed applications are never opened')
})

test('unsaved interfaces prevent any backend activation request and retain pending installation', async t => {
  const f = fixture(t, async () => Response.json(pendingState()), { activation: { async prepare() { throw { code: 'application-interface-blocked' } } } })
  await f.view.refresh(); await f.view.applyChanges()
  assert.match(f.view.snapshot().message, /保存所有已打开应用/)
  assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 0); assert.equal(f.view.snapshot().installations[0].pending.version, '1.0.0')
})

test('interface disposal failure cancels preparation and never grants process restart permission', async t => {
  const calls = []
  const f = fixture(t, async (url, init) => {
    if (url.endsWith('/cancel')) { calls.push('cancel'); return Response.json(activationState('cancelled', { revision: 2 })) }
    if (init.method === 'POST') return Response.json(activationState())
    return Response.json(pendingState())
  }, { activation: { async prepare() { return { async disposeForRestart() { calls.push('dispose'); throw { code: 'application-interface-cleanup-failed' } }, release() { calls.push('release') } } } } })
  await f.view.refresh(); await f.view.applyChanges()
  assert.deepEqual(calls.filter(value => value !== 'release'), ['dispose', 'cancel'])
  assert.equal(f.calls.filter(call => call.url.endsWith('/commit')).length, 0)
})

test('a lost restart response observes the durable activation without repeating apply or commit', async t => {
  let current = activationState('loading'), reloaded = 0
  const f = fixture(t, async (url, init) => {
    if (url.endsWith('/commit')) throw new TypeError('response lost after handoff')
    if (url.endsWith('/activations') && init.method === 'POST') return Response.json(activationState())
    if (url.endsWith('/activations/activation-1')) return Response.json(current)
    return Response.json(pendingState())
  }, { activation: { async prepare() { return { async disposeForRestart() {}, release() {} } } }, reload() { reloaded++ } })
  await f.view.refresh(); await f.view.applyChanges(); await f.view.refresh()
  assert.equal(reloaded, 0); assert.equal(f.view.snapshot().activationPending, true)
  current = activationState('completed', { revision: 2 }); await f.view.refresh(); assert.equal(reloaded, 1)
  assert.equal(f.calls.filter(call => call.url.endsWith('/activations') && call.init.method === 'POST').length, 1)
  assert.equal(f.calls.filter(call => call.url.endsWith('/commit')).length, 1)
})

test('a lost prepare response finds its original request before disposal and never repeats acceptance', async t => {
  let accepted = false, disposals = 0, commits = 0
  const f = fixture(t, async (url, init) => {
    if (url.endsWith('/activations') && init.method === 'POST') { accepted = true; throw new TypeError('acceptance response lost') }
    if (url.endsWith('/commit')) { commits++; return Response.json(activationState('handoff', { revision: 2 })) }
    return Response.json(pendingState(accepted ? [activationState()] : []))
  }, { activation: { async prepare() { return { async disposeForRestart() { disposals++ }, release() {} } } } })
  await f.view.refresh(); await f.view.applyChanges(); await f.view.refresh(); await flush()
  assert.equal(disposals, 1); assert.equal(commits, 1)
  assert.equal(f.calls.filter(call => call.url.endsWith('/activations') && call.init.method === 'POST').length, 1)
})

test('role facts show selected and actual generation separately and unavailable management keeps pending versions', async t => {
  const current = { ...pendingState(), lifecycleAvailable: false, actual: [{ role: 'client', generation: 'generation-older', state: 'ready', entries: [{ identity: { ...identity, version: '0.9.0' }, entry: 'client' }] }] }
  const f = fixture(t, async () => Response.json(current), { activation: { async prepare() { throw Error('must not prepare') } } })
  await f.view.refresh(); await f.view.applyChanges()
  assert.match(f.container.textContent, /外部生命周期管理者/); assert.match(f.container.textContent, /generation-older/); assert.match(f.container.textContent, /sample 0\.9\.0/)
  assert.equal(f.find(node => node.tagName === 'button' && node.textContent === '应用更改').disabled, true)
  assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 0)
})

test('explicit activation recovery protects and disposes interfaces before committing the original activation ID', async t => {
  const calls = [], prior = activationState('recovery-required')
  const f = fixture(t, async (url, init) => {
    if (url.endsWith('/resume')) { calls.push('resume'); return Response.json(prior) }
    if (url.endsWith('/commit')) { calls.push('commit'); return Response.json(activationState('loading', { revision: 2 })) }
    if (url.endsWith('/activations/activation-1')) return Response.json(activationState('loading', { revision: 2 }))
    return Response.json(pendingState([prior]))
  }, { activation: { async prepare() { calls.push('interfaces-guard'); return { async disposeForRestart() { calls.push('interfaces-exit') }, release() {} } } } })
  await f.view.refresh(); assert.ok(f.find(node => node.tagName === 'button' && node.textContent === '核对并恢复生效'))
  await f.view.recoverActivation('activation-1')
  assert.deepEqual(calls, ['interfaces-guard', 'resume', 'interfaces-exit', 'commit'])
  assert.equal(f.calls.filter(call => call.url.endsWith('/activations') && call.init.method === 'POST').length, 0)
})

test('a lost recovery protection response never infers permission to dispose from an unchanged recovery phase', async t => {
  let disposed = 0
  const prior = activationState('recovery-required', { protected: false }), f = fixture(t, async (url, init) => {
    if (url.endsWith('/resume')) throw new TypeError('resume response lost')
    if (url.endsWith('/activations/activation-1')) return Response.json(prior)
    return Response.json(pendingState([prior]))
  }, { activation: { async prepare() { return { async disposeForRestart() { disposed++ }, release() {} } } } })
  await f.view.refresh(); await f.view.recoverActivation('activation-1'); await f.view.refresh()
  assert.equal(disposed, 0); assert.equal(f.calls.filter(call => call.url.endsWith('/commit')).length, 0)
  assert.equal(f.calls.filter(call => call.url.endsWith('/resume')).length, 1)
})

test('an unconfirmed protection release after interface cleanup failure is observed without repeating cancellation or disposal', async t => {
  let disposals = 0
  const prior = activationState(), f = fixture(t, async (url, init) => {
    if (url.endsWith('/cancel')) throw new TypeError('cancel response lost')
    if (url.endsWith('/activations') && init.method === 'POST' || url.endsWith('/activations/activation-1')) return Response.json(prior)
    return Response.json(pendingState([prior]))
  }, { activation: { async prepare() { return { async disposeForRestart() { disposals++; throw { code: 'application-interface-cleanup-failed' } }, release() {} } } } })
  await f.view.refresh(); await f.view.applyChanges(); await f.view.refresh(); await f.view.refresh()
  assert.equal(disposals, 1); assert.equal(f.calls.filter(call => call.url.endsWith('/cancel')).length, 1); assert.equal(f.calls.filter(call => call.url.endsWith('/commit')).length, 0)
  assert.match(f.view.snapshot().message, /清理失败/)
})

test('a durable prepared record cannot authorize disposal until current all-page protection is confirmed', async t => {
  let protectedForCommit = false, disposals = 0, commits = 0
  const current = () => activationState('prepared', { protected: protectedForCommit })
  const f = fixture(t, async (url, init) => {
    if (url.endsWith('/activations') && init.method === 'POST') throw new TypeError('response lost while another page guard is pending')
    if (url.endsWith('/commit')) { commits++; return Response.json(activationState('handoff', { revision: 2 })) }
    if (url.endsWith('/activations/activation-1')) return Response.json(current())
    return Response.json(pendingState([current()]))
  }, { activation: { async prepare() { return { async disposeForRestart() { disposals++ }, release() {} } } } })
  await f.view.refresh(); await f.view.applyChanges(); await f.view.refresh(); assert.equal(disposals, 0); assert.equal(commits, 0)
  protectedForCommit = true; await f.view.refresh(); await flush(); assert.equal(disposals, 1); assert.equal(commits, 1)
})

test('uninstall explicitly prepares remove, joins interfaces and observes reclamation without clearing views early or replaying commit', async t => {
  let current = activationState('reclaiming', { kind: 'remove', revision: 2, roles: [{ role: 'client', ready: true }] }); const reloads = [], events = []
  const facts = { ...pendingState(), installations: [{ appId: 'sample', selected: identity, pending: null, installed: [{ identity, state: 'installed' }, { identity: { ...identity, version: '0.9.0' }, state: 'installed' }] }] }
  const f = fixture(t, async (url, init) => {
    if (url.endsWith('/activations') && init.method === 'POST') { events.push('prepare'); assert.deepEqual(JSON.parse(init.body), { requestId: 'request-1', expectedRegistryRevision: 7, kind: 'remove', appIds: ['sample'] }); return Response.json(activationState('prepared', { kind: 'remove' })) }
    if (url.endsWith('/commit')) { events.push('commit'); throw new TypeError('handoff response lost') }
    if (url.endsWith('/activations/activation-1')) return Response.json(current)
    return Response.json(facts)
  }, { activation: { async prepare() { events.push('guard'); return { async disposeForRestart() { events.push('dispose') }, release() {} } } }, reload(ids) { reloads.push(ids) } })
  await f.view.refresh(); assert.ok(f.find(node => node.tagName === 'button' && node.textContent === '卸载 sample'))
  await f.view.removeApplication('sample'); await f.view.refresh(); assert.deepEqual(events, ['guard', 'prepare', 'dispose', 'commit']); assert.deepEqual(reloads, [])
  assert.match(f.container.textContent, /正在回收应用文件，尚未卸载/)
  current = activationState('completed', { kind: 'remove', revision: 3, targets: [{ identity }, { identity: { ...identity, version: '0.9.0' } }] }); await f.view.refresh(); assert.deepEqual(reloads, [['sample']])
  assert.equal(f.calls.filter(call => call.url.endsWith('/commit')).length, 1); assert.equal(f.calls.filter(call => call.url.endsWith('/activations') && call.init.method === 'POST').length, 1)
  assert.ok(f.calls.every(call => !call.url.includes('/products/')))
})

test('uninstall retains failed reclamation facts and resumes the original batch explicitly', async t => {
  const prior = activationState('recovery-required', { kind: 'remove', error: { code: 'package-reclamation-failed' } }), events = [], reloads = []
  const f = fixture(t, async (url, init) => {
    if (url.endsWith('/resume')) { events.push('resume'); return Response.json(prior) }
    if (url.endsWith('/commit')) { events.push('commit'); return Response.json(activationState('reclaiming', { kind: 'remove', revision: 2 })) }
    if (url.endsWith('/activations/activation-1')) return Response.json(activationState('reclaiming', { kind: 'remove', revision: 2 }))
    return Response.json({ ...pendingState([prior]), installations: [{ appId: 'sample', selected: null, pending: null, installed: [{ identity, state: 'reclaiming' }, { identity: { ...identity, version: '0.9.0' }, state: 'removed' }] }] })
  }, { activation: { async prepare() { events.push('guard'); return { async disposeForRestart() { events.push('dispose') }, release() {} } } }, reload(ids) { reloads.push(ids) } })
  await f.view.refresh(); assert.match(f.container.textContent, /尚未卸载/); assert.doesNotMatch(f.container.textContent, /sample 0\.9\.0/)
  assert.ok(f.find(node => node.tagName === 'button' && node.textContent === '核对并恢复卸载'))
  assert.equal(f.find(node => node.tagName === 'button' && node.textContent === '卸载 sample').disabled, true)
  await f.view.recoverActivation('activation-1'); assert.deepEqual(events, ['guard', 'resume', 'dispose', 'commit']); assert.deepEqual(reloads, [])
  assert.equal(f.calls.filter(call => call.url.endsWith('/activations') && call.init.method === 'POST').length, 0)
})

test('active work, another lifetime owner or unsaved interfaces refuses uninstall without claiming success', async t => {
  for (const issue of ['product-busy', 'version-in-use', 'use-unavailable', 'reclamation-root-changed']) {
    const f = fixture(t, async (_url, init) => init.method === 'POST' ? Response.json({ error: { code: issue } }, { status: 409 }) : Response.json(pendingState()), { activation: { async prepare() { return { async disposeForRestart() { assert.fail('cannot dispose refused removal') }, release() {} } } } })
    await f.view.refresh(); await f.view.removeApplication('sample'); assert.equal(f.view.snapshot().activationPending, false); assert.match(f.view.snapshot().message, /任务|独立服务|实际身份已改变/)
  }
})

test('a failed active uninstall can explicitly resume its original protected batch from the same panel', async t => {
  const prior = activationState('recovery-required', { kind: 'remove', revision: 2, error: { code: 'package-reclamation-failed' } }); let failed = false, resumes = 0, commits = 0
  const f = fixture(t, async (url, init) => {
    if (url.endsWith('/activations') && init.method === 'POST') return Response.json(activationState('prepared', { kind: 'remove' }))
    if (url.endsWith('/resume')) { resumes++; return Response.json(prior) }
    if (url.endsWith('/commit')) { commits++; failed = true; return Response.json(prior) }
    if (url.endsWith('/activations/activation-1')) return Response.json(prior)
    return Response.json(pendingState(failed ? [prior] : []))
  }, { activation: { async prepare() { return { async disposeForRestart() {}, release() {} } } } })
  await f.view.refresh(); await f.view.removeApplication('sample'); await f.view.refresh()
  assert.equal(f.find(node => node.tagName === 'button' && node.textContent === '核对并恢复卸载').disabled, false)
  await f.view.recoverActivation('activation-1'); assert.equal(resumes, 1); assert.equal(commits, 2)
  assert.equal(f.calls.filter(call => call.url.endsWith('/activations') && call.init.method === 'POST').length, 1)
})

test('selected versions are effective only after matching actual roles are ready and old install receipts follow current facts', async t => {
  let current = { ...state([job('installed', { identity })], [{ appId: 'sample', installed: [{ identity, state: 'installed' }], selected: identity, pending: null }]),
    activations: [{ id: 'activation-current', requestId: 'apply-current', revision: 1, phase: 'completed', targets: [{ identity }], roles: [{ role: 'client', ready: true }] }],
    actual: [{ role: 'client', generation: 'generation-current', state: 'ready', entries: [{ identity, entry: 'client' }] }] }
  const f = fixture(t, async () => Response.json(current))
  await f.view.refresh()
  const history = f.find(node => node.tagName === 'details')
  assert.match(f.find(node => node.className === 'package-installed').textContent, /sample 1\.0\.0 · 已生效/)
  assert.match(history.find(node => node.dataset.operationId === 'operation-1').textContent, /已生效/)
  assert.doesNotMatch(history.find(node => node.dataset.operationId === 'operation-1').textContent, /待生效/)
  assert.equal(f.find(node => node.className === 'package-pending-banner').hidden, true)

  current = { ...current, actual: [{ ...current.actual[0], entries: [{ identity: { ...identity, version: '0.9.0' }, entry: 'client' }] }] }
  await f.view.refresh()
  assert.match(f.find(node => node.className === 'package-installed').textContent, /已选定，等待就绪/)
  assert.doesNotMatch(f.find(node => node.className === 'package-installed').textContent, /已生效/)

  current = { ...current, actual: [{ ...current.actual[0], entries: [{ identity, entry: 'client' }] }], activations: [{ ...current.activations[0], roles: [{ role: 'client', ready: true }, { role: 'execution', ready: true }] }] }
  await f.view.refresh()
  assert.match(f.find(node => node.className === 'package-installed').textContent, /已选定，等待就绪/, 'a missing expected role cannot be inferred ready')
  current = { ...current, actual: [...current.actual, { role: 'execution', generation: 'generation-current', state: 'ready', entries: [{ identity, entry: 'execution' }] }] }
  await f.view.refresh()
  assert.match(f.find(node => node.className === 'package-installed').textContent, /已生效/)
})

test('source buttons open their own folder or archive chooser without uploading content', async t => {
  const f = fixture(t, async () => Response.json(state()))
  await f.view.refresh()
  const folder = f.find(node => node.tagName === 'input' && 'webkitdirectory' in node.attributes)
  const archive = f.find(node => node.tagName === 'input' && node.accept === '.anybox-app')
  const opened = []
  folder.click = () => opened.push('folder'); archive.click = () => opened.push('archive')
  for (const label of ['选择文件夹', '选择应用包']) {
    const source = f.find(node => node.tagName === 'button' && node.textContent === label)
    assert.equal(source.disabled, false); source.dispatchEvent(new Event('click'))
  }
  assert.deepEqual(opened, ['folder', 'archive'])
  assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 0)
})

test('clearing a selected folder revokes its local trust without accepting an installation', async t => {
  const f = fixture(t, async () => Response.json(state()))
  await f.view.refresh(); f.view.selectDirectory(localDirectory()); f.view.trustDirectory(true)
  const clear = f.find(node => node.tagName === 'button' && node.textContent === '清除选择')
  assert.equal(clear.hidden, false); clear.dispatchEvent(new Event('click'))
  assert.equal(f.view.snapshot().selectedFilename, null); assert.equal(f.view.snapshot().trustedDirectory, false)
  assert.equal(clear.hidden, true); assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 0)
})

test('historical successful installs show removal instead of a pending version after all installation files are removed', async t => {
  const f = fixture(t, async () => Response.json(state([job('installed', { identity })], [{ appId: 'sample', installed: [{ identity, state: 'removed' }], selected: null, pending: null }])))
  await f.view.refresh()
  const history = f.find(node => node.tagName === 'details'), receipt = history.find(node => node.dataset.operationId === 'operation-1')
  assert.match(receipt.textContent, /sample 1\.0\.0 · 现已卸载/)
  assert.doesNotMatch(receipt.textContent, /待生效/)
  assert.equal(f.find(node => node.className === 'package-installed'), undefined)
  assert.equal(f.find(node => node.className === 'package-pending-banner').hidden, true)
})

test('refresh updates historical records without replacing or collapsing the expanded details element', async t => {
  let current = state([job('cancelled')])
  const f = fixture(t, async () => Response.json(current))
  await f.view.refresh()
  const history = f.find(node => node.tagName === 'details')
  assert.ok(history); assert.equal(history.hidden, false); assert.notEqual(history.open, true)
  history.open = true
  current = state([job('cancelled'), job('completed', { id: 'operation-2', requestId: 'request-2', identity })])
  await f.view.refresh()
  assert.equal(f.find(node => node.tagName === 'details'), history)
  assert.equal(history.open, true)
  assert.ok(history.find(node => node.dataset.operationId === 'operation-2'))
})

test('active work, recovery controls and the latest failure stay outside folded installation history', async t => {
  const operations = [
    job('failed', { id: 'old-failure', identity, updatedAt: '2026-10-18T01:00:00Z' }),
    job('completed', { id: 'successful-install', identity, updatedAt: '2026-10-18T02:00:00Z' }),
    job('failed', { id: 'latest-failure', identity: { ...identity, appId: 'failed-app' }, updatedAt: '2026-10-18T03:00:00Z', error: { code: 'publisher-not-authorized' } }),
    job('verifying', { id: 'active-install', identity: { ...identity, appId: 'active-app' } }),
    job('recovery-required', { id: 'needs-recovery', identity: { ...identity, appId: 'recovery-app' } }),
  ]
  const f = fixture(t, async () => Response.json(state(operations)))
  await f.view.refresh()
  const activity = f.find(node => node.className === 'package-activity'), history = f.find(node => node.tagName === 'details')
  for (const id of ['latest-failure', 'active-install', 'needs-recovery']) {
    assert.ok(activity.find(node => node.dataset.operationId === id), `${id} remains visible`)
    assert.equal(history.find(node => node.dataset.operationId === id), undefined)
  }
  const active = activity.find(node => node.dataset.operationId === 'active-install'), recovery = activity.find(node => node.dataset.operationId === 'needs-recovery')
  assert.equal(active.find(node => node.tagName === 'button' && node.textContent === '取消安装').disabled, false)
  for (const label of ['核对并恢复安装', '清理本次暂存']) assert.equal(recovery.find(node => node.tagName === 'button' && node.textContent === label).disabled, false)
  for (const id of ['old-failure', 'successful-install']) {
    assert.ok(history.find(node => node.dataset.operationId === id))
    assert.equal(activity.find(node => node.dataset.operationId === id), undefined)
  }
})

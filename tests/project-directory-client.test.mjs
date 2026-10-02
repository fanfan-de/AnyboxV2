import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDirectoryPositions, createProjectDirectoryController, createProjectDirectoryLauncher } from '../dist/applications/harness/web/project-directory-client.js'
import { directoryMessageFor } from '../dist/applications/harness/web/project-directory-view.js'
import { deferred } from './helpers/controlled-models.mjs'

const instance = '11111111-1111-4111-8111-111111111111'
const failure = code => Object.assign(new Error(code), { code, status: 409 })
const tick = () => new Promise(resolve => setImmediate(resolve))
const page = (id, path, number = 0, nextPage = null) => ({ browseId: id, page: number, path, homePath: '/remote/home', parentPath: '/', breadcrumbs: [{ name: '/', path: '/' }, { name: path, path }], entries: [], nextPage })
function fixture(options = {}) {
  const calls = [], selected = [], paths = new Map(), positions = options.positions ?? createDirectoryPositions()
  let counter = 0, updates = 0
  const target = {
    connection: { id: 'connection', instanceId: options.instance ?? instance, revision: 3, name: 'Remote', endpoint: 'https://remote.invalid', credentialConfigured: true },
    nativeAvailable: options.nativeAvailable ?? (async () => false),
    pickNative: options.pickNative ?? (async () => '/native/project'),
    async api(url, body, signal) {
      calls.push({ url, body, signal })
      const custom = options.api?.(url, body, signal)
      if (custom !== undefined) return custom
      if (url === '/instance') return { apiVersion: 1, instanceId: options.instance ?? instance, capabilities: options.capabilities ?? ['projects.browse', 'projects.create-directory'] }
      if (url.endsWith('/close')) return { ok: true }
      if (url.endsWith('/create')) return { path: paths.get(body.browseId).replace(/\/$/, '') + '/' + body.name }
      if (body?.action === 'open') { const id = String(++counter); paths.set(id, body.path ?? '/remote/home'); return { browseId: id, homePath: '/remote/home' } }
      if (body?.action === 'page') return page(body.browseId, paths.get(body.browseId), body.page)
      throw new Error('Unexpected ' + url)
    },
    async register(path, signal) { calls.push({ url: '/projects', body: { path }, signal }); return options.register ? options.register(path, signal) : { id: `h:${options.instance ?? instance}:project`, path, name: 'Project', available: true } },
  }
  const controller = createProjectDirectoryController(target, { positions, changed() { updates++ }, selected(project) { selected.push(project) } })
  return { controller, calls, selected, positions, updates: () => updates }
}

function launcherFixture(options = {}) {
  const calls = [], selected = [], errors = []
  let browsed = 0
  const target = {
    connection: { id: 'local-connection', instanceId: instance, revision: 3, name: 'Local', endpoint: 'http://127.0.0.1', credentialConfigured: true },
    async nativeAvailable(signal) { calls.push({ method: 'available', signal }); return options.nativeAvailable ? options.nativeAvailable(signal) : true },
    async pickNative(signal) { calls.push({ method: 'pick', signal }); return options.pickNative ? options.pickNative(signal) : '/native/project' },
    async register(path, signal) {
      calls.push({ method: 'register', path, signal })
      return options.register ? options.register(path, signal) : { id: `h:${instance}:project`, path, name: 'Project', available: true }
    },
    async api() { throw new Error('Native selection must not browse directories') },
  }
  const launcher = createProjectDirectoryLauncher()
  const open = () => launcher.open(target, { browse() { browsed++ }, selected(project) { selected.push(project) }, failed(error) { errors.push(error) } })
  return { launcher, target, open, calls, selected, errors, browsed: () => browsed }
}

test('first browse uses remote home; browse, page and cancel do not register a project', async () => {
  const f = fixture()
  await f.controller.initialize()
  assert.equal(f.controller.snapshot().page.path, '/remote/home')
  const opening = f.calls.find(call => call.body?.action === 'open')
  assert.equal('path' in opening.body, false)
  assert.equal(f.controller.snapshot().canSelect, true)
  assert.equal(f.calls.filter(call => call.url === '/projects').length, 0)
  f.controller.close()
  assert.equal(f.calls.at(-1).url, '/projects/directories/close')
  assert.equal(f.calls.filter(call => call.url === '/projects').length, 0)
})

test('path memory is scoped by instance and inaccessible storage retains a memory fallback', async () => {
  const positions = createDirectoryPositions({ getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } })
  const a = fixture({ positions }), b = fixture({ positions, instance: '22222222-2222-4222-8222-222222222222' })
  await a.controller.initialize(); await a.controller.navigate('/same/path')
  await b.controller.initialize()
  assert.equal(b.controller.snapshot().page.path, '/remote/home')
  const reopened = fixture({ positions }); await reopened.controller.initialize()
  assert.equal(reopened.controller.snapshot().page.path, '/same/path')
  await reopened.controller.submit()
  assert.equal(reopened.selected[0].path, '/same/path')
  assert.ok(reopened.selected[0].id.includes(instance))
  for (const f of [a, b, reopened]) f.controller.close()
})

test('late reservations are closed, old pages are ignored, and close aborts pending reads', async () => {
  const opens = [], pages = []
  const f = fixture({ api(url, body, signal) {
    if (body?.action === 'open') { const job = deferred(); opens.push({ body, signal, job }); return job.promise }
    if (body?.action === 'page') { const job = deferred(); pages.push({ body, signal, job }); return job.promise }
  } })
  const init = f.controller.initialize(); await tick()
  const newer = f.controller.navigate('/new')
  assert.equal(opens[0].signal.aborted, true)
  opens[1].job.resolve({ browseId: 'new', homePath: '/remote/home' }); await tick()
  pages[0].job.resolve(page('new', '/new')); await newer
  opens[0].job.resolve({ browseId: 'old', homePath: '/remote/home' }); await init
  assert.equal(f.controller.snapshot().page.path, '/new')
  assert.ok(f.calls.some(call => call.url.endsWith('/close') && call.body.browseId === 'old'))
  const oldPage = f.controller.navigate('/old-page'); opens[2].job.resolve({ browseId: 'old-page', homePath: '/remote/home' }); await tick()
  const latest = f.controller.navigate('/latest'); opens[3].job.resolve({ browseId: 'latest', homePath: '/remote/home' }); await tick()
  assert.equal(pages[1].signal.aborted, true)
  pages[2].job.resolve(page('latest', '/latest')); await latest
  pages[1].job.resolve(page('old-page', '/old-page')); await oldPage
  assert.equal(f.controller.snapshot().page.path, '/latest')
  const pending = f.controller.navigate('/close'); opens[4].job.resolve({ browseId: 'closing', homePath: '/remote/home' }); await tick()
  f.controller.close(); const updates = f.updates()
  assert.equal(pages[3].signal.aborted, true)
  pages[3].job.resolve(page('closing', '/close')); await pending
  assert.equal(f.updates(), updates)
  assert.equal(f.controller.snapshot().page.path, '/latest')
})

test('failed navigation preserves last directory and typed path until retry or home recovery', async () => {
  let missing = true
  const f = fixture({ api(url, body) { if (body?.action === 'open' && body.path === '/deleted' && missing) return Promise.reject(failure('directory-missing')) } })
  await f.controller.initialize(); await f.controller.navigate('/deleted')
  assert.equal(f.controller.snapshot().page.path, '/remote/home')
  assert.equal(f.controller.snapshot().pathInput, '/deleted')
  assert.equal(f.controller.snapshot().canSelect, false)
  await f.controller.submit(); assert.equal(f.selected.length, 0)
  missing = false; await f.controller.retry()
  assert.equal(f.controller.snapshot().page.path, '/deleted')
  assert.equal(f.controller.snapshot().error, undefined)
  f.controller.setPath('/edited')
  assert.equal(f.controller.snapshot().canSelect, false)
  await f.controller.navigate()
  assert.equal(f.controller.snapshot().page.path, '/remote/home')
  f.controller.close()
})

test('editing during a page response cannot be overwritten or accidentally selected', async () => {
  const response = deferred()
  let hold = false
  const f = fixture({ api(url, body) { if (hold && body?.action === 'page') return response.promise } })
  await f.controller.initialize(); hold = true
  const navigation = f.controller.navigate('/request'); await tick()
  f.controller.setPath('/still-editing')
  response.resolve(page('2', '/request')); await navigation
  assert.equal(f.controller.snapshot().pathInput, '/still-editing')
  assert.equal(f.controller.snapshot().canSelect, false)
  f.controller.close()
})

test('filtering never discards an unsubmitted path edit', async () => {
  const f = fixture(); await f.controller.initialize()
  f.controller.setPath('/keep-my-edit'); f.controller.filter('source', false); await tick()
  assert.equal(f.controller.snapshot().pathInput, '/keep-my-edit')
  assert.equal(f.controller.snapshot().canSelect, false)
  assert.equal(f.controller.snapshot().page.path, '/remote/home')
  f.controller.close()
})

test('filter and hidden toggle start bounded page-zero queries; expired continuation recovers current path', async () => {
  let expired = true
  const f = fixture({ api(url, body) {
    if (body?.action === 'page' && body.page === 0) return Promise.resolve(page(body.browseId, '/paged', 0, 1))
    if (body?.action === 'page' && expired) return Promise.reject(failure('directory-browse-expired'))
  } })
  await f.controller.initialize()
  f.controller.filter('project', true); await tick()
  const open = f.calls.filter(call => call.body?.action === 'open').at(-1)
  assert.deepEqual(open.body, { action: 'open', path: '/paged', query: 'project', showHidden: true })
  await f.controller.next(); assert.equal(f.controller.snapshot().error.code, 'directory-browse-expired')
  expired = false; await f.controller.retry()
  assert.equal(f.controller.snapshot().page.page, 0)
  assert.equal(f.controller.snapshot().pathInput, '/paged')
  f.controller.close()
})

test('only an authenticated missing capability enables manual compatibility; network failure stays retryable', async () => {
  let offline = true
  const f = fixture({ api(url) { if (url === '/instance' && offline) return Promise.reject(failure('connection-unavailable')) }, capabilities: ['projects.path'] })
  await f.controller.initialize()
  assert.equal(f.controller.snapshot().mode, 'unknown')
  assert.equal(f.controller.snapshot().canSelect, false)
  offline = false; await f.controller.retry()
  assert.equal(f.controller.snapshot().mode, 'manual')
  assert.equal(f.calls.some(call => call.body?.action === 'open'), false)
  f.controller.setPath('/server/project'); await f.controller.submit()
  assert.equal(f.selected[0].path, '/server/project')
  assert.equal(f.calls.some(call => call.url === '/projects/pick'), false)
  f.controller.close()
})

test('supported local selection registers the native folder directly on its captured target', async () => {
  const f = launcherFixture()
  await f.open()
  assert.deepEqual(f.calls.map(call => call.method), ['available', 'pick', 'register'])
  assert.equal(f.browsed(), 0)
  assert.deepEqual(f.selected, [{ id: `h:${instance}:project`, path: '/native/project', name: 'Project', available: true }])
  assert.equal(f.calls[2].path, '/native/project')
  assert.equal(f.calls[1].signal, f.calls[2].signal, 'selection and registration share one cancellable owner')
  assert.deepEqual(f.errors, [])
  await f.launcher.dispose()
})

test('remote or unsupported native selection opens the app browser without picking or registering', async () => {
  for (const nativeAvailable of [async () => false, async () => { throw failure('picker-unavailable') }]) {
    const f = launcherFixture({ nativeAvailable })
    await f.open()
    assert.equal(f.browsed(), 1)
    assert.deepEqual(f.calls.map(call => call.method), ['available'])
    assert.deepEqual(f.selected, [])
    assert.deepEqual(f.errors, [])
    await f.launcher.dispose()
  }
})

test('cancelling the native window leaves projects unchanged and does not open the app browser', async () => {
  const f = launcherFixture({ pickNative: async () => null })
  await f.open()
  assert.deepEqual(f.calls.map(call => call.method), ['available', 'pick'])
  assert.equal(f.browsed(), 0)
  assert.deepEqual(f.selected, [])
  assert.deepEqual(f.errors, [])
  await f.launcher.dispose()
})

test('duplicate native opens are suppressed and closing keeps admission blocked until the picker exits', async t => {
  const path = deferred(), f = launcherFixture({ pickNative: () => path.promise })
  t.after(async () => { path.resolve(null); await f.launcher.dispose() })
  const opened = f.open()
  assert.ok(opened instanceof Promise)
  assert.equal(f.open(), undefined)
  await tick()
  assert.deepEqual(f.calls.map(call => call.method), ['available', 'pick'])
  let joined = false
  const closing = f.launcher.close().then(() => { joined = true })
  assert.equal(f.calls[1].signal.aborted, true)
  assert.equal(f.open(), undefined, 'an abort signal is not picker exit')
  await tick()
  assert.equal(joined, false)
  path.resolve('/late/native/project')
  await Promise.all([opened, closing])
  assert.equal(f.browsed(), 0)
  assert.deepEqual(f.selected, [])
  assert.deepEqual(f.errors, [])
  assert.equal(f.calls.some(call => call.method === 'register'), false, 'a late selection after close must not register')
  const reopened = f.open()
  assert.ok(reopened instanceof Promise, 'the picker becomes available after its actual exit')
  await reopened
  assert.equal(f.selected[0].path, '/late/native/project')
})

for (const supported of [false, true]) test(`disposing joins a pending native availability check and ignores late supported=${supported}`, async t => {
  const available = deferred(), f = launcherFixture({ nativeAvailable: () => available.promise })
  t.after(async () => { available.resolve(supported); await f.launcher.dispose() })
  const opened = f.open(); await tick()
  let joined = false
  const disposing = f.launcher.dispose().then(() => { joined = true })
  assert.equal(f.calls[0].signal.aborted, true)
  assert.equal(f.open(), undefined)
  await tick()
  assert.equal(joined, false)
  available.resolve(supported)
  await Promise.all([opened, disposing])
  assert.deepEqual(f.calls.map(call => call.method), ['available'])
  assert.equal(f.browsed(), 0)
  assert.deepEqual(f.selected, [])
  assert.deepEqual(f.errors, [])
  assert.equal(f.open(), undefined, 'disposed launchers cannot be reused')
})

test('closing while registration is pending waits for exit and ignores a late successful project', async t => {
  const registered = deferred(), f = launcherFixture({ register: () => registered.promise })
  t.after(async () => { registered.resolve({ id: `h:${instance}:project`, path: '/native/project' }); await f.launcher.dispose() })
  const opened = f.open(); await tick()
  assert.equal(f.calls.at(-1).method, 'register')
  let joined = false
  const closing = f.launcher.close().then(() => { joined = true })
  assert.equal(f.calls.at(-1).signal.aborted, true)
  assert.equal(f.open(), undefined)
  await tick()
  assert.equal(joined, false)
  registered.resolve({ id: `h:${instance}:project`, path: '/native/project', name: 'Project', available: true })
  await Promise.all([opened, closing])
  assert.deepEqual(f.calls.map(call => call.method), ['available', 'pick', 'register'])
  assert.equal(f.browsed(), 0)
  assert.deepEqual(f.selected, [], 'closing must not navigate to an accepted late registration')
  assert.deepEqual(f.errors, [])
})

test('native picker and fixed connection registration failures report errors without redirecting', async () => {
  for (const [phase, code] of [['pickNative', 'picker-unavailable'], ['register', 'connection-changed'], ['register', 'instance-mismatch']]) {
    const error = failure(code), f = launcherFixture({ [phase]: async () => { throw error } })
    await f.open()
    assert.deepEqual(f.errors, [error])
    assert.deepEqual(f.selected, [])
    assert.equal(f.browsed(), 0)
    assert.deepEqual(f.calls.map(call => call.method), phase === 'pickNative' ? ['available', 'pick'] : ['available', 'pick', 'register'])
    await f.launcher.dispose()
  }
})

test('connection revision/identity failures block retries and writes for the life of the dialog', async () => {
  for (const code of ['connection-changed', 'instance-mismatch']) {
    const f = fixture({ register: () => Promise.reject(failure(code)) })
    await f.controller.initialize(); await f.controller.submit()
    assert.equal(f.controller.snapshot().blocked, true)
    const count = f.calls.length
    await f.controller.retry(); await f.controller.navigate('/other'); f.controller.setPath('/other'); await f.controller.submit()
    assert.equal(f.calls.length, count)
    assert.equal(f.selected.length, 0)
    f.controller.close()
  }
})

test('duplicate confirm is suppressed while registration is pending and errors stay in the dialog', async () => {
  const result = deferred(), f = fixture({ register: () => result.promise })
  await f.controller.initialize()
  const pending = f.controller.submit(); await f.controller.submit()
  assert.equal(f.calls.filter(call => call.url === '/projects').length, 1)
  result.reject(failure('project-unavailable')); await pending
  assert.equal(f.controller.snapshot().error.code, 'project-unavailable')
  assert.equal(f.controller.snapshot().pathInput, '/remote/home')
  assert.equal(f.controller.snapshot().canSelect, false)
  assert.match(directoryMessageFor(failure('directory-permission-denied'), () => 'fallback'), /Harness.*账户.*权限/)
  f.controller.close()
})

test('new folder uses the captured remote browse reservation and enters the canonical result before project selection', async () => {
  const f = fixture({ api(url) { if (url.endsWith('/create')) return Promise.resolve({ path: '/canonical/新项目' }) } })
  await f.controller.initialize()
  assert.equal(f.controller.snapshot().creationSupported, true)
  f.controller.beginCreate(); f.controller.setDirectoryName('新项目')
  assert.equal(f.controller.snapshot().createPath, '/remote/home')
  const browseId = f.controller.snapshot().page.browseId
  await f.controller.createDirectory()
  const creation = f.calls.find(call => call.url === '/projects/directories/create')
  assert.deepEqual(creation.body, { browseId, name: '新项目' })
  assert.equal(f.controller.snapshot().page.path, '/canonical/新项目')
  assert.equal(f.controller.snapshot().createFormOpen, false)
  assert.equal(f.positions.get(instance), '/canonical/新项目')
  assert.equal(f.calls.filter(call => call.url === '/projects').length, 0)
  assert.equal(f.selected.length, 0)
  await f.controller.submit()
  assert.equal(f.selected[0].path, '/canonical/新项目')
  assert.ok(f.selected[0].id.includes(instance))
  f.controller.close()
})

test('new folder is unavailable without the capability, with an edited path, or while reading', async () => {
  for (const capabilities of [['projects.browse'], ['projects.path']]) {
    const f = fixture({ capabilities }); await f.controller.initialize()
    assert.equal(f.controller.snapshot().creationSupported, false)
    f.controller.beginCreate(); f.controller.setDirectoryName('unavailable'); await f.controller.createDirectory()
    assert.equal(f.controller.snapshot().createFormOpen, false)
    assert.equal(f.calls.some(call => call.url.endsWith('/create')), false)
    f.controller.close()
  }
  const response = deferred(); let hold = false
  const f = fixture({ api(url, body) { if (hold && body?.action === 'page') return response.promise } })
  await f.controller.initialize()
  f.controller.beginCreate(); f.controller.setDirectoryName('child'); f.controller.setPath('/typed/not-browsed')
  assert.equal(f.controller.snapshot().canCreate, false)
  await f.controller.createDirectory()
  assert.equal(f.calls.some(call => call.url.endsWith('/create')), false)
  f.controller.setPath('/remote/home'); hold = true
  const reading = f.controller.navigate('/next'); await tick()
  f.controller.beginCreate()
  assert.equal(f.controller.snapshot().createFormOpen, false)
  response.resolve(page('2', '/next')); await reading
  f.controller.close()
})

for (const code of ['directory-exists', 'directory-name-invalid']) test(`new folder preserves its name and parent after ${code} without automatic write retry`, async () => {
  let rejected = true
  const f = fixture({ api(url) { if (url.endsWith('/create') && rejected) return Promise.reject(failure(code)) } })
  await f.controller.initialize(); f.controller.beginCreate(); f.controller.setDirectoryName('keep this name')
  await f.controller.createDirectory()
  assert.equal(f.controller.snapshot().createFormOpen, true)
  assert.equal(f.controller.snapshot().directoryName, 'keep this name')
  assert.equal(f.controller.snapshot().createPath, '/remote/home')
  assert.equal(f.controller.snapshot().createError.code, code)
  assert.equal(f.controller.snapshot().canCreate, false)
  await f.controller.retry(); await f.controller.createDirectory()
  assert.equal(f.calls.filter(call => call.url.endsWith('/create')).length, 1)
  assert.notEqual(directoryMessageFor(failure(code), () => 'fallback'), 'fallback')
  rejected = false; f.controller.setDirectoryName('corrected'); await f.controller.createDirectory()
  assert.equal(f.controller.snapshot().page.path, '/remote/home/corrected')
  f.controller.close()
})

test('pending folder creation suppresses duplicates, path edits, navigation, filters, selection and retries', async () => {
  const response = deferred(), f = fixture({ api(url) { if (url.endsWith('/create')) return response.promise } })
  await f.controller.initialize(); f.controller.beginCreate(); f.controller.setDirectoryName('only-child')
  const pending = f.controller.createDirectory(), count = f.calls.length
  assert.equal(f.controller.snapshot().creating, true)
  assert.equal(f.controller.snapshot().canSelect, false)
  f.controller.setDirectoryName('duplicate'); f.controller.setPath('/edited'); f.controller.filter('filter', true)
  await f.controller.createDirectory(); await f.controller.navigate('/other'); await f.controller.next(); await f.controller.restart(); await f.controller.submit(); await f.controller.retry()
  assert.equal(f.calls.length, count)
  assert.equal(f.controller.snapshot().directoryName, 'only-child')
  assert.equal(f.controller.snapshot().pathInput, '/remote/home')
  assert.equal(f.controller.snapshot().query, '')
  response.resolve({ path: '/remote/home/only-child' }); await pending
  assert.equal(f.controller.snapshot().page.path, '/remote/home/only-child')
  f.controller.close()
})

test('closing aborts folder creation and ignores a late result without navigation or registration', async () => {
  const response = deferred(), f = fixture({ api(url) { if (url.endsWith('/create')) return response.promise } })
  await f.controller.initialize(); f.controller.beginCreate(); f.controller.setDirectoryName('late-child')
  const pending = f.controller.createDirectory(), creation = f.calls.find(call => call.url.endsWith('/create'))
  f.controller.close(); const count = f.calls.length, updates = f.updates()
  assert.equal(creation.signal.aborted, true)
  response.resolve({ path: '/remote/home/late-child' }); await pending
  assert.equal(f.calls.length, count)
  assert.equal(f.updates(), updates)
  assert.equal(f.controller.snapshot().page.path, '/remote/home')
  assert.equal(f.selected.length, 0)
})

test('ambiguous folder creation failure requires a fresh listing and never retries the mutation', async () => {
  const f = fixture({ api(url) { if (url.endsWith('/create')) return Promise.reject(failure('connection-unavailable')) } })
  await f.controller.initialize(); f.controller.beginCreate(); f.controller.setDirectoryName('maybe-created')
  await f.controller.createDirectory()
  assert.equal(f.controller.snapshot().createNeedsRead, true)
  assert.equal(f.controller.snapshot().directoryName, 'maybe-created')
  f.controller.setDirectoryName('another-name'); await f.controller.retry(); await f.controller.createDirectory()
  assert.equal(f.controller.snapshot().canCreate, false)
  f.controller.cancelCreate(); f.controller.beginCreate(); await f.controller.createDirectory()
  assert.equal(f.controller.snapshot().createFormOpen, false)
  await f.controller.restart()
  assert.equal(f.controller.snapshot().canStartCreate, true)
  assert.equal(f.calls.filter(call => call.url.endsWith('/create')).length, 1)
  f.controller.close()
})

test('failed listing after successful folder creation retries only canonical navigation', async () => {
  let failRead = true
  const f = fixture({ api(url, body) {
    if (body?.action === 'open' && body.path === '/remote/home/new' && failRead) return Promise.reject(failure('directory-unavailable'))
  } })
  await f.controller.initialize(); f.controller.beginCreate(); f.controller.setDirectoryName('new'); await f.controller.createDirectory()
  assert.equal(f.controller.snapshot().error.code, 'directory-unavailable')
  assert.equal(f.controller.snapshot().pathInput, '/remote/home/new')
  assert.equal(f.controller.snapshot().createFormOpen, false)
  failRead = false; await f.controller.retry()
  assert.equal(f.controller.snapshot().page.path, '/remote/home/new')
  assert.equal(f.calls.filter(call => call.url.endsWith('/create')).length, 1)
  f.controller.close()
})

test('creation binding failures block future reads and writes on the captured target', async () => {
  const f = fixture({ api(url) { if (url.endsWith('/create')) return Promise.reject(failure('connection-changed')) } })
  await f.controller.initialize(); f.controller.beginCreate(); f.controller.setDirectoryName('child'); await f.controller.createDirectory()
  assert.equal(f.controller.snapshot().blocked, true)
  const count = f.calls.length
  f.controller.setDirectoryName('other'); await f.controller.createDirectory(); await f.controller.navigate('/other'); await f.controller.retry(); await f.controller.submit()
  assert.equal(f.calls.length, count)
  f.controller.close()
})

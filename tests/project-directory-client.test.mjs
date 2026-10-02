import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDirectoryPositions, createProjectDirectoryController } from '../dist/applications/harness/web/project-directory-client.js'
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
      if (url === '/instance') return { apiVersion: 1, instanceId: options.instance ?? instance, capabilities: options.capabilities ?? ['projects.browse'] }
      if (url.endsWith('/close')) return { ok: true }
      if (body?.action === 'open') { const id = String(++counter); paths.set(id, body.path ?? '/remote/home'); return { browseId: id, homePath: '/remote/home' } }
      if (body?.action === 'page') return page(body.browseId, paths.get(body.browseId), body.page)
      throw new Error('Unexpected ' + url)
    },
    async register(path, signal) { calls.push({ url: '/projects', body: { path }, signal }); return options.register ? options.register(path, signal) : { id: `h:${options.instance ?? instance}:project`, path, name: 'Project', available: true } },
  }
  const controller = createProjectDirectoryController(target, { positions, changed() { updates++ }, selected(project) { selected.push(project) } })
  return { controller, calls, selected, positions, updates: () => updates }
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

test('slow launcher information retains native shortcut; native choice still requires explicit registration', async () => {
  const native = deferred()
  const f = fixture({ nativeAvailable: () => native.promise })
  const init = f.controller.initialize(); await tick()
  native.resolve(true); await init
  assert.equal(f.controller.snapshot().nativeAvailable, true)
  await f.controller.pickNative()
  assert.equal(f.controller.snapshot().page.path, '/native/project')
  assert.equal(f.calls.filter(call => call.url === '/projects').length, 0)
  await f.controller.submit(); assert.equal(f.selected[0].path, '/native/project')
  f.controller.close()
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

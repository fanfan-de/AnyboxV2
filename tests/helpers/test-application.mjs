import { fileURLToPath } from 'node:url'
import { createApplicationRuntime } from '../../dist/host/applications/runtime.js'
import { localStorageServiceKey } from '../../dist/storage/port.js'
import { json, requestObject } from '../../dist/host/http-utils.js'

/** A real registered application. No Harness or Models components are imported or installed. */
export function testApplication(id = 'notes', options = {}) {
  const service = `test.${id}`
  return {
    definition: { id, name: id === 'notes' ? 'Notes' : id, icon: 'note', description: '独立测试应用',
      web: { entry: `/apps/${id}/index.js`, styles: [`/apps/${id}/style.css`] } },
    assets: [
      { path: `/apps/${id}/index.js`, file: fileURLToPath(new URL('../fixtures/application/index.js', import.meta.url)), type: 'text/javascript; charset=utf-8' },
      { path: `/apps/${id}/style.css`, file: fileURLToPath(new URL('../fixtures/application/style.css', import.meta.url)), type: 'text/css; charset=utf-8' },
    ],
    http: { service },
    createRuntime(root) {
      options.created?.()
      return createApplicationRuntime(root, async install => {
        install.install({ name: `test-${id}`, inject: [localStorageServiceKey], async apply(ctx, _, deps) {
          const db = deps[localStorageServiceKey], tasks = new Set(), controller = new AbortController()
          await db.migrate(`test-app-${id}`, [{ version: 1, up(tx) {
            tx.execute('CREATE TABLE IF NOT EXISTS test_application_data (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
            tx.execute('INSERT OR IGNORE INTO test_application_data VALUES(?,?)', [id, ''])
          } }])
          ctx.effect(() => async () => { controller.abort(); await Promise.allSettled([...tasks]); await options.cleanup?.(); options.disposed?.() }, 'stop test application and join writes')
          const handle = (req, res, url, context) => {
            const task = (async () => {
              if (url.pathname === '/value' && req.method === 'GET') {
                json(res, 200, await db.read(reader => reader.get('SELECT value FROM test_application_data WHERE id=?', [id]))); return
              }
              if (url.pathname === '/value' && req.method === 'POST') {
                const body = await requestObject(req, ['value']); await options.write?.(controller.signal)
                await db.transaction(tx => { tx.execute('UPDATE test_application_data SET value=? WHERE id=?', [String(body.value), id]) })
                json(res, 200, { value: body.value }); return
              }
              if (url.pathname === '/watch' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: ready\n\n')
                await new Promise(resolve => {
                  const stop = () => res.end()
                  context.signal.addEventListener('abort', stop, { once: true })
                  res.once('close', () => { context.signal.removeEventListener('abort', stop); resolve() })
                }); await options.observerExit?.(); return
              }
              json(res, 404, { error: { code: 'not-found' } })
            })().finally(() => tasks.delete(task))
            tasks.add(task); return task
          }
          ctx.provide(service, { handle, identity: {} })
        } })
        await options.setup?.(install)
      })
    },
  }
}

import { createHostAccessComponent } from '../../dist/host/access.js'
import { createClientHost } from '../../dist/entrypoints/client-main.js'
import { harnessClientApplication } from '../../dist/applications/harness/registration.js'
/** Local browser acceptance host. Uses disposable SQLite and a controlled model; never reads real keys/data. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, request as httpRequest } from 'node:http'
import { Context } from '@nya/core'
import { createTestHarnessHost } from './harness-host.mjs'
import { createLocalSqliteComponent } from '../../dist/storage/sqlite.js'
import { createImageAssetsComponent } from '../../dist/applications/harness/core/image/component.js'
import { installManagedModels } from './managed-models.mjs'
import { hostHttpServiceKey } from '../../dist/host/component.js'
import { createFixtureApplicationApiComponent } from './application-api.mjs'
import { controlledModels, deferred } from './controlled-models.mjs'
import { testApplication } from './test-application.mjs'

const directory = mkdtempSync(join(tmpdir(), 'anybox-workspace-browser-'))
const root = new Context()
let harness, client, qaServer
const qaRequests = new Set()
const closeQaServer = async () => {
  if (!qaServer?.listening) return
  const done = new Promise((resolve, reject) => qaServer.close(error => error ? reject(error) : resolve()))
  for (const request of qaRequests) request.destroy()
  qaServer.closeAllConnections()
  await done
}
try {
  const llm = controlledModels({ call(input) {
    const result = deferred(), done = deferred()
    const content = input.messages.filter(item => item.role === 'user').at(-1)?.content ?? ''
    const message = typeof content === 'string' ? content : content.map(part => part.type === 'text' ? part.text : '[图片]').join(' ')
    const timer = setTimeout(() => { result.resolve(`测试回答：${message}\n${'这是用于验证面板独立滚动的内容。\n'.repeat(16)}`); done.resolve() }, message.includes('hold') ? 60000 : 600)
    return { result: result.promise, done: done.promise, cancel() { clearTimeout(timer); result.reject(new Error('cancelled')); done.resolve() } }
  } })
  if (process.env.ANYBOX_TEST_IMAGE_INPUT === '1') {
    const protocol = llm.protocol.bind(llm)
    llm.protocol = (...args) => ({ ...protocol(...args), recordFormatVersion: 2 })
  }
  await installManagedModels(root, directory, { controlled: llm })
  if (process.env.ANYBOX_TEST_IMAGE_INPUT === '1') {
    const settings = root.get('models.settings'), model = settings.configurations().find(model => model.id === 'default')
    await settings.updateConfiguration(model.id, { capabilities: { ...model.capabilities, imageInput: { support: 'supported' } } }, model.revision)
  }
  await root.installComponent(createLocalSqliteComponent(join(directory, 'test.sqlite')))
  await root.installComponent(createHostAccessComponent('Browser test device'))
  await root.installComponent(createImageAssetsComponent({ directory: join(directory, 'images') }))
  harness = await createTestHarnessHost(root, { agents: [{ id: 'assistant', modelId: 'default', instructions: 'Browser acceptance model.' }] })
  const projects = []
  for (const name of ['Alpha', 'Beta']) {
    const path = join(directory, name); mkdirSync(path)
    mkdirSync(join(path, 'src'))
    writeFileSync(join(path, 'README.md'), `# ${name}\n\n${name} 项目目录树验收。\n`)
    writeFileSync(join(path, 'src', 'example.ts'), `// ${name} project\nexport const example = '${name}'\n`)
    writeFileSync(join(path, '.hidden.txt'), `${name} hidden file\n`)
    projects.push(await harness.openProject(path))
  }
  const sessions = []
  for (let i = 0; i < 5; i++) {
    const session = await harness.createSession(projects[i < 3 ? 0 : 1].id, 'assistant')
    const run = await harness.startRun({ sessionId: session.id, parentNodeId: null, input: `示例会话 ${i + 1}`, idempotencyKey: `seed-${i}` })
    await harness.waitRun(run.id)
    sessions.push(session)
  }
  if (process.env.ANYBOX_TEST_LEGACY_SESSION === '1') {
    // Disposable migrated-format fixture through the database's existing exclusive owner.
    const id = 'legacy-browser-session'
    await root.get('local-storage').transaction(tx => {
      tx.execute("INSERT INTO harness_sessions (id, project_id, agent_id, created_at, history_mode) VALUES (?, ?, ?, ?, 'dialogue-v1')",
        [id, projects[0].id, 'assistant', new Date().toISOString()])
      tx.execute('INSERT INTO harness_nodes (id, session_id, parent_id, input, output) VALUES (?, ?, ?, ?, ?)',
        ['legacy-browser-node', id, null, '旧版会话目录浏览', '保留的旧版回答'])
    })
    sessions.push(await harness.getSession(id))
  }
  await root.installComponent(createFixtureApplicationApiComponent(root, harness.listAgents(), 0, { authenticated: true }))
  const values = new Map(), access = root.get('host.access')
  const openEntry = (_ns,id) => ({ async getPassword(){ return values.get(id) }, async setPassword(value){ values.set(id,value) }, async deleteCredential(){ return values.delete(id) } })
  client = await createClientHost({ path: join(directory, 'client.sqlite'), applications: [
    harnessClientApplication({ localInstanceId: access.instance.instanceId, openEntry }),
    testApplication(),
  ] })
  await client.products.open('agent')
  const issued = await access.issue('browser test')
  await client.root.get('client.connections').save({ name: 'Browser test device', endpoint: root.get(hostHttpServiceKey).url, token: issued.token })
  // Size a real embedded viewport; the in-app browser's emulated viewport can differ from CSS layout width.
  const qaPage = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Harness 三栏布局验收</title><style>
body{margin:0;background:#ddd;font:14px system-ui;color:#222}header{position:sticky;top:0;left:0;z-index:1;display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 14px;background:#fff;border-bottom:1px solid #aaa}
button{padding:6px 12px;border:1px solid #aaa;border-radius:4px;background:#fff;cursor:pointer}button[aria-pressed=true]{background:#222;color:#fff}label{display:flex;align-items:center;gap:8px}input{width:240px}output{font-variant-numeric:tabular-nums}main{padding:12px;width:max-content}iframe{display:block;width:1440px;height:900px;border:0;background:#fff;box-shadow:0 2px 12px #0002}
</style><header aria-label="隔离验收尺寸控制">
<strong>Harness 三栏布局验收</strong><button type="button" data-width="1440" aria-pressed="true">1440px</button><button type="button" data-width="1024" aria-pressed="false">1024px</button><button type="button" data-width="390" aria-pressed="false">390px</button>
<button type="button" id="qa-narrower" aria-label="减小验收宽度 20 像素">−20px</button><button type="button" id="qa-wider" aria-label="增加验收宽度 20 像素">+20px</button>
<label>连续调宽<input id="qa-width" type="range" min="320" max="1600" step="1" value="1440"></label><output id="qa-size" for="qa-width" aria-live="polite">1440 × 900px</output>
</header><main><iframe id="qa-client" title="隔离 Harness 客户端" src="/#/apps/agent" width="1440" height="900"></iframe></main>
<script>
const frame=document.getElementById('qa-client'),range=document.getElementById('qa-width'),size=document.getElementById('qa-size'),presets=[...document.querySelectorAll('[data-width]')];
function setWidth(value){const width=Math.max(320,Math.min(1600,Math.round(Number(value))));frame.style.width=width+'px';frame.width=String(width);range.value=String(width);size.value=width+' × 900px';for(const button of presets)button.setAttribute('aria-pressed',String(Number(button.dataset.width)===width))}
for(const button of presets)button.addEventListener('click',()=>setWidth(button.dataset.width));range.addEventListener('input',()=>setWidth(range.value));document.getElementById('qa-narrower').addEventListener('click',()=>setWidth(Number(range.value)-20));document.getElementById('qa-wider').addEventListener('click',()=>setWidth(Number(range.value)+20));
</script></html>`
  const target = new URL(client.url)
  let qaOrigin
  qaServer = createServer((request, response) => {
    if (request.url === '/__qa' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(qaPage); return
    }
    // The proxy's destination is the fixture client only; request URLs cannot select another host.
    if (!request.url?.startsWith('/') || request.url.startsWith('//')) { response.writeHead(400); response.end(); return }
    const headers = { ...request.headers, host: target.host }
    // Preserve the client's local-origin checks while translating this test-only same-origin hop.
    if (headers.origin === qaOrigin) headers.origin = target.origin
    const outgoing = httpRequest({ hostname: target.hostname, port: target.port, method: request.method, path: request.url, headers }, upstream => {
      response.writeHead(upstream.statusCode ?? 502, upstream.headers)
      response.flushHeaders()
      upstream.once('error', () => response.destroy())
      upstream.once('aborted', () => response.destroy())
      upstream.once('close', () => qaRequests.delete(outgoing))
      response.once('close', () => { if (!response.writableFinished) { upstream.destroy(); outgoing.destroy() } })
      upstream.pipe(response)
    })
    qaRequests.add(outgoing)
    outgoing.once('error', () => {
      qaRequests.delete(outgoing)
      if (response.destroyed) return
      if (!response.headersSent) { response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('隔离客户端暂不可用。') }
      else response.destroy()
    })
    request.once('aborted', () => outgoing.destroy())
    request.once('error', () => outgoing.destroy())
    response.once('close', () => { if (!response.writableFinished) outgoing.destroy() })
    request.pipe(outgoing)
  })
  await new Promise((resolve, reject) => { qaServer.once('error', reject); qaServer.listen(0, '127.0.0.1', resolve) })
  qaOrigin = `http://127.0.0.1:${qaServer.address().port}`
  const qaUrl = `${qaOrigin}/__qa`
  process.stdout.write(JSON.stringify({ url: client.url, qaUrl, projects, sessions }) + '\n')
  let stopped = false
  const stop = async () => { if (stopped) return; stopped = true; await closeQaServer(); await client.close(); await harness.close(); rmSync(directory, { recursive: true, force: true }) }
  process.once('SIGINT', () => { void stop() })
  process.once('SIGTERM', () => { void stop() })
} catch (error) { await closeQaServer(); await client?.close(); await root.fiber.dispose(); rmSync(directory, { recursive: true, force: true }); throw error }

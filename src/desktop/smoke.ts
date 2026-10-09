import { app, BrowserWindow, type BaseWindow } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DesktopWorker } from './worker.js'
import type { DesktopWorkerReady } from './paths.js'
import { desktopOrigin } from './protocol.js'
import { runDesktopTaskSmoke } from './smoke-tasks.js'

export interface DesktopSmokeOptions {
  readonly window: BrowserWindow
  readonly client: DesktopWorker
  readonly execution?: DesktopWorker
  readonly clientReady: DesktopWorkerReady
  readonly local?: DesktopWorkerReady
  readonly transportSecret: string
  readonly keyring: boolean
  readonly userData: string
  readonly reveal: () => void
  readonly shutdown: () => Promise<boolean>
  readonly confirmQuit?: () => Promise<boolean>
  readonly dialogIdle?: () => Promise<void>
  readonly dialogStarted: () => number
  readonly dialogParent: () => BaseWindow | undefined
  readonly dialogCancelled: () => number
}
interface SmokeLocalConnection {
  readonly id: string
  readonly instanceId: string
  readonly endpoint: string
  readonly revision: number
}
/** Explicit QA mode only. The normal application exposes no renderer IPC/test port. */
export async function runDesktopSmoke(options: DesktopSmokeOptions) {
  const { window, client, execution } = options
  const check = (value: unknown, message: string) => { if (!value) throw new Error(message) }
  const stage = (label: string) => console.log(`[desktop smoke] ${label}`)
  check(execution && options.local, 'Local execution worker did not start')
  check(options.keyring, 'Full desktop acceptance requires explicit native Keychain verification')
  const previous = await readFile(join(options.userData, 'smoke-report.json'), 'utf8').then(
    contents => JSON.parse(contents) as { readonly passed?: boolean; readonly localConnection?: SmokeLocalConnection },
    error => { if (error?.code === 'ENOENT') return undefined; throw error })
  const alreadyRan = previous !== undefined
  const consoleErrors: string[] = []
  let observing = true
  const onConsole = (details: { readonly level: string; readonly message: string }) => {
    if (observing && details.level === 'error' && !details.message.includes('ERR_ABORTED')) consoleErrors.push(details.message)
  }
  window.webContents.on('console-message', onConsole)
  const mounted = async () => {
    const end = Date.now() + 15000
    while (!await window.webContents.executeJavaScript(`(() => {
      const workspace = document.querySelector('.harness-app'), manager = document.getElementById('application-manager');
      return !!workspace?.querySelector('#agent--harness-select') && workspace.getClientRects().length > 0 && !workspace.closest('[inert]') && !manager?.matches(':popover-open');
    })()`)) {
      if (Date.now() > end) throw new Error('Shared Harness workspace did not mount')
      await window.webContents.executeJavaScript(`document.getElementById('app-shortcut-agent')?.click()`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  try {
  stage('native runtime and private listener')
  const native = await client.rpc.call('nativeSmoke', { keyring: options.keyring })
  const executionNative = await execution!.rpc.call('nativeSmoke', { keyring: options.keyring })
  const forbidden = await fetch(options.clientReady.url)
  check(forbidden.status === 403, 'Private listener accepted an untrusted request')
  const request = <T = unknown>(path: string, body?: object, headers: Record<string, string> = {}) => window.webContents.executeJavaScript(
    `(async () => { const r = await fetch(${JSON.stringify(path)}, { method: ${JSON.stringify(body ? 'POST' : 'GET')},
      headers: ${JSON.stringify({ ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) })},
      ${body ? `body: ${JSON.stringify(JSON.stringify(body))},` : ''}
    }); if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + ${JSON.stringify(path)}); return r.json(); })()`
  ) as Promise<T>
  const html = await window.webContents.executeJavaScript(`({node: typeof process, require: typeof require, title: document.title, scripts: [...document.scripts].map(s => s.src)})`)
  check(html.node === 'undefined' && html.require === 'undefined', 'Renderer has Node access')
  check(html.scripts.some((src: string) => src.startsWith(`${desktopOrigin}/host/web/`)), 'Shared frontend did not load')
  stage('fixed origin and hidden window')
  await window.webContents.executeJavaScript(`localStorage.setItem('anybox.desktop.smoke', 'stable-origin'); sessionStorage.setItem('anybox.desktop.smoke', 'hidden-window')`)
  window.close(); check(!window.isDestroyed() && !window.isVisible(), 'Closing the window did not hide it')
  options.reveal()
  check(await window.webContents.executeJavaScript(`sessionStorage.getItem('anybox.desktop.smoke')`) === 'hidden-window', 'Hide destroyed the document')
  await window.loadURL(`${desktopOrigin}/`)
  check(await window.webContents.executeJavaScript(`localStorage.getItem('anybox.desktop.smoke')`) === 'stable-origin', 'Reload lost the fixed origin')
  stage('local pairing and Agent admission')
  await request('/api/client/v1/products/agent/open', {})
  const local = await request<{ state: string }>('/api/client/v1/local/retry', {})
  const state = await request<{ status: { state: string; connectionId: string }; instanceId: string }>('/api/client/v1/local')
  check(state.status?.state === 'ready', 'Automatic local pairing did not reach ready')
  check(state.instanceId === options.local!.instanceId, 'Local pairing changed instance identity')
  const connections = await request<readonly SmokeLocalConnection[]>('/api/client/v1/connections')
  const connection = connections.find(item => item.id === state.status.connectionId)
  check(connection, 'Owned local connection missing')
  const previousLocal = previous?.passed ? previous.localConnection : undefined
  if (previousLocal) {
    check(connection!.id === previousLocal.id && connection!.instanceId === previousLocal.instanceId,
      'Restart replaced the owned local connection identity')
    check(connection!.revision === previousLocal.revision + (connection!.endpoint === previousLocal.endpoint ? 0 : 1),
      'Restart changed local revision beyond its endpoint update')
  }
  const binding = { 'X-Anybox-Product-Id': 'agent', 'X-Anybox-Expected-Instance-Id': connection!.instanceId,
    'X-Anybox-Connection-Revision': String(connection!.revision) }
  const base = `/api/connections/${connection!.id}/v1`
  const before = await request<{ state: string; desiredEnabled: boolean }>(base + '/products/agent', undefined, binding)
  check(before.state === 'disabled' || alreadyRan && before.desiredEnabled, 'Pairing implicitly started the execution app')
  await request(base + '/products/agent/open', {}, binding)
  const agents = await request<readonly { id: string }[]>(base + '/agents', undefined, binding)
  check(agents.length > 0, 'Local Harness API unavailable')
  stage('native picker cancellation')
  check(options.dialogIdle, 'Native directory cancellation requires actual dialog cleanup observation')
  const dialogsBefore = options.dialogStarted()
  const cancelledBefore = options.dialogCancelled()
  const pickerPending = window.webContents.executeJavaScript(`(async () => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetch(${JSON.stringify('/api/client/v1/connections/' + connection!.id + '/pick')}, {
        method: 'POST', headers: ${JSON.stringify({ ...binding, 'Content-Type': 'application/json' })}, body: '{}', signal: controller.signal });
      await response.json(); return 'unexpected-completion';
    } catch (error) { return error.name; } finally { clearTimeout(timer); }
  })()`)
  const pickerDeadline = Date.now() + 1000
  while (!options.dialogParent()?.isVisible() && Date.now() < pickerDeadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const parent = options.dialogParent()
  const nativePickerParentVisible = !!parent && !parent.isDestroyed() && parent.isVisible()
  const nativePickerNativeParent = !!parent && !(parent instanceof BrowserWindow) && parent.getParentWindow() === window
  const nativePickerParentAligned = !!parent && ['x', 'y', 'width', 'height'].every(key =>
    parent.getBounds()[key as keyof Electron.Rectangle] === window.getBounds()[key as keyof Electron.Rectangle])
  if (nativePickerParentVisible) options.reveal()
  const picker = await pickerPending
  check(nativePickerParentVisible, 'Native directory panel has a hidden parent')
  check(nativePickerNativeParent, 'Native directory panel is not attached through a renderer-free child')
  check(nativePickerParentAligned, 'Native directory parent is not aligned with the main window')
  check(picker === 'AbortError', 'Native directory request did not observe renderer cancellation')
  check(options.dialogStarted() > dialogsBefore, 'Native directory dialog did not start before renderer cancellation')
  let pickerTimeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([options.dialogIdle!(), new Promise<never>((_, reject) => {
      pickerTimeout = setTimeout(() => reject(new Error('Native directory dialog did not exit within 5s of renderer cancellation')), 5000)
    })])
  } finally { if (pickerTimeout) clearTimeout(pickerTimeout) }
  check(options.dialogCancelled() === cancelledBefore + 1, 'Native panel did not return a real Cancel response')
  check(parent?.isDestroyed() && !options.dialogParent(), 'Native directory presenter leaked after cancellation')
  stage('shared Harness workspace and screenshot')
  await window.loadURL(`${desktopOrigin}/#/apps/agent/workspace`)
  await mounted()
  await writeFile(join(options.userData, 'desktop.png'), (await window.webContents.capturePage()).toPNG())
  const inspections = await Promise.all([client.rpc.call('inspect'), execution!.rpc.call('inspect')])
  stage('local and remote tool tasks, quit admission, and resource cleanup')
  const tasks = await runDesktopTaskSmoke(options, request, base, binding, () => {
    check(consoleErrors.length === 0, 'Shared renderer logged unexpected console errors')
    observing = false
  })
  return { passed: true, native, executionNative, privateListener: true, sandbox: true, sharedFrontend: true,
    hiddenWindow: true, fixedOrigin: true, localPairing: state.status.state, localAgent: agents.length, inspections,
    localConnection: { id: connection!.id, instanceId: connection!.instanceId, endpoint: connection!.endpoint, revision: connection!.revision },
    localConnectionReused: previousLocal ? true : null,
    installed: app.isPackaged, keyringRequested: options.keyring,
    localRetry: !!local, nativePickerCancelled: true, nativePickerParentVisible, nativePickerNativeParent, nativePickerParentAligned,
    rendererConsoleErrors: consoleErrors.length, sharedWorkspaceMounted: true,
    tasks, electron: process.versions.electron, arch: process.arch }
  } finally { window.webContents.off('console-message', onConsole) }
}

import { app, BrowserWindow, dialog, Menu, protocol, session, shell, utilityProcess } from 'electron'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startManagedApplicationHost } from '../package-management/managed-process.js'
import type { ManagedApplicationHost } from '../package-management/managed-process.js'
import { adaptManagedDesktopUtility } from './managed-utility.js'
import { createDesktopProtocolBridge, desktopOrigin, isDesktopUrl } from './protocol.js'
import { installDesktopSessionProtocol } from './session-protocol.js'
import { desktopBeforeUnloadProbe, prepareDesktopQuit } from './quit.js'

// This fixed main owns the window, stable transport and role process lifetimes.
app.setName('Anybox')
const hostSmoke = process.argv.includes('--host-smoke')
if (hostSmoke && !process.env.ANYBOX_DESKTOP_USER_DATA) throw new Error('Host smoke requires an explicit isolated ANYBOX_DESKTOP_USER_DATA directory')
protocol.registerSchemesAsPrivileged([{ scheme: 'anybox-app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false, allowServiceWorkers: false,
} }])
if (process.env.ANYBOX_DESKTOP_USER_DATA) app.setPath('userData', resolve(process.env.ANYBOX_DESKTOP_USER_DATA))
else if (!app.isPackaged) app.setPath('userData', join(app.getPath('appData'), 'Anybox Host Development'))

if (!app.requestSingleInstanceLock()) app.quit()
else {
  let window: BrowserWindow | undefined, managed: ManagedApplicationHost | undefined
  let managedStartup: Promise<ManagedApplicationHost> | undefined
  let bridge: ReturnType<typeof createDesktopProtocolBridge> | undefined
  let sessionProtocol: ReturnType<typeof installDesktopSessionProtocol> | undefined
  let quitting: Promise<void> | undefined, quitAllowed = false, shutdownCommitted = false
  const reveal = () => {
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show(); window.focus()
  }
  app.on('second-instance', reveal)
  app.on('activate', reveal)
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
  process.once('SIGINT', () => app.quit())
  process.once('SIGTERM', () => app.quit())
  const shutdown = async (confirm: boolean) => {
    if (confirm && !shutdownCommitted) {
      const allowed = await prepareDesktopQuit({
        async canLeave() {
          if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return true
          try { return await window.webContents.executeJavaScript(desktopBeforeUnloadProbe) === true }
          catch { return false }
        },
        async confirmDiscard() {
          reveal()
          const result = await dialog.showMessageBox({ type: 'warning', title: '退出 Anybox',
            message: '页面可能有未保存的修改。是否放弃修改并退出？',
            buttons: ['继续编辑', '放弃修改并退出'], defaultId: 0, cancelId: 0 })
          return result.response === 1
        },
        async inspectActivity() { return managed ? managed.inspectForQuit() : { busy: false } },
        async confirmCancelRuns() {
          reveal()
          const result = await dialog.showMessageBox({ type: 'warning', title: '退出 Anybox',
            message: '仍有本机操作运行。退出将停止这些操作，并等待资源清理。',
            buttons: ['继续运行', '退出并等待清理'], defaultId: 0, cancelId: 0 })
          return result.response === 1
        },
        async releaseActivity() { await managed?.releaseQuit() },
      })
      if (!allowed) return false
    }
    shutdownCommitted = true
    bridge?.closeAdmission()
    const errors: unknown[] = []
    try { managed ??= await managedStartup } catch (error) { errors.push(error) }
    const exits = await Promise.allSettled([bridge?.close(), managed?.close()])
    errors.push(...exits.flatMap(result => result.status === 'rejected' ? [result.reason] : []))
    sessionProtocol?.dispose(); sessionProtocol = undefined
    if (errors.length) throw new AggregateError(errors, 'Anybox host cleanup failed')
    return true
  }
  app.on('before-quit', event => {
    if (quitAllowed) return
    event.preventDefault()
    if (quitting) return
    quitting = shutdown(!hostSmoke).then(completed => { if (completed) { quitAllowed = true; app.quit() } })
      .catch(() => dialog.showErrorBox('Anybox 未完成退出', '本机服务清理未完成，请重试退出。'))
      .finally(() => { quitting = undefined })
  })
  const start = async () => {
    await app.whenReady()
    if (shutdownCommitted) return
    const userData = app.getPath('userData'), directory = join(userData, 'data')
    await mkdir(directory, { recursive: true })
    if (shutdownCommitted) return
    const transportSecret = randomBytes(32).toString('base64url')
    managedStartup = startManagedApplicationHost({ path: join(directory, 'client.sqlite'), packageDirectory: join(userData, 'applications'), port: 0,
      trustPolicyPath: process.env.ANYBOX_APPLICATION_TRUST, roleConfigPath: process.env.ANYBOX_APPLICATION_CONFIG,
      roles: ['client', 'execution'], incomingTransportSecret: transportSecret,
      createChild(_entry, role) {
        const child = utilityProcess.fork(fileURLToPath(new URL('./managed-role-entry.js', import.meta.url)), [], {
          cwd: directory, serviceName: `Anybox ${role}`, stdio: 'pipe',
        })
        return adaptManagedDesktopUtility(child)
      } })
    managed = await managedStartup
    if (shutdownCommitted) return
    bridge = createDesktopProtocolBridge(managed.url, transportSecret)
    const partition = session.fromPartition('persist:anybox-host')
    const allowClipboard = (contents: Electron.WebContents | null, permission: string) => permission === 'clipboard-sanitized-write' &&
      !!contents && contents.id === window?.webContents.id && isDesktopUrl(contents.getURL())
    partition.setPermissionRequestHandler((contents, permission, callback) => callback(allowClipboard(contents, permission)))
    partition.setPermissionCheckHandler((contents, permission) => allowClipboard(contents, permission))
    sessionProtocol = installDesktopSessionProtocol(partition, () => window?.webContents.id, request => bridge!.handle(request))
    window = new BrowserWindow({ title: 'Anybox', width: 1440, height: 960, minWidth: 900, minHeight: 600, show: false,
      webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } })
    window.on('close', event => { if (!quitAllowed) { event.preventDefault(); if (process.platform === 'darwin') window?.hide(); else app.quit() } })
    window.webContents.on('will-prevent-unload', event => { if (quitAllowed) event.preventDefault() })
    window.webContents.on('will-navigate', (event, url) => { if (!isDesktopUrl(url)) event.preventDefault() })
    window.webContents.on('will-redirect', (event, url) => { if (!isDesktopUrl(url)) event.preventDefault() })
    window.webContents.setWindowOpenHandler(({ url }) => {
      try { if (['https:', 'http:'].includes(new URL(url).protocol)) void shell.openExternal(url) } catch { /* Invalid external URL. */ }
      return { action: 'deny' }
    })
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Anybox', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { label: '显示 Anybox', click: reveal }] },
    ]))
    await window.loadURL(`${desktopOrigin}/`)
    if (shutdownCommitted) return
    if (hostSmoke) {
      const result = await window.webContents.executeJavaScript(`(async () => {
        const response = await fetch('/api/client/v1/products');
        return { status: response.status, applications: await response.json(), origin: location.origin };
      })()`)
      if (result.status !== 200 || !Array.isArray(result.applications) || result.applications.length !== 0 || result.origin !== desktopOrigin) throw new Error('Empty host desktop smoke failed')
      await writeFile(join(userData, 'host-smoke-report.json'), JSON.stringify({ passed: true, ...result, managed: managed.state }) + '\n')
      await shutdown(false); quitAllowed = true; app.exit(0)
    } else reveal()
  }
  void start().catch(async () => {
    if (!hostSmoke) dialog.showErrorBox('Anybox 无法启动', '客户端启动失败，请检查宿主数据目录。')
    else process.stderr.write('Empty host desktop smoke failed\n')
    try { await shutdown(false); quitAllowed = true; app.exit(1) }
    catch {
      if (hostSmoke) app.exit(1)
      else dialog.showErrorBox('Anybox 未完成清理', '启动失败后的清理未完成，请重试退出。')
    }
  })
}

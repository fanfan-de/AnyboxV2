import { app, BaseWindow, BrowserWindow, dialog, Menu, protocol, session, shell } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { desktopPaths } from '../desktop/paths.js'
import type { DesktopWorkerReady } from '../desktop/paths.js'
import { createDesktopWorker } from '../desktop/worker.js'
import type { DesktopWorker } from '../desktop/worker.js'
import { createDesktopProtocolBridge, desktopOrigin, isDesktopUrl } from '../desktop/protocol.js'
import { rpcFailure } from '../desktop/rpc.js'
import { runDesktopSmoke } from '../desktop/smoke.js'
import { installDesktopSessionProtocol } from '../desktop/session-protocol.js'
import { prepareDirectoryPanelCancellation } from '../desktop/native-dialog.js'
import { prepareDesktopQuit, desktopBeforeUnloadProbe } from '../desktop/quit.js'

const smoke = process.env.ANYBOX_DESKTOP_SMOKE === '1' || process.argv.includes('--desktop-smoke')
const smokeKeyring = process.env.ANYBOX_KEYRING_TESTS === '1' || process.argv.includes('--desktop-smoke-keyring')
const nativeQuitSmoke = smoke && process.argv.includes('--desktop-smoke-native-quit')
if (smoke && !smokeKeyring) {
  process.stderr.write('Desktop smoke requires ANYBOX_KEYRING_TESTS=1 or --desktop-smoke-keyring and uses an isolated test Vault namespace.\n')
  app.exit(1)
}
const argument = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
app.setName('Anybox')
protocol.registerSchemesAsPrivileged([{ scheme: 'anybox-app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false, allowServiceWorkers: false,
} }])
if (smoke) {
  const directory = process.env.ANYBOX_DESKTOP_SMOKE_DIRECTORY ?? argument('--desktop-smoke-directory') ?? await mkdtemp(join(tmpdir(), 'anybox-desktop-smoke-'))
  await mkdir(directory, { recursive: true }); app.setPath('userData', resolve(directory))
} else if (!app.isPackaged) {
  app.setPath('userData', resolve(process.env.ANYBOX_DESKTOP_USER_DATA ?? join(app.getPath('appData'), 'Anybox Development')))
}
const ownsInstance = app.requestSingleInstanceLock()
if (!ownsInstance) app.quit()
else {
  const run = async () => {
  let window: BrowserWindow | undefined, client: DesktopWorker | undefined, execution: DesktopWorker | undefined
  let local: DesktopWorkerReady | undefined, bridge: ReturnType<typeof createDesktopProtocolBridge> | undefined
  let sessionProtocol: ReturnType<typeof installDesktopSessionProtocol> | undefined
  let quitting: Promise<void> | undefined, quitAllowed = false, booting = true, shutdownCommitted = false
  const data = desktopPaths(app.getPath('userData'))
  const namespace = smoke ? `anybox.desktop.smoke.${createHash('sha256').update(app.getPath('userData')).digest('hex').slice(0, 24)}` : app.isPackaged ? 'anybox.desktop' : 'anybox.desktop.dev'
  const transportSecret = randomBytes(32).toString('base64url')
  const nativeDialogs = new Set<Promise<void>>()
  let directoryParent: BaseWindow | undefined
  let nativeDialogsStarted = 0
  let nativeDialogsCancelled = 0
  const reveal = () => {
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    if (directoryParent && !directoryParent.isDestroyed()) {
      // Preserve the native panel as key window; focusing its transparent owner
      // steals the panel's responder chain, including its Cancel action.
      if (!window.isVisible()) window.showInactive()
      if (!directoryParent.isVisible()) directoryParent.showInactive()
    } else { window.show(); window.focus() }
  }
  app.on('second-instance', reveal); app.on('activate', reveal)
  app.on('window-all-closed', () => { /* macOS stays alive until explicit Quit */ })
  process.once('SIGINT', () => app.quit()); process.once('SIGTERM', () => app.quit())
  const workerExit = (kind: 'client' | 'execution', code: number) => {
    if (kind === 'execution') local = undefined
    if (booting || quitting || quitAllowed || smoke) return
    reveal()
    void dialog.showMessageBox({ type: 'error', title: 'Anybox 服务已停止',
      message: kind === 'execution' ? '本机执行服务异常停止。远端设备仍可使用。' : '客户端服务异常停止，需要重新启动应用。',
      detail: `退出代码：${code}。未完成的本机任务将在重启后标记为 interrupted。`,
      buttons: kind === 'execution' ? ['重启本机服务', '稍后'] : ['退出应用', '稍后'], cancelId: 1,
    }).then(async result => {
      if (result.response !== 0) return
      if (kind === 'execution') {
        try { await startExecution(); await client?.rpc.call('retryLocal') } catch { dialog.showErrorBox('本机服务无法启动', '请检查桌面数据目录与系统凭据服务后重试。') }
      } else app.quit()
    })
  }
  const startExecution = async () => {
    if (shutdownCommitted) throw rpcFailure('service-unavailable')
    if (execution && !execution.ended) throw rpcFailure('busy')
    execution = createDesktopWorker('execution', data.data, code => workerExit('execution', code))
    try { local = await execution.rpc.call<DesktopWorkerReady>('start', { kind: 'execution', userData: app.getPath('userData'), namespace }) }
    catch (error) { await execution.close(); throw error }
  }
  const openDirectory = async (signal: AbortSignal) => {
    if (signal.aborted || !window || window.isDestroyed() || quitting) throw rpcFailure('cancelled')
    const cancelNativePanel = process.platform === 'darwin' ? prepareDirectoryPanelCancellation() : undefined
    reveal()
    // Showing a native child establishes macOS window ordering before attaching
    // the panel. Keep its bounds aligned with the main window, without another
    // renderer or a nested modal sheet.
    const parent = new BaseWindow({ ...window.getBounds(), parent: window, show: false,
      frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
      skipTaskbar: true, resizable: false, movable: false, minimizable: false,
      maximizable: false, fullscreenable: false })
    directoryParent = parent
    let finished!: () => void
    const done = new Promise<void>(resolve => { finished = resolve }); nativeDialogs.add(done)
    let dialogEnded = false
    let cancelTimer: ReturnType<typeof setTimeout> | undefined
    const abort = () => {
      if (dialogEnded || parent.isDestroyed()) return
      if (cancelNativePanel) {
        // Cancel this owner's panel directly, independent of key-window focus.
        // Closing the owner would return Stop and trigger bookmark reads.
        if (!cancelNativePanel(parent.getNativeWindowHandle()) && !cancelTimer) {
          cancelTimer = setTimeout(() => { cancelTimer = undefined; abort() }, 10)
        }
      } else parent.close()
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      parent.show(); parent.focus()
      nativeDialogsStarted += 1
      const result = await dialog.showOpenDialog(parent, { title: '选择项目目录', properties: ['openDirectory', 'createDirectory'] })
      if (result.canceled) nativeDialogsCancelled += 1
      if (signal.aborted) throw rpcFailure('cancelled')
      return result.canceled ? undefined : result.filePaths[0]
    } finally {
      dialogEnded = true
      if (cancelTimer) clearTimeout(cancelTimer)
      signal.removeEventListener('abort', abort); if (!parent.isDestroyed()) parent.destroy()
      if (directoryParent === parent) directoryParent = undefined
      if (!quitting && window && !window.isDestroyed() && window.isVisible()) window.focus()
      nativeDialogs.delete(done); finished()
    }
  }
  const shutdown = async (confirm: boolean) => {
    if (confirm && !shutdownCommitted) {
      let pageInspectionFailed = false
      const accepted = await prepareDesktopQuit({
        async canLeave() {
          if (!window || window.isDestroyed() || window.webContents.isDestroyed() || !isDesktopUrl(window.webContents.getURL())) return true
          try { return await window.webContents.executeJavaScript(desktopBeforeUnloadProbe) === true }
          catch { pageInspectionFailed = true; return false }
        },
        async confirmDiscard() {
          reveal()
          const options = { type: 'warning' as const, title: '退出 Anybox',
            message: pageInspectionFailed ? '无法检查页面中的未保存修改。退出可能丢失这些修改。' : '当前页面有未保存的修改或尚未完成的操作。退出将放弃未保存的修改。',
            buttons: ['继续编辑', '放弃修改并退出'], defaultId: 0, cancelId: 0 }
          const result = window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
          return result.response === 1
        },
        async inspectActivity() { return execution && !execution.ended ? execution.rpc.call<{ busy: boolean }>('inspectForQuit') : { busy: false } },
        async confirmCancelRuns() {
          reveal()
          const options = { type: 'warning' as const, title: '退出 Anybox',
            message: '本机仍有操作或任务运行。退出将取消本机任务，并等待资源清理。',
            detail: '远端已接受的任务会继续运行。', buttons: ['继续运行', '退出并取消本机任务'], defaultId: 0, cancelId: 0 }
          const result = window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
          return result.response === 1
        },
        async releaseActivity() { if (execution && !execution.ended) await execution.rpc.call('releaseQuit') },
      })
      if (!accepted) return false
    }
    shutdownCommitted = true
    bridge?.closeAdmission()
    const freeze = await Promise.allSettled([client, execution].filter((worker): worker is DesktopWorker => !!worker && !worker.ended)
      .map(worker => worker.rpc.call('prepareClose')))
    const errors = freeze.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    try { await bridge?.close() } catch (error) { errors.push(error) }
    try { await client?.close() } catch (error) { errors.push(error) }
    try { await execution?.close() } catch (error) { errors.push(error) }
    sessionProtocol?.dispose(); sessionProtocol = undefined
    if (errors.length) throw new AggregateError(errors, 'Desktop shutdown failed')
    return true
  }
  app.on('before-quit', event => {
    if (quitAllowed) return
    event.preventDefault()
    if (quitting) return
    quitting = shutdown(!smoke).then(completed => {
      if (!completed) return
      quitAllowed = true; app.quit()
    }).catch(() => {
      if (smoke) { process.exitCode = 1; quitAllowed = true; app.exit(1) }
      else dialog.showErrorBox('Anybox 未完成退出', '服务清理失败，应用没有报告正常退出。请重试退出以完成清理。')
    }).finally(() => { quitting = undefined })
  })
  try {
    await app.whenReady()
    if (shutdownCommitted) return
    await mkdir(data.data, { recursive: true })
    try { await startExecution() } catch {
      local = undefined
      // An execution startup failure must leave remote connections usable.
    }
    if (shutdownCommitted) return
    client = createDesktopWorker('client', data.data, code => workerExit('client', code))
    client.rpc.handle('local.get', () => {
      if (!local || !execution || execution.ended) throw rpcFailure('local-unavailable')
      return { endpoint: local.url, instanceId: local.instanceId }
    })
    client.rpc.handle('local.issue', (_value, signal) => {
      if (!local || !execution || execution.ended) throw rpcFailure('local-unavailable')
      return execution.rpc.call('issue', undefined, signal)
    })
    client.rpc.handle('local.reconcile', (value, signal) => {
      if (!local || !execution || execution.ended) throw rpcFailure('local-unavailable')
      return execution.rpc.call('reconcile', value, signal)
    })
    client.rpc.handle('directory.pick', (_value, signal) => openDirectory(signal))
    const clientReady = await client.rpc.call<DesktopWorkerReady>('start', {
      kind: 'client', userData: app.getPath('userData'), namespace, transportSecret,
    })
    if (shutdownCommitted) return
    bridge = createDesktopProtocolBridge(clientReady.url, transportSecret)
    const partition = session.fromPartition('persist:anybox-desktop')
    const allowClipboard = (contents: Electron.WebContents | null, permission: string) => permission === 'clipboard-sanitized-write' &&
      contents?.id === window?.webContents.id && !!contents && isDesktopUrl(contents.getURL())
    partition.setPermissionRequestHandler((contents, permission, callback) => callback(allowClipboard(contents, permission)))
    partition.setPermissionCheckHandler((contents, permission) => allowClipboard(contents, permission))
    sessionProtocol = installDesktopSessionProtocol(partition, () => window?.webContents.id, request => bridge!.handle(request))
    window = new BrowserWindow({ title: 'Anybox', width: 1440, height: 960, minWidth: 900, minHeight: 600, show: false,
      webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } })
    window.on('close', event => { if (!quitAllowed) { event.preventDefault(); window?.hide() } })
    window.webContents.on('will-prevent-unload', event => {
      // Only the final quit after confirmation and resource exit may bypass a page veto.
      if (quitAllowed) event.preventDefault()
    })
    window.webContents.on('will-navigate', (event, url) => { if (!isDesktopUrl(url)) event.preventDefault() })
    window.webContents.on('will-redirect', (event, url) => { if (!isDesktopUrl(url)) event.preventDefault() })
    window.webContents.setWindowOpenHandler(({ url }) => {
      try { if (['https:', 'http:'].includes(new URL(url).protocol)) void shell.openExternal(url) } catch { /* deny malformed URLs */ }
      return { action: 'deny' }
    })
    window.webContents.on('render-process-gone', () => {
      if (quitting || smoke) return
      void dialog.showMessageBox({ type: 'error', title: 'Anybox 页面已停止', message: '界面进程异常停止，后台服务仍在运行。',
        buttons: ['重新加载界面', '稍后'], cancelId: 1 }).then(result => { if (result.response === 0) window?.reload() })
    })
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Anybox', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { label: '显示 Anybox', click: reveal },
        { label: '重启本机服务', click: () => {
          if (execution && !execution.ended || quitting) return
          void startExecution().then(() => client?.rpc.call('retryLocal')).catch(() => dialog.showErrorBox('本机服务无法启动', '请检查桌面数据目录与系统凭据服务后重试。'))
        } }] },
    ]))
    await window.loadURL(`${desktopOrigin}/`)
    if (shutdownCommitted) return
    booting = false; reveal()
    if (smoke) {
      try {
        const report = await runDesktopSmoke({ window, client, execution, clientReady, local, transportSecret,
          keyring: smokeKeyring, userData: app.getPath('userData'), reveal,
          shutdown: () => shutdown(nativeQuitSmoke), confirmQuit: nativeQuitSmoke ? () => shutdown(true) : undefined,
          dialogStarted: () => nativeDialogsStarted,
          dialogParent: () => directoryParent,
          dialogCancelled: () => nativeDialogsCancelled,
          dialogIdle: () => Promise.allSettled([...nativeDialogs]).then(() => {}) })
        await writeFile(join(app.getPath('userData'), 'smoke-report.json'), JSON.stringify(report, null, 2) + '\n')
        process.stdout.write('Anybox desktop smoke passed\n')
      } catch (error) {
        process.exitCode = 1
        await writeFile(join(app.getPath('userData'), 'smoke-report.json'), JSON.stringify({ passed: false, error: error instanceof Error ? error.message : 'smoke failed' }) + '\n')
        process.stderr.write(`Anybox desktop smoke failed: ${error instanceof Error ? error.message : 'failure'}\n`)
      }
      await shutdown(false); quitAllowed = true; app.exit(process.exitCode === 1 ? 1 : 0)
    }
  } catch {
    booting = false
    if (!smoke) dialog.showErrorBox('Anybox 无法启动', '客户端启动失败。请检查桌面数据目录与系统凭据服务。')
    try { await shutdown(false) } catch {
      if (!smoke) { dialog.showErrorBox('Anybox 未完成清理', '启动失败后的服务清理没有完成。请通过退出菜单重试清理。'); return }
    }
    quitAllowed = true; app.exit(1)
  }
  }
  void run().catch(() => { app.exit(1) })
}

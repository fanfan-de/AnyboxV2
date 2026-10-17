/** Substitute only the native platform. The real desktop main, RPC, role entries and hosts run. */
import { EventEmitter } from 'node:events'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const services = [], paths = new Map()
let failExecutionFork = process.env.ANYBOX_TEST_FAIL_EXECUTION_FORK === '1'
const snapshot = () => services.map(({ child, kind, url, transportSecret }) => ({ pid: child.pid, kind, url, transportSecret, exited: child.exitCode !== null }))
export const app = Object.assign(new EventEmitter(), {
  isPackaged: false, setName() {}, getPath: name => paths.get(name) ?? process.env.ANYBOX_DESKTOP_USER_DATA,
  setPath: (name, value) => paths.set(name, value), requestSingleInstanceLock: () => true, whenReady: async () => {},
  exit: code => process.exit(code),
  quit() {
    let prevented = false
    app.emit('before-quit', { preventDefault() { prevented = true } })
    if (!prevented) { process.send?.({ type: 'closed', services: snapshot() }); process.exit(0) }
  },
})
process.on('message', value => {
  if (value === 'test-snapshot') process.send({ type: 'snapshot', services: snapshot() })
  if (value === 'test-quit') app.quit()
})
const stopChildren = () => { for (const { child } of services) if (child.exitCode === null) child.kill('SIGKILL') }
process.on('exit', stopChildren)
process.on('disconnect', () => { stopChildren(); process.exit(1) })
export const utilityProcess = { fork(entry) {
  if (entry.endsWith('desktop-execution.js') && failExecutionFork) { failExecutionFork = false; throw new Error('Injected native process startup failure') }
  const child = fork(fileURLToPath(new URL('./desktop-role-child.mjs', import.meta.url)), [entry], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const record = { child, kind: entry.endsWith('desktop-client.js') ? 'client' : 'execution' }; services.push(record)
  child.postMessage = message => { if (message.method === 'start') record.transportSecret = message.value.transportSecret; child.send(message) }
  child.on('message', message => { if (message.type === 'response' && message.value?.url) record.url = message.value.url })
  return child
} }
export class BrowserWindow extends EventEmitter {
  constructor() {
    super()
    this.webContents = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, getURL: () => this.url,
      executeJavaScript: async () => true, setWindowOpenHandler() {} })
  }
  async loadURL(url) { this.url = url }
  show() { if (!this.shown) { this.shown = true; process.send({ type: 'ready', services: snapshot() }) } }
  focus() {} hide() {} isVisible() { return true } isDestroyed() { return false } isMinimized() { return false }
}
export const BaseWindow = BrowserWindow
export const protocol = { registerSchemesAsPrivileged() {} }
const partition = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
  webRequest: { onBeforeSendHeaders() {}, onErrorOccurred() {}, onCompleted() {} }, protocol: { handle() {}, unhandle() {} } }
export const session = { fromPartition: () => partition }
export const Menu = { buildFromTemplate: value => value, setApplicationMenu() {} }
export const dialog = { showErrorBox(title, message) { process.stderr.write(`${title}: ${message}\n`) }, async showMessageBox() { return { response: 0 } } }
export const shell = { async openExternal() {} }

import { utilityProcess } from 'electron'
import { fileURLToPath } from 'node:url'
import { createPrivateRpc } from './rpc.js'

/** Each worker owns its root; main owns only the private process handle. */
export function createDesktopWorker(kind: 'client' | 'execution', cwd: string, onExit: (code: number) => void) {
  const child = utilityProcess.fork(fileURLToPath(new URL('../entrypoints/desktop-worker.js', import.meta.url)), [], {
    cwd, serviceName: `Anybox ${kind}`, stdio: 'pipe',
  })
  const rpc = createPrivateRpc(message => child.postMessage(message))
  child.on('message', message => rpc.receive(message))
  child.on('error', () => { /* Do not print native diagnostic reports; exit owns the failure. */ })
  // Resource owners already redact credentials; never print IPC messages or diagnostic reports.
  child.stdout?.pipe(process.stdout, { end: false })
  child.stderr?.pipe(process.stderr, { end: false })
  let ended = false
  const exited = new Promise<number>(resolve => child.once('exit', code => {
    ended = true; rpc.disconnect(); resolve(code); onExit(code)
  }))
  return { rpc, exited, get ended() { return ended }, async close() {
    if (ended) return
    await rpc.call('close')
    const code = await exited
    if (code !== 0) throw new Error('Desktop worker shutdown failed')
  } }
}
export type DesktopWorker = ReturnType<typeof createDesktopWorker>

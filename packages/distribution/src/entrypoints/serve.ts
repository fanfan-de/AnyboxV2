/** Convenience launcher. Each child owns its own root and persistence. */
import { fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { installProcessShutdown } from './process-shutdown.js'
const children = new Set<ChildProcess>()
let clientStarted = false, stopping = false
const start = (file: string, env = process.env) => {
  const child = fork(fileURLToPath(new URL(file, import.meta.url)), [], { env, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] })
  children.add(child); child.once('exit', () => children.delete(child)); return child
}
const startClient = (instanceId?: string) => {
  if (clientStarted || stopping) return
  clientStarted = true
  start('./client-main.js', { ...process.env, ...(instanceId ? { ANYBOX_LOCAL_INSTANCE_ID: instanceId } : {}) })
}
const harnessServer = start('./harness-server-main.js')
const timer = setTimeout(() => startClient(), 10000)
harnessServer.on('message', value => {
  if (value && typeof value === 'object' && 'type' in value && value.type === 'ready' && 'instanceId' in value && typeof value.instanceId === 'string') {
    clearTimeout(timer); startClient(value.instanceId)
  }
})
harnessServer.once('exit', () => { clearTimeout(timer); startClient() })
installProcessShutdown(async () => {
  stopping = true; clearTimeout(timer)
  await Promise.all([...children].map(child => new Promise<void>(resolve => {
    child.once('exit', () => resolve())
    // Windows kill('SIGTERM') terminates Node immediately, bypassing resource cleanup.
    if (process.platform === 'win32') {
      // A role disconnects only after close has finished; join its pending exit.
      if (child.connected) child.send({ type: 'anybox-role-stop' }, () => {})
    } else child.kill('SIGTERM')
  })))
}, () => { process.stderr.write('Anybox launcher shutdown failed\n') })

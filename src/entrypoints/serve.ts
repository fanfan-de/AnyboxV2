/** Convenience launcher. Each child owns its own root and persistence. */
import { fork } from 'node:child_process'
import type { ChildProcess, ForkOptions } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const children = new Set<ChildProcess>()
let clientStarted = false, stopping = false
const start = (file: string, env = process.env) => {
  const options: ForkOptions & { windowsHide: true } = { env, windowsHide: true, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] }
  const child = fork(fileURLToPath(new URL(file, import.meta.url)), [], options)
  children.add(child); child.once('exit', () => { children.delete(child); if (stopping && !children.size && process.connected) process.disconnect() }); return child
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
const stop = () => {
  if (stopping) return
  stopping = true; clearTimeout(timer)
  for (const child of children) if (child.connected) child.send({ type: 'anybox-stop' }, error => { if (error && child.exitCode === null) { process.exitCode = 1; process.stderr.write('Could not request child cleanup\n') } })
  if (!children.size && process.connected) process.disconnect()
}
process.once('SIGINT', stop); process.once('SIGTERM', stop)
process.on('message', value => { if (value && typeof value === 'object' && 'type' in value && value.type === 'anybox-stop') stop() })
if (process.connected) process.once('disconnect', stop)

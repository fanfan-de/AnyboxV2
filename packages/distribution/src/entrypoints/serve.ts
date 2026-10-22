/** Convenience launcher. Each child owns its own root and persistence. */
import { fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createPrivateRpc, rpcFailure } from '@anybox/host/desktop/rpc'
import { installProcessShutdown } from './process-shutdown.js'
import { installLocalPairingBridge, webLocalPairingEnvironment } from './local-pairing.js'
import type { LocalPairingRpc, LocalPairingTarget } from './local-pairing.js'
const children = new Map<ChildProcess, { readonly rpc: LocalPairingRpc; readonly exited: Promise<void>; ready: boolean }>()
let clientStarted = false, stopping = false
const start = (file: string, env = process.env) => {
  const child = fork(fileURLToPath(new URL(file, import.meta.url)), [], { env: { ...env, [webLocalPairingEnvironment]: '1' }, stdio: ['inherit', 'inherit', 'inherit', 'ipc'] })
  const rpc = createPrivateRpc(message => {
    if (!child.connected) throw rpcFailure('worker-unavailable')
    child.send(message, error => { if (error) rpc.disconnect() })
  })
  child.on('message', rpc.receive)
  child.once('disconnect', () => rpc.disconnect())
  const exited = new Promise<void>(resolve => child.once('close', () => {
    rpc.disconnect()
    child.off('message', rpc.receive)
    children.delete(child)
    resolve()
  }))
  child.once('error', () => { rpc.disconnect(); process.stderr.write('Anybox role could not start\n') })
  const role = { rpc, exited, ready: false }
  child.on('message', value => {
    if (value && typeof value === 'object' && 'type' in value && value.type === 'ready') role.ready = true
  })
  children.set(child, role)
  return { child, rpc }
}
let target: LocalPairingTarget | undefined, localSettled = false
let resolveLocal!: () => void
const localReady = new Promise<void>(resolve => { resolveLocal = resolve })
const settleLocal = (value?: LocalPairingTarget) => {
  target = value
  if (!localSettled) { localSettled = true; resolveLocal() }
}
const getLocal = async (signal: AbortSignal): Promise<LocalPairingTarget | undefined> => {
  signal.throwIfAborted()
  if (!localSettled) await new Promise<void>((resolve, reject) => {
    const abort = () => { cleanup(); reject(rpcFailure('cancelled')) }
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    void localReady.then(() => { cleanup(); resolve() })
    if (signal.aborted) abort()
  })
  signal.throwIfAborted()
  return stopping || !harnessServer.child.connected ? undefined : target
}
const startClient = (instanceId?: string) => {
  if (clientStarted || stopping) return
  clientStarted = true
  const client = start('./client-main.js', { ...process.env, ...(instanceId ? { ANYBOX_LOCAL_INSTANCE_ID: instanceId } : {}) })
  installLocalPairingBridge(client.rpc, harnessServer.rpc, getLocal)
}
const harnessServer = start('./harness-server-main.js')
const timer = setTimeout(() => startClient(), 10000)
harnessServer.child.on('message', value => {
  if (value && typeof value === 'object' && 'type' in value && value.type === 'ready' && 'instanceId' in value && typeof value.instanceId === 'string' && 'url' in value && typeof value.url === 'string') {
    settleLocal({ instanceId: value.instanceId, endpoint: value.url })
    clearTimeout(timer); startClient(value.instanceId)
  }
})
const unavailable = () => { settleLocal(); clearTimeout(timer); startClient() }
harnessServer.child.once('disconnect', unavailable)
harnessServer.child.once('error', unavailable)
harnessServer.child.once('exit', unavailable)
installProcessShutdown(async () => {
  stopping = true; clearTimeout(timer); settleLocal()
  const roles = [...children]
  for (const [, role] of roles) role.rpc.disconnect()
  await Promise.all(roles.map(async ([child, role]) => {
    // A not-yet-loaded entry may miss messages/signals; its explicit launcher flag remembers a lost IPC.
    if (!role.ready) { if (child.connected) child.disconnect() }
    // Windows kill('SIGTERM') terminates Node immediately, bypassing resource cleanup.
    else if (process.platform === 'win32') {
      // A role disconnects only after close has finished; join its pending exit.
      if (child.connected) child.send({ type: 'anybox-role-stop' }, () => {})
    } else child.kill('SIGTERM')
    await role.exited
    await role.rpc.drain()
  }))
}, () => { process.stderr.write('Anybox launcher shutdown failed\n') })

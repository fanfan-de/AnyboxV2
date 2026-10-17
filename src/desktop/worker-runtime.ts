import { createPrivateRpc, rpcFailure } from './rpc.js'
import type { DesktopWorkerStart, DesktopWorkerReady } from './paths.js'
import type { ParentPort } from 'electron'

export type DesktopRpc = ReturnType<typeof createPrivateRpc>
export interface DesktopRoleHost {
  readonly ready: DesktopWorkerReady
  prepareClose(): Promise<void>
  close(): Promise<void>
  inspect?(): { busy: boolean }
  inspectForQuit?(): Promise<{ busy: boolean }>
  releaseQuit?(): void
}
type StartRole = (options: DesktopWorkerStart, rpc: DesktopRpc) => Promise<DesktopRoleHost>

/** Shared private transport only; each entry imports exactly one role's composition. */
export function installDesktopWorkerRpc(rpc: DesktopRpc, kind: DesktopWorkerStart['kind'], start: StartRole, exit: () => void) {
  let host: DesktopRoleHost | undefined, startTask: Promise<DesktopWorkerReady> | undefined, stopping = false
  rpc.handle('start', value => {
    if (stopping) throw rpcFailure('service-unavailable')
    if (startTask) throw rpcFailure('already-started')
    const options = value as DesktopWorkerStart | undefined
    if (!options || options.kind !== kind || typeof options.userData !== 'string' || !options.userData ||
        typeof options.namespace !== 'string' || !options.namespace ||
        (kind === 'client' && (typeof options.transportSecret !== 'string' || !options.transportSecret))) throw rpcFailure('invalid-startup')
    return startTask = start(options, rpc).then(value => { host = value; return value.ready })
  })
  rpc.handle('inspect', () => host?.inspect?.() ?? { busy: false })
  rpc.handle('inspectForQuit', async () => {
    await startTask?.catch(() => {})
    return host?.inspectForQuit?.() ?? { busy: false }
  })
  rpc.handle('releaseQuit', () => host?.releaseQuit?.())
  rpc.handle('prepareClose', async () => {
    stopping = true
    await startTask?.catch(() => {})
    await host?.prepareClose()
  })
  rpc.handle('close', async () => {
    stopping = true
    await startTask?.catch(() => {})
    await host?.close()
    setImmediate(exit)
  })
  // Image and native QA dependencies are not part of normal client startup.
  rpc.handle('nativeSmoke', async value => (await import('./native-smoke.js')).nativeDesktopSmoke((value as { keyring: boolean }).keyring))
}

export function runDesktopWorker(kind: DesktopWorkerStart['kind'], start: StartRole) {
  const parent = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort
  if (!parent) throw new Error('Desktop worker requires a private utility port')
  const rpc = createPrivateRpc(message => parent.postMessage(message))
  installDesktopWorkerRpc(rpc, kind, start, () => process.exit(0))
  parent.on('message', event => rpc.receive(event.data))
}

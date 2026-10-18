import type { ParentPort } from 'electron'
import { createPrivateRpc } from './rpc.js'
import { installManagedRoleRpc } from '../package-management/role-process.js'

/** Fixed Electron utility entry; role identity and reservations arrive only over private IPC. */
const parent = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort
if (!parent) throw new Error('A managed desktop role requires a private utility port')
const rpc = createPrivateRpc(message => parent.postMessage(message))
const lifecycle = installManagedRoleRpc(rpc, () => process.exit(0))
parent.on('message', event => rpc.receive(event.data))
process.once('SIGTERM', () => { void lifecycle.close().then(() => process.exit(0), () => { process.exitCode = 1 }) })

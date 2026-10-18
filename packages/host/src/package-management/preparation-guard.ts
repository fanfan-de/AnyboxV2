/** Fixed host monitor. It owns the preparation group's durable exit proof. */
import { acquirePackageUsageLock } from './usage-locks.js'
import type { PackageUsageLock } from './usage-locks.js'

let target: number | undefined, lock: PackageUsageLock | undefined, closing = false
function exists(pid: number): boolean | undefined {
  try { process.kill(-pid, 0); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; if ((error as NodeJS.ErrnoException).code === 'EPERM') return undefined; throw error }
}
function signal(pid: number, value: NodeJS.Signals): void {
  try { process.kill(-pid, value) }
  catch (error) { if (!['ESRCH', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error }
}
async function close() {
  if (closing) return
  closing = true
  // The PID comes from the private parent's actual spawn handle, before any
  // application code is admitted. The anchor remains held until this group exits.
  if (target) {
    let forced = false
    const started = Date.now()
    for (;;) {
      const observed = exists(target)
      if (observed === false) break
      // EPERM can occur during Unix reparenting. It is uncertainty, never exit proof.
      if (observed === undefined) { await new Promise(resolve => setTimeout(resolve, 20)); continue }
      if (!forced) signal(target, 'SIGTERM')
      if (Date.now() - started >= 150) { forced = true; signal(target, 'SIGKILL') }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  await lock?.release()
  process.exit(0)
}
const stop = () => { void close().catch(() => {
  // Unconfirmed cleanup must retain the real lock and process. A future manager
  // observes it as busy instead of treating a monitor error as exit evidence.
  setInterval(() => {}, 60_000)
}) }
process.once('disconnect', stop)
process.on('message', message => {
  if (closing || !message || typeof message !== 'object' || !('type' in message)) return
  if (message.type === 'stop') { stop(); return }
  if (message.type !== 'start' || target !== undefined) return
  const input = message as { pid?: unknown; directory?: unknown; usageId?: unknown; secret?: unknown }
  if (!Number.isSafeInteger(input.pid) || (input.pid as number) < 2 || typeof input.directory !== 'string' || typeof input.usageId !== 'string' || typeof input.secret !== 'string') { process.exit(1); return }
  try {
    lock = acquirePackageUsageLock(input.directory, { usageId: input.usageId, secret: input.secret })
    target = input.pid as number
    process.send?.({ type: 'ready' })
  } catch {
    process.send?.({ type: 'failed' }, () => process.exit(1))
  }
})
if (!process.connected) stop()

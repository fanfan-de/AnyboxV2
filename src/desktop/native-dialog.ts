import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type {} from 'electron'

interface NativeDirectoryDialog {
  cancelDirectoryPanel(handle: Buffer): boolean
}

let native: NativeDirectoryDialog | undefined
type CancelDirectoryPanel = (handle: Buffer) => boolean | Promise<boolean>
const execute = promisify(execFile)

/** Load before presenting a panel, so a build/load failure cannot strand it. */
export function prepareDirectoryPanelCancellation(): CancelDirectoryPanel {
  if (!['darwin', 'win32'].includes(process.platform) || process.type !== 'browser') {
    throw new Error('Native directory cancellation requires a supported Electron main process')
  }
  if (process.platform === 'win32') {
    const executable = fileURLToPath(new URL('./native/anybox-dialog-host.exe', import.meta.url)).replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
    if (!existsSync(executable)) throw new Error('Native directory cancellation adapter is unavailable')
    return async handle => {
      if (handle.length !== 4 && handle.length !== 8) throw new Error('Invalid native directory window handle')
      const owner = handle.length === 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))
      const { stdout } = await execute(executable, [String(owner), String(process.pid)], { windowsHide: true, timeout: 2000, maxBuffer: 256 })
      if (stdout.trim() !== 'true' && stdout.trim() !== 'false') throw new Error('Native directory cancellation failed')
      return stdout.trim() === 'true'
    }
  }
  native ??= createRequire(import.meta.url)('./native/mac-dialog.node') as NativeDirectoryDialog
  if (typeof native.cancelDirectoryPanel !== 'function') {
    throw new Error('Native directory cancellation adapter is unavailable')
  }
  const cancel = native.cancelDirectoryPanel
  return handle => cancel(handle)
}

/** Cancel only the panel attached to a live, main-process-owned native window. */
export function cancelDirectoryPanel(handle: Buffer): boolean | Promise<boolean> {
  return prepareDirectoryPanelCancellation()(handle)
}

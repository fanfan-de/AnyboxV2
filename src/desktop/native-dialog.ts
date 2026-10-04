import { createRequire } from 'node:module'
import type {} from 'electron'

interface NativeDirectoryDialog {
  cancelDirectoryPanel(handle: Buffer): boolean
}

let native: NativeDirectoryDialog | undefined

/** Load before presenting a panel, so a build/load failure cannot strand it. */
export function prepareDirectoryPanelCancellation(): (handle: Buffer) => boolean {
  if (process.platform !== 'darwin' || process.type !== 'browser') {
    throw new Error('Native directory cancellation requires the macOS Electron main process')
  }
  native ??= createRequire(import.meta.url)('./native/mac-dialog.node') as NativeDirectoryDialog
  if (typeof native.cancelDirectoryPanel !== 'function') {
    throw new Error('Native directory cancellation adapter is unavailable')
  }
  const cancel = native.cancelDirectoryPanel
  return handle => cancel(handle)
}

/** Cancel only the panel attached to a live, main-process-owned native window. */
export function cancelDirectoryPanel(handle: Buffer): boolean {
  return prepareDirectoryPanelCancellation()(handle)
}

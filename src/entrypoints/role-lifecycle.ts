/** Private parent IPC is the portable stop path; Windows process.kill is not graceful. */
export function observeRoleStop(starting: Promise<{ close(): Promise<void> }>, report: (error: unknown) => void) {
  let stopping = false, closing: Promise<void> | undefined
  const stop = () => {
    stopping = true
    closing ??= starting.then(host => host.close()).then(() => {
      process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); process.removeListener('message', message); process.removeListener('disconnect', stop)
      if (process.connected) process.disconnect()
    }, error => { report(error); if (process.connected) process.disconnect() })
  }
  const message = (input: unknown) => {
    if (input && typeof input === 'object' && 'type' in input && input.type === 'anybox-stop') stop()
  }
  process.once('SIGINT', stop); process.once('SIGTERM', stop); process.on('message', message)
  if (process.connected) process.once('disconnect', stop)
  return { get stopping() { return stopping }, stop }
}

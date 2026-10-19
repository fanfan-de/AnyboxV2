/** Signals on Unix and the inherited parent IPC channel share the actual role close. */
export function installProcessShutdown(close: () => Promise<void>, report: (error: unknown) => void): void {
  let closing = false
  const stop = () => {
    if (closing) return
    closing = true
    process.off('SIGINT', stop); process.off('SIGTERM', stop); process.off('message', receive)
    void Promise.resolve().then(close).catch(error => { process.exitCode = 1; report(error) }).finally(() => {
      if (process.connected) process.disconnect()
    })
  }
  const receive = (message: unknown) => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'anybox-role-stop') stop()
  }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  if (process.connected) process.on('message', receive)
}

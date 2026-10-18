import { pathToFileURL } from 'node:url'

export const computerWorkerUsage = `Usage: anybox computer-worker <command> <directory> [attachment-id]
  serve        Run the independent worker in the foreground
  start        Explicitly start the worker in the background (or reuse it)
  status       Read worker and attachment status; never starts it
  attach       Read { harnessUrl, code, ceiling } JSON from stdin
  permissions  Read a Computer ceiling JSON from stdin; requires attachment-id
  revoke       Revoke attachment-id and wait for its tool cleanup
  stop         Stop the worker and wait for cleanup
The legacy form computer-worker <directory> is equivalent to serve.
Attach, permissions and revoke require a running worker. Credentials are never printed.
`
async function readInput(): Promise<unknown> {
  if (process.stdin.isTTY) throw new Error('Provide JSON on stdin; do not put attach codes in command arguments')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > 65_536) throw new Error('Worker management input is too large')
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('Worker management requires valid JSON on stdin') }
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { process.stdout.write(computerWorkerUsage); return }
  const commands = ['serve', 'start', 'status', 'attach', 'permissions', 'revoke', 'stop']
  const legacy = args.length === 1 && !commands.includes(args[0]!)
  const command = legacy ? 'serve' : args[0], directory = legacy ? args[0] : args[1], id = args[2]
  const count = command === 'permissions' || command === 'revoke' ? 3 : 2
  if (!command || !commands.includes(command) || !directory?.trim() || (!legacy && args.length !== count) || (count === 3 && !id?.trim())) throw new Error(computerWorkerUsage)
  if (command === 'serve') {
    const { openComputerWorker } = await import('../core/computer/worker-server.js')
    const worker = await openComputerWorker(directory, { credentialNamespace: process.env.ANYBOX_COMPUTER_WORKER_NAMESPACE })
    const stop = () => { void worker.close().finally(() => { if (process.connected) process.disconnect() }).catch(() => { process.exitCode = 1 }) }
    process.once('SIGINT', stop); process.once('SIGTERM', stop)
    process.send?.({ type: 'ready', ...worker.endpoint, token: undefined })
    process.stdout.write(JSON.stringify({ state: 'running', workerId: worker.endpoint.workerId, bootId: worker.endpoint.bootId, pid: worker.endpoint.pid }) + '\n')
    return
  }
  const input = command === 'attach' || command === 'permissions' ? await readInput() : undefined
  if (command === 'attach' && (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['harnessUrl', 'code', 'ceiling'].includes(key)))) throw new Error('Expected { harnessUrl, code, ceiling }')
  const { connectLocalComputerWorker } = await import('../core/computer/worker-client.js')
  const worker = connectLocalComputerWorker({ directory, autoStart: false, requestTimeoutMs: 120_000 })
  const abort = () => { void worker.closeObserver() }
  process.once('SIGINT', abort); process.once('SIGTERM', abort)
  try {
    let result: unknown
    switch (command) {
      case 'start': await worker.start(); result = await worker.status(); break
      case 'status': result = await worker.status(); break
      case 'attach': result = await worker.control.consumeAttachCode(input as Parameters<typeof worker.control.consumeAttachCode>[0]); break
      case 'permissions': result = await worker.control.updatePermissions(id!, input); break
      case 'revoke': result = await worker.control.revokeAttachment(id!); break
      case 'stop': await worker.shutdown(); result = await worker.status(); break
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  } finally { await worker.closeObserver(); process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(error => {
  process.exitCode = 1
  process.stderr.write(`computer worker could not start: ${error instanceof Error ? error.message : 'startup failure'}\n`)
})

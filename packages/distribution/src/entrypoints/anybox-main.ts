import { pathToFileURL } from 'node:url'

const usage = `Usage: anybox <role> [arguments]
  client                         Start only the client service
  harness-server [serve]         Start only the harness server
  harness-server init [name]     Initialize server access
  computer-worker <directory>    Start only the Computer worker
  computer-worker <command> ...  serve/start/status/attach/permissions/revoke/stop
Use --help after a role to show this help without starting services.
`

/** Select a role before importing its runtime or any native dependencies. */
export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const [role, ...rest] = args
  if (!role || role === '--help' || role === '-h') { process.stdout.write(usage); return }
  if (!['client', 'harness-server', 'computer-worker'].includes(role)) throw new Error(`Unknown role: ${role}\n${usage}`)
  if (role !== 'computer-worker' && rest.length === 1 && ['--help', '-h'].includes(rest[0]!)) { process.stdout.write(usage); return }
  switch (role) {
    case 'client': return (await import('./client-main.js')).main(rest)
    case 'harness-server': return (await import('./harness-server-main.js')).main(rest)
    case 'computer-worker': return (await import('./computer-worker-main.js')).main(rest)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(error => {
  if (process.connected) process.disconnect()
  process.exitCode = 1
  process.stderr.write(`Anybox could not start: ${error instanceof Error ? error.message : 'startup failure'}\n`)
})

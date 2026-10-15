import { readFile } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { manageService } from '../platform/services-control.js'
import { validateServiceConfiguration } from '../platform/services.js'

export const serviceUsage = `Usage: anybox service install <configuration.json>
       anybox service start|stop|status|uninstall <name>
Install registers only; start is explicit. Uninstall preserves role data and Vault credentials.
Windows installation requires an elevated terminal and the current account's service-logon permission.
Provide {"password":"..."} through stdin on Windows; passwords never enter configuration or argv.
Linux uses systemd --user; macOS uses the current user's launchd domain.
`
/** Private input uses incremental UTF-8 decoding; parser diagnostics never echo credentials. */
export async function readServicePassword(input: AsyncIterable<Uint8Array | string>): Promise<string> {
  const decoder = new StringDecoder('utf8')
  let text = '', bytes = 0
  for await (const chunk of input) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 8192) throw new Error('Service credential input is too large')
    text += decoder.write(buffer)
  }
  text += decoder.end()
  let credentials: unknown
  try { credentials = JSON.parse(text) } catch { throw new Error('Service credentials require valid JSON input') }
  if (!credentials || typeof credentials !== 'object' || !('password' in credentials) ||
      typeof credentials.password !== 'string' || !credentials.password) throw new Error('Service credentials require password')
  return credentials.password
}
export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { process.stdout.write(serviceUsage); return }
  const [action, target] = args
  if (args.length !== 2 || !target || !['install', 'start', 'stop', 'status', 'uninstall'].includes(action!)) throw new Error(serviceUsage)
  let password: string | undefined
  const input = action === 'install' ? validateServiceConfiguration(JSON.parse(await readFile(target, 'utf8'))) : target
  if (action === 'install' && process.platform === 'win32') {
    if (process.stdin.isTTY) throw new Error('Provide service account credentials through JSON stdin')
    password = await readServicePassword(process.stdin)
  }
  const result = await manageService(action as Parameters<typeof manageService>[0], input, password)
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
}

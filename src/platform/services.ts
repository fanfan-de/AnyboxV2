import { isAbsolute, join } from 'node:path'

export type ServiceRole = 'client' | 'harness-server' | 'computer-worker'
export interface ServiceConfiguration {
  readonly formatVersion: 1
  readonly name: string
  readonly role: ServiceRole
  readonly workingDirectory: string
  readonly workerDirectory?: string
  /** Windows services deliberately use the installing user's account and Vault. */
  readonly account?: string
  readonly environment: Readonly<Record<string, string>>
}
const settings = new Set(['ANYBOX_CLIENT_DATABASE', 'ANYBOX_CLIENT_NAMESPACE', 'ANYBOX_WEB_PORT',
  'ANYBOX_HARNESS_DATABASE', 'ANYBOX_HARNESS_BIND', 'ANYBOX_HARNESS_PORT', 'ANYBOX_HARNESS_NAME',
  'ANYBOX_MODELS_CONFIG', 'ANYBOX_MODELS_DATABASE', 'ANYBOX_MODELS_CATALOG_DATABASE', 'ANYBOX_MODELS_NAMESPACE',
  'ANYBOX_IMAGE_ASSETS_DIRECTORY', 'ANYBOX_PROJECTS', 'ANYBOX_COMPUTER_WORKER_DIRECTORY', 'ANYBOX_COMPUTER_WORKER_NAMESPACE',
  'ANYBOX_COMPUTER_UNIT', 'ANYBOX_COMPUTER_ATTACHMENT', 'ANYBOX_POWERSHELL', 'ANYBOX_BASH'])
export function validateServiceConfiguration(value: unknown): ServiceConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid service configuration')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['formatVersion', 'name', 'role', 'workingDirectory', 'workerDirectory', 'account', 'environment'].includes(key)) ||
    input.formatVersion !== 1 || typeof input.name !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(input.name) ||
    !['client', 'harness-server', 'computer-worker'].includes(String(input.role)) || typeof input.workingDirectory !== 'string' || !isAbsolute(input.workingDirectory) ||
    /[\0\r\n]/.test(input.workingDirectory)) throw new TypeError('Invalid service configuration')
  if (input.workerDirectory !== undefined && (typeof input.workerDirectory !== 'string' || !isAbsolute(input.workerDirectory) || /[\0\r\n]/.test(input.workerDirectory))) throw new TypeError('Worker directory must be absolute')
  if (input.role === 'computer-worker' && !input.workerDirectory) throw new TypeError('Computer service requires workerDirectory')
  if (input.account !== undefined && (typeof input.account !== 'string' || !input.account.trim() || /[\0\r\n]/.test(input.account))) throw new TypeError('Invalid service account')
  if (!input.environment || typeof input.environment !== 'object' || Array.isArray(input.environment)) throw new TypeError('Service environment must be an object')
  const environment: Record<string, string> = {}
  for (const [name, item] of Object.entries(input.environment)) {
    if (!settings.has(name) || typeof item !== 'string' || /[\0\r\n]/.test(item)) throw new TypeError(`Unsupported non-secret service setting: ${name}`)
    environment[name] = item
  }
  return { formatVersion: 1, name: input.name, role: input.role as ServiceRole, workingDirectory: input.workingDirectory,
    ...(input.workerDirectory ? { workerDirectory: input.workerDirectory as string } : {}),
    ...(input.account ? { account: input.account as string } : {}), environment }
}
export const serviceLabel = (name: string) => `com.anybox.${name}`
export const windowsServiceName = (name: string) => `Anybox-${name}`
export interface ServiceLaunch { readonly executable: string; readonly runner: string; readonly configuration: string; readonly serviceHost: string }
const systemdQuote = (value: string) => '"' + value.replace(/[%\\"$`]/g, character => character === '%' ? '%%' : '\\' + character) + '"'
const xml = (value: string) => value.replace(/[<>&"']/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]!)
export function renderSystemdService(config: ServiceConfiguration, launch: ServiceLaunch): string {
  return `[Unit]\nDescription=Anybox ${config.role} (${config.name})\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${systemdQuote(config.workingDirectory)}\nExecStart=${[launch.executable, launch.runner, launch.configuration].map(systemdQuote).join(' ')}\nRestart=on-failure\nRestartSec=5\nKillMode=control-group\nTimeoutStopSec=infinity\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`
}
export function renderLaunchdService(config: ServiceConfiguration, launch: ServiceLaunch, logs: string): string {
  const args = [launch.executable, launch.runner, launch.configuration].map(value => `<string>${xml(value)}</string>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${serviceLabel(config.name)}</string><key>ProgramArguments</key><array>${args}</array><key>WorkingDirectory</key><string>${xml(config.workingDirectory)}</string><key>RunAtLoad</key><false/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ExitTimeOut</key><integer>0</integer><key>StandardOutPath</key><string>${xml(join(logs, 'stdout.log'))}</string><key>StandardErrorPath</key><string>${xml(join(logs, 'stderr.log'))}</string></dict></plist>\n`
}
/** Windows CommandLineToArgvW quoting; no command shell evaluates this string. */
export function quoteWindowsArgument(value: string): string {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, '$&$&') + '"'
}
export function windowsServiceCommand(config: ServiceConfiguration, launch: ServiceLaunch): string {
  return [launch.serviceHost, windowsServiceName(config.name), launch.executable, launch.runner, launch.configuration].map(quoteWindowsArgument).join(' ')
}

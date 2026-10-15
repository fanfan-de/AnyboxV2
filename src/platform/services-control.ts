import { spawn } from 'node:child_process'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveBackgroundRuntime } from './runtime-path.js'
import { renderLaunchdService, renderSystemdService, serviceLabel, validateServiceConfiguration, windowsServiceCommand, windowsServiceName } from './services.js'
import type { ServiceConfiguration, ServiceLaunch } from './services.js'

export type ServiceAction = 'install' | 'start' | 'stop' | 'status' | 'uninstall'
export type ServiceCommand = (executable: string, args: readonly string[], input?: string) => Promise<string>
export const executeServiceCommand: ServiceCommand = (executable, args, input) => new Promise((yes, no) => {
  const child = spawn(executable, [...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = '', error = ''
  child.stdout.setEncoding('utf8').on('data', value => { output += value })
  child.stderr.setEncoding('utf8').on('data', value => { error += value })
  child.once('error', no)
  child.once('close', code => code === 0 ? yes(output) : no(new Error(`Service manager failed (${code}): ${error.trim() || output.trim()}`)))
  child.stdin.on('error', () => {})
  child.stdin.end(input)
})
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
const windowsScript = `[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding;
$env:PSModulePath=Join-Path $PSHOME 'Modules';
$ErrorActionPreference='Stop'; $i=[Console]::In.ReadToEnd() | ConvertFrom-Json; switch ($i.action) {
 'identity' { [System.Security.Principal.WindowsIdentity]::GetCurrent().Name; break }
 'install' { $secure=ConvertTo-SecureString $i.password -AsPlainText -Force; $credential=[PSCredential]::new($i.account,$secure); New-Service -Name $i.name -DisplayName $i.name -BinaryPathName $i.command -StartupType Automatic -Credential $credential | Out-Null; break }
 'start' { Start-Service -Name $i.name; break }
 'stop' { $s=Get-Service -Name $i.name; if ($s.Status -ne 'Stopped') { $s.Stop(); $s.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped) }; break }
 'status' { $s=Get-Service -Name $i.name -ErrorAction SilentlyContinue; if ($null -eq $s) { '{"state":"not-installed"}' } else { @{state=$s.Status.ToString().ToLowerInvariant()} | ConvertTo-Json -Compress }; break }
 'uninstall' { $s=Get-Service -Name $i.name -ErrorAction SilentlyContinue; if ($null -ne $s) { if ($s.Status -ne 'Stopped') { $s.Stop(); $s.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped) }; & "$env:SystemRoot\\System32\\sc.exe" delete $i.name; if ($LASTEXITCODE -ne 0) { throw 'DeleteService failed' } }; break }
}`
export interface ServiceManagerOptions {
  readonly platform?: NodeJS.Platform
  readonly home?: string
  readonly uid?: number
  readonly execute?: ServiceCommand
  readonly launch?: Omit<ServiceLaunch, 'configuration'>
}
function paths(name: string, options: ServiceManagerOptions) {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(name)) throw new TypeError('Invalid service name')
  const home = options.home ?? homedir(), platform = options.platform ?? process.platform
  const directory = join(home, '.anybox/services', name)
  return { directory, configuration: join(directory, 'service.json'),
    registration: platform === 'darwin' ? join(home, 'Library/LaunchAgents', serviceLabel(name) + '.plist')
      : join(home, '.config/systemd/user', serviceLabel(name) + '.service') }
}
function defaultLaunch(): Omit<ServiceLaunch, 'configuration'> {
  const runtime = resolveBackgroundRuntime()
  const runner = fileURLToPath(new URL('../entrypoints/service-runner.js', import.meta.url))
  return { executable: runtime.executable, runner, serviceHost: fileURLToPath(new URL('./native/anybox-service-host.exe', import.meta.url)) }
}
/** Installation is explicit. The ordinary app and status queries never register or start services. */
export async function manageService(action: ServiceAction, input: string | ServiceConfiguration, password?: string, options: ServiceManagerOptions = {}): Promise<unknown> {
  const platform = options.platform ?? process.platform, execute = options.execute ?? executeServiceCommand
  if (!['win32', 'darwin', 'linux'].includes(platform)) throw new Error('Unsupported service platform')
  const config = typeof input === 'string' ? undefined : validateServiceConfiguration(input)
  const name = typeof input === 'string' ? input : input.name, locations = paths(name, options)
  const windows = (operation: string, values: Record<string, unknown> = {}) => execute(powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsScript], JSON.stringify({ action: operation, name: windowsServiceName(name), ...values }))
  const domain = `gui/${options.uid ?? process.getuid?.() ?? 0}`, target = `${domain}/${serviceLabel(name)}`
  if (action === 'install') {
    if (!config) throw new TypeError('Install requires a configuration')
    try { await access(locations.configuration); throw new Error('Service is already installed; uninstall it before changing the account or configuration') }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    const launch = { ...(options.launch ?? defaultLaunch()), configuration: locations.configuration }
    await mkdir(locations.directory, { recursive: true, mode: 0o700 })
    if (!options.execute) { await access(launch.executable); await access(launch.runner); await access(config.workingDirectory) }
    if (platform === 'win32') {
      const identity = (await windows('identity')).trim()
      if (!config.account || config.account.toLowerCase() !== identity.toLowerCase()) throw new Error('Windows services must explicitly use the current account; desktop and service Vaults must have the same owner')
      if (!password) throw new Error('Provide the service account password as JSON on stdin; it is not stored')
      if (!options.execute) await access(launch.serviceHost)
      // New-Service receives the password only over its private stdin, never argv, environment or disk.
      await writeFile(locations.configuration, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      try { await windows('install', { account: config.account, password, command: windowsServiceCommand(config, launch) }) }
      catch (error) { await rm(locations.configuration, { force: true }); throw error }
    } else {
      await mkdir(dirname(locations.registration), { recursive: true, mode: 0o700 })
      await writeFile(locations.configuration, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
      await writeFile(locations.registration, platform === 'darwin' ? renderLaunchdService(config, launch, locations.directory) : renderSystemdService(config, launch), { flag: 'wx', mode: 0o600 })
      if (platform === 'linux') {
        await execute('systemctl', ['--user', 'daemon-reload'])
        await execute('systemctl', ['--user', 'enable', serviceLabel(name) + '.service'])
      }
    }
    return { state: 'installed', name, configuration: locations.configuration, started: false }
  }
  if (action === 'status') {
    try { await access(locations.configuration) } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { state: 'not-installed', name }
      throw error
    }
    if (platform === 'win32') return { ...JSON.parse(await windows('status')), name }
    if (platform === 'linux') return { name, status: (await execute('systemctl', ['--user', 'show', serviceLabel(name) + '.service', '--property=ActiveState,SubState,MainPID,Result'])).trim() }
    try { return { name, status: (await execute('launchctl', ['print', target])).trim() } }
    catch { return { name, state: 'stopped' } }
  }
  // Only manage names installed through this account's Anybox service manager.
  const installed = validateServiceConfiguration(JSON.parse(await readFile(locations.configuration, 'utf8')))
  if (installed.name !== name) throw new Error('Service registration identity mismatch')
  if (platform === 'win32') await windows(action)
  else if (platform === 'linux') {
    await execute('systemctl', ['--user', action === 'uninstall' ? 'disable' : action, ...(action === 'uninstall' ? ['--now'] : []), serviceLabel(name) + '.service'])
  } else if (action === 'start') {
    let loaded = false
    try { await execute('launchctl', ['print', target]); loaded = true } catch {}
    if (!loaded) await execute('launchctl', ['bootstrap', domain, locations.registration])
    await execute('launchctl', ['kickstart', target])
  } else {
    let loaded = false
    try { await execute('launchctl', ['print', target]); loaded = true } catch {}
    if (loaded) await execute('launchctl', ['bootout', target])
  }
  if (action === 'uninstall') {
    if (platform !== 'win32') await rm(locations.registration, { force: true })
    await rm(locations.configuration, { force: true })
    if (platform === 'linux') await execute('systemctl', ['--user', 'daemon-reload'])
    return { state: 'uninstalled', name, dataRetained: true }
  }
  return manageService('status', name, undefined, options)
}

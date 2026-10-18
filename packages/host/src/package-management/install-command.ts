import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { Context } from '@nya/core'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite/sqlite'
import { createPackageRegistryComponent } from './component.js'
import { createPackageInstallerComponent, packageInstallerServiceKey, type PackageInstallerPort } from './installer.js'
import { packageRegistryServiceKey, packageRegistryStorageServiceKey, type PackageFileInstall, type PackageRegistryPort } from './port.js'
import { defaultApplicationArchiveLimits } from './archive.js'
import { readApplicationDirectory } from './directory.js'
import { readApplicationTrustPolicy, currentApplicationRuntimeProfile } from './policy.js'

const usage = 'Usage: anybox-host install <application-folder|application.anybox-app> --directory <root> (--trust <policy.json> | --trust-local) --request-id <id> | installations|operations --directory <root> | recover <id> --action inspect|resume|discard --directory <root> [--trust <policy.json>] | cancel <id> --directory <root>'
function invalid(): never { throw Object.assign(new Error(usage), { code: 'invalid-input' }) }
function parse(args: readonly string[]) {
  const command = args[0]
  if (!command || !['install', 'installations', 'operations', 'recover', 'cancel'].includes(command)) invalid()
  const positional = ['install', 'recover', 'cancel'].includes(command)
  const value = positional ? args[1] : undefined, offset = positional ? 2 : 1
  if (positional && (!value || value.startsWith('--'))) invalid()
  const options: Record<string, string> = {}
  for (let index = offset; index < args.length; index++) {
    const name = args[index], item = args[index + 1]
    if (name === '--trust-local' && options[name] === undefined) { options[name] = 'true'; continue }
    if (!name || !['--directory', '--trust', '--request-id', '--action'].includes(name) || options[name] !== undefined || !item || item.startsWith('--')) invalid()
    options[name] = item; index++
  }
  const allowed = command === 'install' ? ['--directory', '--trust', '--trust-local', '--request-id'] : command === 'recover' ? ['--directory', '--trust', '--action'] : ['--directory']
  if (!options['--directory'] || Object.keys(options).some(key => !allowed.includes(key))) invalid()
  if (command === 'install' && ((!options['--trust'] && !options['--trust-local']) || !options['--request-id'])) invalid()
  const action = options['--action']
  if (command === 'recover' && (!action || !['inspect', 'resume', 'discard'].includes(action))) invalid()
  return { command, value, options, directory: resolve(options['--directory']) }
}
function installView(job: PackageFileInstall) {
  return { id: job.id, requestId: job.requestId, filename: job.filename, sourceFormat: job.sourceFormat ?? 'archive', localTrust: job.localTrust ?? false, archiveDigest: job.archiveDigest, archiveSize: job.archiveSize,
    revision: job.revision, phase: job.phase, identity: job.identity, operationId: job.operationId, existingInstallation: job.existingInstallation,
    errorCode: job.errorCode, recovery: job.recovery, createdAt: job.createdAt, updatedAt: job.updatedAt }
}
async function preflight(path: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > defaultApplicationArchiveLimits.archiveBytes) throw Object.assign(new Error('Invalid application package file'), { code: 'archive-size-limit' })
    const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024)
    let size = 0
    for (;;) {
      signal.throwIfAborted()
      const { bytesRead } = await handle.read(buffer)
      if (!bytesRead) break
      size += bytesRead
      if (size > before.size) throw Object.assign(new Error('Application package changed'), { code: 'archive-file-changed' })
      digest.update(buffer.subarray(0, bytesRead))
    }
    signal.throwIfAborted()
    const after = await handle.stat()
    if (size !== before.size || after.size !== before.size || after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw Object.assign(new Error('Application package changed'), { code: 'archive-file-changed' })
    return { archiveDigest: digest.digest('hex'), archiveSize: size }
  } finally { await handle.close() }
}
const codeFor = (error: unknown) => error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(error.code) ? error.code : 'package-command-failed'

/** Offline one-writer lifecycle CLI. It creates no HTTP listener or application business component. */
export async function runPackageManagementCommand(args: readonly string[]): Promise<number> {
  if (args.includes('--endpoint')) {
    const { runOnlinePackageInstallCommand } = await import('./online-install-command.js')
    return runOnlinePackageInstallCommand(args)
  }
  const controller = new AbortController()
  let activeInstallId: string | undefined
  const abort = () => { controller.abort(Object.assign(new Error('Package command cancelled'), { code: 'installation-cancelled' })); if (installer && activeInstallId) void installer.cancel(activeInstallId).catch(() => {}) }
  let root: Context | undefined, installer: PackageInstallerPort | undefined, registry: PackageRegistryPort | undefined
  process.once('SIGINT', abort); process.once('SIGTERM', abort)
  let exitCode = 0
  try {
    const parsed = parse([...args]), policy = parsed.options['--trust'] ? await readApplicationTrustPolicy(parsed.options['--trust'], controller.signal) : undefined
    controller.signal.throwIfAborted()
    root = new Context()
    await root.installComponent(createLocalSqliteComponent(join(parsed.directory, 'registry.sqlite'), { serviceKey: packageRegistryStorageServiceKey }))
    await root.installComponent(createPackageRegistryComponent({ directory: parsed.directory }))
    const profile = currentApplicationRuntimeProfile()
    await root.installComponent(createPackageInstallerComponent({ directory: parsed.directory,
      verification: { target: { os: process.platform, arch: process.arch }, applicationApiVersion: '0.1.0', trustedPublishers: policy?.trustedPublishers ?? [], runtimeProfiles: { client: profile, execution: profile, computerWorker: profile } },
      preparation: { ...(policy?.trustedAliases ? { trustedAliases: policy.trustedAliases } : {}) } }))
    registry = root.get(packageRegistryServiceKey)!; installer = root.get(packageInstallerServiceKey)!
    let output: unknown
    switch (parsed.command) {
      case 'install': {
        const path = resolve(parsed.value!)
        const isDirectory = (await lstat(path)).isDirectory()
        if (parsed.options['--trust-local'] && !isDirectory) invalid()
        const directoryBytes = isDirectory ? await readApplicationDirectory(path, { signal: controller.signal }) : undefined
        const facts = directoryBytes ? { sourceFormat: 'directory' as const, ...(parsed.options['--trust-local'] ? { localTrust: true } : {}), archiveDigest: createHash('sha256').update(directoryBytes).digest('hex'), archiveSize: directoryBytes.length } : await preflight(path, controller.signal)
        const accepted = await installer.accept({ requestId: parsed.options['--request-id']!, filename: basename(path), ...facts })
        activeInstallId = accepted.id
        let job: PackageFileInstall
        if (controller.signal.aborted) job = await installer.cancel(accepted.id)
        else if (directoryBytes) job = await installer.receive(accepted.id, Readable.from([directoryBytes]), { signal: controller.signal })
        else {
          const upload = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
          job = await installer.receive(accepted.id, upload.createReadStream({ autoClose: true }), { signal: controller.signal })
        }
        output = installView(job); exitCode = job.phase === 'installed' ? 0 : controller.signal.aborted ? 130 : 1
        break
      }
      case 'installations': {
        const view = await registry.inspect()
        output = { revision: view.revision, ownerEpoch: view.ownerEpoch, applications: view.applications.map(facts => ({ appId: facts.appId, revision: facts.revision, installed: facts.installed.map(item => ({ identity: item.identity, source: { kind: item.source.kind, publisher: item.source.publisher }, installedAt: item.installedAt, operationId: item.operationId, state: item.state })), selected: facts.selected, pending: facts.pending })), actual: view.actual.map(item => ({ role: item.snapshot.role, entries: item.snapshot.entries })) }
        break
      }
      case 'operations': output = { installations: (await installer.list()).map(installView), operations: (await registry.listOperations()).map(operation => ({ id: operation.id, requestId: operation.requestId, kind: operation.kind, identity: operation.identity, revision: operation.revision, phase: operation.phase, recovery: operation.recovery, createdAt: operation.createdAt, updatedAt: operation.updatedAt })) }; break
      case 'recover': {
        activeInstallId = parsed.value!
        if (parsed.options['--action'] === 'resume' && !policy && !(await installer.get(parsed.value!))?.localTrust) invalid()
        const job = await installer.recover(parsed.value!, { action: parsed.options['--action'] as 'inspect' | 'resume' | 'discard' })
        output = installView(job); exitCode = parsed.options['--action'] === 'inspect' || job.phase === 'installed' || job.phase === 'cancelled' ? 0 : 1
        break
      }
      case 'cancel': { const job = await installer.cancel(parsed.value!); output = installView(job); exitCode = job.phase === 'cancelled' || job.phase === 'installed' ? 0 : 1; break }
    }
    process.stdout.write(JSON.stringify(output) + '\n')
  } catch (error) {
    exitCode = controller.signal.aborted ? 130 : 1
    const code = codeFor(error)
    process.stderr.write(JSON.stringify({ error: { code, ...(code === 'invalid-input' ? { message: usage } : code === 'occupied' ? { message: 'Package directory is owned by another running host. Stop that host or use its management interface.' } : {}) } }) + '\n')
  } finally {
    try {
      installer?.closeAdmission(); await installer?.awaitIdle()
      registry?.closeAdmission(); await registry?.awaitIdle()
      await root?.fiber.dispose()
    } catch (error) { exitCode = 1; process.stderr.write(JSON.stringify({ error: { code: codeFor(error), message: 'Package resource exit remains unconfirmed.' } }) + '\n') }
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort)
  }
  return controller.signal.aborted && exitCode === 0 ? 130 : exitCode
}

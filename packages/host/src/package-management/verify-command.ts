import { lstat } from 'node:fs/promises'
import { verifyApplicationPackage, defaultApplicationArchiveLimits } from './archive.js'
import { readApplicationPackageFile } from './archive-file.js'
import { readApplicationDirectory } from './directory.js'
import { readApplicationTrustPolicy, currentApplicationRuntimeProfile } from './policy.js'
import { prepareApplicationArchive } from './preparation.js'
export { readApplicationPackageFile } from './archive-file.js'
export { currentApplicationRuntimeProfile } from './policy.js'

/** Read-only lifecycle tooling: no registry write, application opening, npm or archive scripts. */
export async function verifyCommand(args: readonly string[]): Promise<void> {
  const usage = 'Usage: anybox-host verify <application-folder|application.anybox-app> [--trust <publishers.json>] [--trust-local]'
  let localTrust = false, policyPath: string | undefined
  if (!args[0] || args[0].startsWith('--')) throw new Error(usage)
  for (let index = 1; index < args.length; index++) {
    if (args[index] === '--trust-local' && !localTrust) localTrust = true
    else if (args[index] === '--trust' && !policyPath && args[index + 1] && !args[index + 1]!.startsWith('--')) policyPath = args[++index]
    else throw new Error(usage)
  }
  if (!localTrust && !policyPath) throw new Error(usage)
  const controller = new AbortController()
  const abort = () => controller.abort(new Error('Application package verification cancelled'))
  process.once('SIGINT', abort); process.once('SIGTERM', abort)
  try {
    const policy = policyPath ? await readApplicationTrustPolicy(policyPath, controller.signal) : undefined
    const profile = currentApplicationRuntimeProfile()
    const sourceFormat = (await lstat(args[0])).isDirectory() ? 'directory' : 'archive'
    if (localTrust && sourceFormat !== 'directory') throw new Error(usage)
    const bytes = sourceFormat === 'directory' ? await readApplicationDirectory(args[0], { signal: controller.signal }) : await readApplicationPackageFile(args[0], defaultApplicationArchiveLimits.archiveBytes, controller.signal)
    const archive = verifyApplicationPackage(bytes, {
      trustedPublishers: policy?.trustedPublishers ?? [], ...(localTrust ? { allowUnsignedLocal: true } : {}), target: { os: process.platform, arch: process.arch }, applicationApiVersion: '0.1.0',
      runtimeProfiles: { client: profile, execution: profile, computerWorker: profile }, signal: controller.signal,
    })
    const prepared = await prepareApplicationArchive(archive, { signal: controller.signal, trustedAliases: policy?.trustedAliases })
    process.stdout.write(JSON.stringify({ identity: archive.identity, sourceFormat, localTrust, archiveDigest: archive.archiveDigest,
      archiveSize: archive.archiveSize, fileCount: archive.files.length, preparation: prepared }) + '\n')
  } finally {
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort)
  }
}

import { rcompare, satisfies } from 'semver'
import type { ApplicationCapabilityProvider, ApplicationRegistration } from '@anybox/application-api/nya'
import type { ApplicationArchiveManifest, VerifyApplicationArchiveOptions } from './archive.js'
import { assertInstalledApplicationLifecycle, verifyInstalledApplicationContainer } from './loader-files.js'
import type { PackageActivationIntent } from './activation.js'
import type { PackageActivationRolePlan, PackageCapabilitySelection, PackageCatalogSnapshot, PackageIdentity, PackageRegistryView } from './port.js'
import { identityKey } from './domain.js'

export interface InstalledRolePlanOptions {
  readonly directory: string
  readonly verification: Omit<VerifyApplicationArchiveOptions, 'signal'>
  readonly roles: readonly PackageCatalogSnapshot['role'][]
  readonly providers?: readonly Pick<ApplicationCapabilityProvider, 'id' | 'version' | 'supported'>[]
  readonly bundled?: readonly ApplicationRegistration[]
  readonly desired?: (role: PackageCatalogSnapshot['role'], appId: string) => boolean
}
/** Selects exact immutable identities; it never imports a registration or initializes a provider. */
export async function planInstalledRoles(view: PackageRegistryView, options: InstalledRolePlanOptions, intent?: PackageActivationIntent): Promise<readonly PackageActivationRolePlan[]> {
  const selectedIds = intent?.appIds ? new Set(intent.appIds) : undefined
  const candidates: { identity: PackageIdentity; manifest: ApplicationArchiveManifest; fresh: boolean }[] = []
  for (const facts of view.applications) {
    if (intent?.kind === 'remove' && selectedIds?.has(facts.appId)) continue
    const target = intent && (!selectedIds || selectedIds.has(facts.appId)) ? facts.pending ?? facts.selected : facts.selected
    if (!target) continue
    const installed = facts.installed.find(item => identityKey(item.identity) === identityKey(target))
    if (installed?.state !== 'installed') throw Object.assign(new Error('Installed application is quarantined'), { code: 'package-loader-quarantined' })
    const { archive } = await verifyInstalledApplicationContainer(options.directory, target, options.verification)
    assertInstalledApplicationLifecycle(archive)
    candidates.push({ identity: target, manifest: archive.manifest, fresh: facts.selected === null })
  }
  const offers = [{ id: 'storage.sqlite', version: '1.0.0', supported: true }, ...(options.providers ?? [])]
  return options.roles.map(role => {
    const included = candidates.filter(item => role === 'client' ? !!item.manifest.entries?.client || !!item.manifest.web : role === 'execution' ? !!item.manifest.entries?.execution : role === 'computer-worker' ? !!item.manifest.entries?.computerWorker : !!item.manifest.web)
    const entries = included.map(item => {
      const entry = role === 'client' && !item.manifest.entries?.client ? 'web' as const : role
      return { package: item.identity, entry, ...(entry === 'web' ? {} : { desiredEnabled: item.fresh ? false : options.desired?.(role, item.identity.appId) ?? false }) }
    })
    const groups = included.map(item => item.manifest.capabilityRequirements?.[role === 'computer-worker' ? 'computerWorker' : role === 'client' && !item.manifest.entries?.client ? 'web' : role])
    const ids = new Set(groups.flatMap(group => [...Object.keys(group?.required ?? {}), ...Object.keys(group?.optional ?? {})]))
    if (role === 'client' || role === 'execution') ids.add('storage.sqlite')
    const capabilities: PackageCapabilitySelection[] = []
    for (const id of [...ids].sort()) {
      const ranges = groups.flatMap(group => group?.required?.[id] ? [group.required[id]] : group?.optional?.[id] ? [group.optional[id]] : [])
      const provider = offers.filter(offer => offer.id === id && offer.supported !== false && ranges.every(range => satisfies(offer.version, range))).sort((a, b) => rcompare(a.version, b.version))[0]
      if (provider) capabilities.push({ id, version: provider.version, package: null })
    }
    return { role, entries, capabilities }
  }).filter(plan => plan.role === 'client' || plan.entries.length > 0)
}

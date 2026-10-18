import type { IncomingMessage, ServerResponse } from 'node:http'
import { failure, json, requestObject } from '@anybox/application-api/node'
import type { PackageInstallerPort } from './installer.js'
import type { PackagePageLifecycle } from './page-lifecycle.js'
import type { PackageActivationPort, PackageActivationIntent } from './activation.js'
import type { PackageActivation, PackageActualCatalog, ApplicationInstallationFacts, PackageFileInstall, PackageFileInstallIntent, PackageIdentity, PackageRegistryPort } from './port.js'
import { fileInstallIntent } from './file-install-domain.js'
import { identifier } from './domain.js'

export interface PackageManagementAccess {
  readonly registry?: PackageRegistryPort
  readonly installer?: PackageInstallerPort
  readonly activation?: PackageActivationPort
  readonly pages?: PackagePageLifecycle
  readonly trustedPublisherCount: number
}
const base = '/api/client/v1/app-packages'
const maximumArchiveBytes = 256 * 1024 * 1024
const identityView = (identity: PackageIdentity) => ({ appId: identity.appId, version: identity.version, digest: identity.digest, target: { os: identity.target.os, arch: identity.target.arch } })
/** Explicit browser projection: internal receipts, work anchors and local paths never cross HTTP. */
export function packageFileInstallView(job: PackageFileInstall) {
  const code = typeof job.errorCode === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(job.errorCode) ? job.errorCode : null
  return { id: job.id, requestId: job.requestId, filename: job.filename, sourceFormat: job.sourceFormat ?? 'archive', localTrust: job.localTrust ?? false, archiveDigest: job.archiveDigest, archiveSize: job.archiveSize,
    revision: job.revision, phase: job.phase, operationId: job.operationId, existingInstallation: job.existingInstallation, identity: job.identity ? identityView(job.identity) : null,
    error: code ? { code } : null, recovery: job.recovery ? { from: job.recovery.from, reason: job.recovery.reason } : null,
    createdAt: job.createdAt, updatedAt: job.updatedAt }
}
export function packageInstallationView(facts: ApplicationInstallationFacts) {
  return { appId: facts.appId, revision: facts.revision,
    installed: facts.installed.map(item => ({ identity: identityView(item.identity), state: item.state, installedAt: item.installedAt, source: { publisher: item.source.publisher } })),
    selected: facts.selected ? identityView(facts.selected) : null, pending: facts.pending ? identityView(facts.pending) : null }
}
/** Activation progress projects lifecycle facts without internal receipts or launch credentials. */
export function packageActivationView(value: PackageActivation, protectedForCommit = false) {
  const code = typeof value.errorCode === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value.errorCode) ? value.errorCode : null
  return { id: value.id, requestId: value.requestId, revision: value.revision, registryRevision: value.registryRevision, kind: value.kind, phase: value.phase, protected: protectedForCommit,
    targets: value.targets.map(target => ({ identity: identityView(target.identity), previousSelected: target.previousSelected ? identityView(target.previousSelected) : null })),
    roles: value.roles.map(role => ({ role: role.role, ready: role.readyUsageId !== null })), error: code ? { code } : null,
    recovery: value.recovery ? { from: value.recovery.from, reason: value.recovery.reason } : null, createdAt: value.createdAt, updatedAt: value.updatedAt }
}
function actualCatalogView(value: PackageActualCatalog) {
  return { role: value.snapshot.role, generation: value.usage.generation, state: value.usage.state, revision: value.snapshot.revision,
    entries: value.snapshot.entries.map(entry => ({ identity: identityView(entry.package), entry: entry.entry })) }
}
function activationIntent(body: Record<string, unknown>): PackageActivationIntent {
  const requestId = identifier(body.requestId)
  if (!Number.isSafeInteger(body.expectedRegistryRevision) || (body.expectedRegistryRevision as number) < 0) throw failure(400, 'invalid-input')
  const kind = body.kind
  if (kind !== undefined && kind !== 'activate' && kind !== 'remove') throw failure(400, 'invalid-input')
  const appIds = body.appIds
  if (kind === 'remove' && appIds === undefined) throw failure(400, 'invalid-input')
  if (appIds !== undefined && (!Array.isArray(appIds) || !appIds.length || appIds.length > 256 || new Set(appIds).size !== appIds.length)) throw failure(400, 'invalid-input')
  return { requestId, expectedRegistryRevision: body.expectedRegistryRevision as number, ...(kind === undefined ? {} : { kind }), ...(Array.isArray(appIds) ? { appIds: appIds.map(identifier) } : {}) }
}
function apiError(error: unknown): never {
  if (error instanceof URIError) throw failure(400, 'invalid-input')
  if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') throw error
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined
  if (code === 'invalid-input') throw failure(400, code)
  if (code === 'not-found') throw failure(404, code)
  if (code === 'archive-size-limit') throw failure(413, code)
  if (code === 'service-closing' || code === 'registry-corrupt') throw failure(503, code)
  if (code && ['product-busy', 'request-conflict', 'revision-conflict', 'operation-conflict', 'identity-conflict', 'transition-invalid', 'version-in-use', 'use-unavailable', 'reclamation-root-changed', 'reclamation-root-unavailable'].includes(code)) throw failure(409, code)
  if (code && /^(?:activation|installation|archive|package)-[a-z0-9-]{1,51}$/.test(code)) throw failure(409, code)
  throw failure(500, 'internal-error')
}
function intent(body: Record<string, unknown>): PackageFileInstallIntent {
  const value = { requestId: body.requestId, filename: body.filename, archiveDigest: body.archiveDigest, archiveSize: body.archiveSize,
    ...(body.sourceFormat === undefined ? {} : { sourceFormat: body.sourceFormat }),
    ...(body.localTrust === undefined ? {} : { localTrust: body.localTrust }),
    ...(body.expectedAppRevision === undefined ? {} : { expectedAppRevision: body.expectedAppRevision }) } as PackageFileInstallIntent
  fileInstallIntent(value)
  if ((value.sourceFormat ?? 'archive') === 'archive' && !/\.anybox-app$/i.test(value.filename)) throw failure(400, 'invalid-input')
  if (value.archiveSize > maximumArchiveBytes) throw failure(413, 'archive-size-limit')
  return value
}

/** The caller applies client transport/Host/Origin checks before entering this lifecycle-only API. */
export async function handlePackageManagementApi(access: PackageManagementAccess | undefined, request: IncomingMessage, response: ServerResponse, url: URL, options: { signal?: AbortSignal } = {}): Promise<void> {
  try {
    const method = request.method ?? 'GET', path = url.pathname
    if (access?.pages && await access.pages.handle(request, response, url, { signal: options.signal })) return
    if (method === 'GET' && path === base) {
      if ([...url.searchParams.keys()].some(key => key !== 'requestId') || url.searchParams.getAll('requestId').length > 1) throw failure(400, 'invalid-input')
      const requestId = url.searchParams.has('requestId') ? identifier(url.searchParams.get('requestId')) : undefined
      const registry = access?.registry, installer = access?.installer
      const [view, jobs, activations] = await Promise.all([registry?.inspect(), installer ? installer.list() : registry ? registry.listFileInstalls() : Promise.resolve([]), access?.activation?.list() ?? Promise.resolve([])])
      json(response, 200, { available: !!registry && !!installer, trustedPublisherCount: access?.trustedPublisherCount ?? 0,
        registryRevision: view?.revision ?? 0, browserLifecycleAvailable: !!access?.pages, lifecycleAvailable: access?.activation?.available ?? false,
        actual: (view?.actual ?? []).filter(value => value && typeof value === 'object' && value.snapshot && typeof value.snapshot === 'object' && value.usage).map(actualCatalogView),
        installations: (view?.applications ?? []).map(packageInstallationView), operations: jobs.filter(item => requestId === undefined || item.requestId === requestId).map(packageFileInstallView),
        activations: activations.filter(item => requestId === undefined || item.requestId === requestId).map(value => packageActivationView(value, access?.activation?.isPrepared?.(value.id) ?? false)) }); return
    }
    if (url.search) throw failure(400, 'invalid-input')
    const activation = access?.activation
    if (method === 'POST' && path === `${base}/activations`) {
      const input = activationIntent(await requestObject(request, ['requestId', 'expectedRegistryRevision', 'appIds', 'kind']))
      if (!activation?.available) throw failure(503, 'package-lifecycle-manager-unavailable')
      const value = await activation.prepare(input); json(response, 202, packageActivationView(value, activation.isPrepared?.(value.id) ?? false)); return
    }
    const activationMatch = new RegExp(`^${base}/activations/([^/]+)(?:/(commit|cancel|resume))?$`).exec(path)
    if (activationMatch) {
      const id = identifier(decodeURIComponent(activationMatch[1])), action = activationMatch[2]
      if (!activation) throw failure(503, 'package-lifecycle-manager-unavailable')
      if (method === 'GET' && !action) { const value = await activation.get(id); if (!value) throw failure(404, 'not-found'); json(response, 200, packageActivationView(value, activation.isPrepared?.(value.id) ?? false)); return }
      if (method === 'POST' && (action === 'commit' || action === 'cancel' || action === 'resume')) {
        await requestObject(request, [])
        if (!activation.available) throw failure(503, 'package-lifecycle-manager-unavailable')
        const value = await activation[action](id); json(response, 202, packageActivationView(value, activation.isPrepared?.(value.id) ?? false)); return
      }
      throw failure(404, 'not-found')
    }
    const installer = access?.installer
    if (method === 'POST' && path === `${base}/operations`) {
      const input = intent(await requestObject(request, ['requestId', 'filename', 'sourceFormat', 'localTrust', 'archiveDigest', 'archiveSize', 'expectedAppRevision']))
      if (!installer) throw failure(503, 'package-installation-unavailable')
      json(response, 202, packageFileInstallView(await installer.accept(input))); return
    }
    const match = new RegExp(`^${base}/operations/([^/]+)(?:/(archive|cancel|recover))?$`).exec(path)
    if (!match) throw failure(404, 'not-found')
    const id = identifier(decodeURIComponent(match[1])), action = match[2]
    if (!installer) throw failure(503, 'package-installation-unavailable')
    if (method === 'GET' && !action) {
      const job = await installer.get(id); if (!job) throw failure(404, 'not-found')
      json(response, 200, packageFileInstallView(job)); return
    }
    if (method === 'PUT' && action === 'archive') {
      if (request.headers['content-type']?.trim().toLowerCase() !== 'application/octet-stream' || request.headers['content-encoding'] !== undefined && request.headers['content-encoding'] !== 'identity') throw failure(415, 'archive-bytes-required')
      const length = request.headers['content-length']
      if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximumArchiveBytes)) throw failure(413, 'archive-size-limit')
      const job = await installer.get(id); if (!job) throw failure(404, 'not-found')
      if (length !== undefined && Number(length) !== job.archiveSize) throw failure(400, 'archive-size-mismatch')
      // IncomingMessage is the producer. A completed body stays accepted even if
      // the response observer disconnects; the installer owns cancellation/exit.
      json(response, 202, packageFileInstallView(await installer.receive(id, request, { signal: options.signal }))); return
    }
    if (method === 'POST' && action === 'cancel') {
      await requestObject(request, [])
      json(response, 200, packageFileInstallView(await installer.cancel(id))); return
    }
    if (method === 'POST' && action === 'recover') {
      const body = await requestObject(request, ['action'])
      if (!['inspect', 'resume', 'discard'].includes(body.action as string)) throw failure(400, 'invalid-input')
      json(response, 200, packageFileInstallView(await installer.recover(id, { action: body.action as 'inspect' | 'resume' | 'discard' }))); return
    }
    throw failure(404, 'not-found')
  } catch (error) { apiError(error) }
}

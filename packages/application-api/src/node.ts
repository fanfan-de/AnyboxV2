import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApplicationRuntime, ApplicationRuntimeContext, ProductDefinition, InstanceInfo, ApplicationCapabilityRequirements } from './index.js'
export type { InstanceInfo } from './index.js'

/** Private, application-defined JSON messages between the same installed package's roles. */
export interface ApplicationPackageChannel {
  /** Cancellation joins the receiver's actual exit. Payloads and results must be finite JSON values. */
  request(payload: unknown, signal: AbortSignal): Promise<unknown>
}
export interface ApplicationPackageChannelContext {
  readonly signal: AbortSignal
  readonly sourceRole: 'client'
  readonly appId: string
}

/** Optional package lifecycle construction context; application business stays application-owned. */
export interface ApplicationPackageRuntimeContext {
  readonly phase: 'prepare' | 'runtime'
  readonly role: 'client' | 'execution' | 'computerWorker'
  readonly appId: string
  /** Runtime client only; the host fixes the peer application and immutable package identity. */
  readonly channel?: ApplicationPackageChannel
  /** Launches only this signed package's declared independent role. */
  readonly startRole?: (role: 'computer-worker', input: { readonly args: readonly string[]; readonly ownership: 'independent' }) => Promise<void>
}

export interface ApplicationAsset { readonly path: string; readonly file: string; readonly type: string }
/** `owner` requests carry a device token; `unit` requests reached a self-authenticated prefix and must authenticate inside the application. */
export interface ApplicationHttpContext { readonly signal: AbortSignal; readonly actorId: string; readonly appId: string; readonly principal: 'owner' | 'unit'; retainUntil(done: Promise<unknown>): void }
/** handle resolves after owned requests/streams exit, not merely after writing response headers. */
export interface ApplicationHttpPort {
  capabilities?(): readonly string[]
  handle(request: IncomingMessage, response: ServerResponse, url: URL, context: ApplicationHttpContext): Promise<void>
}
export interface ApplicationRegistration<Root = unknown> {
  readonly definition: ProductDefinition
  readonly capabilityRequirements?: ApplicationCapabilityRequirements
  readonly createRuntime?: (root: Root, context: ApplicationRuntimeContext) => ApplicationRuntime
  /** Pure declaration. The execution role invokes it without implicitly opening application business. */
  readonly channel?: {
    handle(root: Root, payload: unknown, context: ApplicationPackageChannelContext): unknown | Promise<unknown>
  }
  readonly http?: {
    readonly service: string
    readonly capabilities?: readonly string[]
    readonly legacyRoutes?: readonly { readonly prefix: string; readonly stripPrefix: string }[]
    /** Application-relative prefixes the host dispatches without device-token authentication; the application authenticates them itself. */
    readonly selfAuthenticated?: readonly string[]
  }
  readonly assets?: readonly ApplicationAsset[]
}

export const hostAccessServiceKey = 'host.access'
export interface AccessToken { readonly id: string; readonly name: string; readonly createdAt: string; readonly revokedAt: string | null }
export interface HostAccessPort {
  readonly instance: InstanceInfo
  authenticate(authorization: string | undefined): string
  list(): Promise<readonly AccessToken[]>
  issue(name: string): Promise<{ readonly token: string; readonly record: AccessToken }>
  /** Trusted bootstrap only; the public token issuer cannot assign managed ownership. */
  issueManaged(owner: string, name: string): Promise<{ readonly token: string; readonly record: AccessToken }>
  /** Retain one valid token of this owner, or revoke all when no token is retained. */
  reconcileManaged(owner: string, retainedToken: string | undefined): Promise<void>
  revoke(id: string): Promise<void>
  resetIdentity(): Promise<InstanceInfo>
  /** Revocation is committed first; its result then joins every observer's resource cleanup. */
  onRevoked(listener: (id: string) => void | Promise<void>): () => void
}

export interface HttpFailure extends Error { readonly status: number; readonly code: string }
export function failure(status: number, code: string): HttpFailure {
  return Object.assign(new Error(code), { status, code })
}
export function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}
export async function requestObject(request: IncomingMessage, fields: readonly string[], maxBytes = 65_536): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw failure(415, 'json-required')
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += value.length
    if (bytes > maxBytes) throw failure(413, 'request-too-large')
    chunks.push(value)
  }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw failure(400, 'invalid-json') }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !fields.includes(key))) throw failure(400, 'invalid-input')
  return value as Record<string, unknown>
}

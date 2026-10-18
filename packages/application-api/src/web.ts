export type ApplicationActivation = 'open' | 'select' | 'restore' | 'navigate'
export interface ApplicationRoute {
  read(): string
  navigate(path: string, replace?: boolean): void
  subscribe(listener: () => void): () => void
}
export interface ApplicationWebContext {
  readonly appId: string
  /** Supplied only when this application declares an HTTP entry. */
  readonly apiBase?: string
  readonly route: ApplicationRoute
  readonly signal: AbortSignal
  domId(local: string): string
}
export interface MountedApplication {
  setActive(active: boolean, reason: ApplicationActivation): void | Promise<void>
  canClose(): boolean
  dispose(): Promise<void>
}
export interface ApplicationWebModule {
  mount(container: HTMLElement, context: ApplicationWebContext): Promise<MountedApplication>
  resolveLegacyRoute?(hash: string): string | undefined
  restoreLegacyRoute?(storage: Pick<Storage, 'getItem'>): string | undefined
}

export interface ApplicationHttpWebContext extends ApplicationWebContext { readonly apiBase: string }
/** HTTP applications validate their declared adapter once at the mount boundary. */
export function requireApplicationHttp(context: ApplicationWebContext): ApplicationHttpWebContext {
  if (!context.apiBase) throw new TypeError('application HTTP entry required')
  return context as ApplicationHttpWebContext
}

export async function requestJSON<T>(url: string, body?: object, signal?: AbortSignal, headers?: Readonly<Record<string, string>>): Promise<T> {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal, cache: 'no-store' })
  const data = await response.json()
  if (!response.ok) throw Object.assign(new Error(data?.error?.code ?? 'request-failed'), { status: response.status, code: data?.error?.code ?? 'request-failed', ...(data?.error?.fileIndex === undefined ? {} : { fileIndex: data.error.fileIndex }) })
  return data as T
}

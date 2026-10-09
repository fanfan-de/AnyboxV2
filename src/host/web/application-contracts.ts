export type ApplicationActivation = 'open' | 'select' | 'restore' | 'navigate'
export interface ApplicationRoute {
  read(): string
  navigate(path: string, replace?: boolean): void
  subscribe(listener: () => void): () => void
}
export interface ApplicationWebContext {
  readonly appId: string
  readonly apiBase: string
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

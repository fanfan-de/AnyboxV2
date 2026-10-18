export interface DesktopWorkerStart {
  readonly kind: 'client' | 'execution'
  readonly userData: string
  readonly namespace: string
  readonly transportSecret?: string
}
export interface DesktopWorkerReady { readonly url: string; readonly instanceId?: string }

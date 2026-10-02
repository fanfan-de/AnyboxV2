/** Safe application metadata. Node modules and resource handles stay in the trusted registry. */
export interface ProductDefinition {
  readonly id: string
  readonly name: string
  readonly icon: string
  readonly description?: string
  readonly web?: { readonly entry: string; readonly styles?: readonly string[]; readonly legacyRoutes?: readonly string[] }
}
export interface ProductError { readonly phase: 'startup' | 'cleanup' | 'storage'; readonly code: string }
export interface ProductView {
  readonly definition: ProductDefinition
  readonly desiredEnabled: boolean
  readonly state: 'disabled' | 'applying' | 'running' | 'blocked' | 'failed'
  readonly error?: ProductError
}
export interface ApplicationRuntime {
  open(): Promise<void>
  stop(): Promise<void>
  retry(): Promise<void>
  inspect(): 'disabled' | 'active' | 'blocked' | 'failed'
  closeAdmission(): void
  awaitIdle(): Promise<void>
}
export const productsServiceKey = 'app.products'
export interface ProductsPort {
  list(): readonly ProductView[]
  get(id: string): ProductView | undefined
  open(id: string): Promise<ProductView>
  disable(id: string): Promise<ProductView>
  retry(id: string): Promise<ProductView>
  authorize(id: string): void
  restore(): Promise<void>
  /** Stops control admission and joins accepted controls. */
  stop(): Promise<void>
}
export const productActivityServiceKey = 'app.activity'
export interface ActivityLease { release(): void }
export interface ActivityFreeze { drain(): Promise<void>; release(): void }
export interface ProductActivityPort {
  enter(productId: string, options?: { blocking?: boolean; cancel?: () => void }): ActivityLease
  freeze(productIds: readonly string[]): ActivityFreeze
  registerGuard(productId: string, acquire: () => (() => void) | undefined): () => void
  stop(): void
  wait(): Promise<void>
}

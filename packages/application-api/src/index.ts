/** Safe application metadata. Node modules and resource handles stay in the trusted registry. */
export interface ProductDefinition {
  readonly id: string
  readonly name: string
  readonly icon: string
  readonly description?: string
  /** Present in host catalog metadata; false means there is no managed background entry. */
  readonly runtime?: boolean
  /** Present in host catalog metadata; only HTTP applications receive a web API address. */
  readonly http?: boolean
  readonly web?: { readonly entry: string; readonly styles?: readonly string[]; readonly legacyRoutes?: readonly string[] }
}
export interface ProductError { readonly phase: 'startup' | 'cleanup' | 'storage'; readonly code: string }
export interface ProductView {
  readonly definition: ProductDefinition
  readonly desiredEnabled: boolean
  readonly state: 'disabled' | 'applying' | 'running' | 'blocked' | 'failed'
  readonly error?: ProductError
  readonly capabilities?: readonly ApplicationCapabilityStatus[]
}
export interface ApplicationRuntime {
  open(): Promise<void>
  stop(): Promise<void>
  retry(): Promise<void>
  inspect(): 'disabled' | 'active' | 'blocked' | 'failed'
  closeAdmission(): void
  awaitIdle(): Promise<void>
  /** Safe capability diagnostics for this runtime generation; never contains live service handles. */
  capabilities?(): readonly ApplicationCapabilityStatus[]
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
  /** Reversible host lifecycle coordination; never cancels application business work. */
  freezeControls?(): ActivityFreeze
  /** Host directory removal only, under a drained control freeze. Actual runtime exit is coordinated separately. */
  setClosedTargets?(ids: readonly string[]): Promise<void>
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

/** Stable host identity published by the optional HTTP adapter. */
export interface InstanceInfo { readonly instanceId: string; readonly name: string; readonly apiVersion: 1; readonly capabilities: readonly string[] }

/** Static requirements of one declared application entry, not a service locator or permission grant. */
export interface ApplicationCapabilityRequirements {
  readonly required?: Readonly<Record<string, string>>
  readonly optional?: Readonly<Record<string, string>>
}

/** Compatibility and availability of one capability for this application entry. */
export interface ApplicationCapabilityStatus {
  readonly id: string
  readonly range: string
  readonly required: boolean
  readonly status: 'ready' | 'missing' | 'unsupported' | 'incompatible' | 'conflict' | 'failed'
  readonly version?: string
}

/** Immutable selection metadata, not a service locator or permission grant. */
export interface ApplicationRuntimeContext {
  readonly capabilities: Readonly<Record<string, string>>
}

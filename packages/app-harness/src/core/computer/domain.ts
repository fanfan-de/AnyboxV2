export interface ComputerSpecification {
  readonly providerId: string
  readonly platform: string
  readonly architecture: string
}

export interface ComputerResource {
  readonly computerId: string
  readonly spec: ComputerSpecification
  readonly activationRevision: number
  readonly createdAt: string
}

export interface ComputerInstanceRef {
  readonly computerInstanceId: string
  readonly instanceGeneration: number
}

export interface ComputerInstance extends ComputerInstanceRef {
  readonly computerId: string
  readonly providerId: string
  readonly providerRef: string
  readonly platform: string
  readonly architecture: string
  readonly activatedAt: string
  readonly status: 'ready' | 'retired'
}

export interface ComputerPin extends ComputerInstanceRef {
  readonly pinId: string
  readonly ownerId: string
  readonly createdAt: string
  readonly releasedAt: string | null
}

export type ComputerErrorCode = 'computer-invalid' | 'computer-conflict' | 'computer-missing' |
  'computer-unavailable' | 'computer-cancelled' | 'computer-generation-mismatch' | 'computer-pinned' | 'computer-cleanup-failed'

export function computerError(code: ComputerErrorCode): Error & { readonly code: ComputerErrorCode } {
  return Object.assign(new Error(code), { name: 'ComputerError', code })
}

export function computerIdentity(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || value.includes('\0')) throw computerError('computer-invalid')
  return value
}

export function computerSpecification(input: ComputerSpecification): ComputerSpecification {
  if (!input || typeof input !== 'object') throw computerError('computer-invalid')
  return Object.freeze({ providerId: computerIdentity(input.providerId), platform: computerIdentity(input.platform),
    architecture: computerIdentity(input.architecture) })
}

export function computerInstanceRef(input: ComputerInstanceRef): ComputerInstanceRef {
  if (!input || !Number.isSafeInteger(input.instanceGeneration) || input.instanceGeneration < 1) throw computerError('computer-invalid')
  return Object.freeze({ computerInstanceId: computerIdentity(input.computerInstanceId), instanceGeneration: input.instanceGeneration })
}


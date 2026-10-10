import type { OwnedCall } from '../contracts.js'
import type { StorageTransaction } from '../../../../storage/port.js'
import type { ComputerInstance, ComputerInstanceRef, ComputerPin, ComputerResource, ComputerSpecification } from './domain.js'
export type { ComputerInstance, ComputerInstanceRef, ComputerPin, ComputerResource, ComputerSpecification } from './domain.js'

export const computerServiceKey = 'harness.computers'
export const computerInstanceProviderServiceKey = 'computer.instance-provider'
export const localComputerProviderId = 'local'

export interface ComputerActivationInput {
  readonly resource: ComputerResource
  readonly activationId: string
  readonly previousInstance?: ComputerInstance
}

/** Provider handles and SDK-specific failures never enter the durable resource domain. */
export interface ComputerInstanceProvider {
  readonly providerId: string
  activate(input: ComputerActivationInput): OwnedCall<{
    readonly providerRef: string
    readonly platform: string
    readonly architecture: string
  }>
}

export interface ComputersPort {
  /** Logical registration is synchronous and does not activate a machine. */
  reserveIn(tx: StorageTransaction, input: { readonly computerId: string; readonly spec: ComputerSpecification }): ComputerResource
  get(computerId: string): Promise<ComputerResource | undefined>
  list(): Promise<readonly ComputerResource[]>
  /** Concurrent callers share activation; cancelling one observation does not cancel the provider. */
  activate(computerId: string): OwnedCall<ComputerInstance>
  requireInstance(ref: ComputerInstanceRef): Promise<ComputerInstance>
  /** Both pin and operation/workspace binding must participate in the same storage transaction. */
  pinIn(tx: StorageTransaction, input: ComputerInstanceRef & { readonly pinId: string; readonly ownerId: string }): ComputerPin
  releasePinIn(tx: StorageTransaction, pinId: string, ownerId: string): void
  getPin(pinId: string): Promise<ComputerPin | undefined>
}

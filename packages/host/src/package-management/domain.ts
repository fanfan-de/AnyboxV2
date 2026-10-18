import { createHash } from 'node:crypto'
import { valid } from 'semver'
import { packageRegistryFailure } from './port.js'
import type { PackageIdentity, PackageOperationPhase, PackageReceiptValue } from './port.js'

export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) throw packageRegistryFailure('invalid-input')
  return value
}
export function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw packageRegistryFailure('invalid-input')
  return value
}
export function identity(value: unknown): PackageIdentity {
  if (!value || typeof value !== 'object') throw packageRegistryFailure('invalid-input')
  const input = value as PackageIdentity
  const appId = identifier(input.appId)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(appId) || typeof input.version !== 'string' || valid(input.version) !== input.version ||
      typeof input.digest !== 'string' || !/^[a-f0-9]{64}$/.test(input.digest) || !input.target ||
      typeof input.target.os !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(input.target.os) ||
      typeof input.target.arch !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(input.target.arch)) throw packageRegistryFailure('invalid-input')
  return Object.freeze({ appId, version: input.version, digest: input.digest, target: Object.freeze({ os: input.target.os, arch: input.target.arch }) })
}
/** Stable identity; input property insertion order cannot alter idempotency or ownership. */
export function identityKey(value: PackageIdentity): string {
  const item = identity(value)
  return JSON.stringify([item.appId, item.version, item.digest, item.target.os, item.target.arch])
}
export function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
/** Capture a plain command without evaluating accessors; optional fields may be undefined. */
export function captureCommand<Input>(value: Input): Input {
  const seen = new Set<object>()
  let size = 0
  const check = (input: unknown, depth: number): void => {
    if (depth > 24 || ++size > 100_000) throw packageRegistryFailure('invalid-input')
    if (input === null || input === undefined || typeof input === 'boolean') return
    if (typeof input === 'string' && input.length <= 1_048_576) return
    if (typeof input === 'number' && Number.isFinite(input)) return
    if (!input || typeof input !== 'object' || seen.has(input) || !Array.isArray(input) && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) throw packageRegistryFailure('invalid-input')
    seen.add(input)
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
      if (!('value' in descriptor) || key === '__proto__' || key === 'constructor' || key === 'prototype') throw packageRegistryFailure('invalid-input')
      check(descriptor.value, depth + 1)
    }
    seen.delete(input)
  }
  check(value, 0)
  return structuredClone(value)
}
export function receipt(value: unknown): PackageReceiptValue {
  const seen = new Set<object>()
  const copy = (input: unknown, depth: number): PackageReceiptValue => {
    if (depth > 24) throw packageRegistryFailure('invalid-input')
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input
    if (typeof input === 'number' && Number.isFinite(input)) return input
    if (!input || typeof input !== 'object' || seen.has(input)) throw packageRegistryFailure('invalid-input')
    seen.add(input)
    let result: PackageReceiptValue
    if (Array.isArray(input)) result = Object.freeze(input.map(item => copy(item, depth + 1)))
    else {
      if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) throw packageRegistryFailure('invalid-input')
      const fields: Record<string, PackageReceiptValue> = Object.create(null)
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        if (!('value' in descriptor) || key === '__proto__' || key === 'constructor' || key === 'prototype') throw packageRegistryFailure('invalid-input')
        fields[key] = copy(descriptor.value, depth + 1)
      }
      result = Object.freeze(fields)
    }
    seen.delete(input)
    return result
  }
  const result = copy(value, 0)
  if (Buffer.byteLength(JSON.stringify(result)) > 65_536) throw packageRegistryFailure('invalid-input')
  return result
}
export const terminalPhase = (phase: PackageOperationPhase): boolean => phase === 'completed' || phase === 'failed' || phase === 'cancelled'
const transitions: Readonly<Record<PackageOperationPhase, readonly PackageOperationPhase[]>> = {
  accepted: ['preparing', 'failed', 'cancelled'],
  preparing: ['prepared', 'failed', 'cancelled', 'recovery-required'],
  prepared: ['committing', 'activating', 'failed', 'cancelled'],
  committing: ['awaiting-activation', 'completed', 'recovery-required'],
  'awaiting-activation': ['activating', 'completed', 'recovery-required'],
  activating: ['completed', 'recovery-required'],
  completed: [], failed: [], cancelled: [], 'recovery-required': [],
}
export function assertTransition(from: PackageOperationPhase, to: PackageOperationPhase): void {
  if (!Object.hasOwn(transitions, from) || !transitions[from].includes(to)) throw packageRegistryFailure('transition-invalid')
}

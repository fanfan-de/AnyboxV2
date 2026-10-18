export type { InstanceInfo } from '@anybox/application-api'

/** Structural errors are translated by the caller's HTTP boundary. */
export interface ConnectionFailure extends Error {
  readonly code: string
  readonly status: number
}

export function hostFailure(code: string, status = 400): ConnectionFailure {
  return Object.assign(new Error(code), { code, status })
}

export function failure(status: number, code: string): ConnectionFailure {
  return hostFailure(code, status)
}

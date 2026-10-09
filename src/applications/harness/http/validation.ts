import { failure } from '../../../host/http-utils.js'

export function promptRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw failure(400, 'invalid-input')
  return value
}

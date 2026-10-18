export function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`)
  return value.trim()
}

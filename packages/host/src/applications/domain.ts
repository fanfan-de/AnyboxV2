export function productFailure(code: string, status = 409): Error & { code: string; status: number } {
  return Object.assign(new Error(code), { code, status })
}

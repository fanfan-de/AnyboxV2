// The actual launcher and child roles run; only their native Vault adapter is replaced.
export async function resolve(specifier, context, next) {
  if (specifier === '@napi-rs/keyring') return { url: new URL('./web-local-keyring.mjs', import.meta.url).href, shortCircuit: true }
  if (specifier === '@anybox/host/client' && process.env.ANYBOX_TEST_CLIENT_START_GATE_URL) return { url: new URL('./web-local-client-start.mjs', import.meta.url).href, shortCircuit: true }
  return next(specifier, context)
}

/** Reject accidental runtime imports in a real child process, including dynamic imports. */
let mode, mockKeyring
export function initialize(data) { mode = data.mode; mockKeyring = data.mockKeyring }
export async function resolve(specifier, context, next) {
  if (mockKeyring && specifier === '@napi-rs/keyring') return { url: new URL('./role-test-keyring.mjs', import.meta.url).href, shortCircuit: true }
  const result = await next(specifier, context)
  const url = result.url.replaceAll('\\', '/')
  const server = /\/applications\/harness\/(?:registration|server|server-runtime|server-models)\.js$/.test(url) ||
    /\/applications\/harness\/core\/(?:run|session|protocol-agents)\//.test(url) ||
    /\/applications\/harness\/core\/computer\/(?!worker-(?:client|port)\.js$)/.test(url) || /\/applications\/harness\/core\/index\.js$/.test(url) ||
    /\/host\/execution\.js$/.test(url) || /\/packages\/models\/dist\//.test(url)
  const nativeSmoke = /\/(?:desktop\/native-smoke\.js|sharp\/)/.test(url)
  const role = /\/entrypoints\/(?:client-main|harness-server-main|desktop-client|desktop-execution)\.js$/.test(url)
  if (mode === 'help' ? role || server || nativeSmoke : server || nativeSmoke) throw new Error(`Unexpected runtime import in ${mode} role: ${url}`)
  return result
}

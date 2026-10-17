export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: new URL('./desktop-main-platform.mjs', import.meta.url).href, shortCircuit: true }
  return next(specifier, context)
}

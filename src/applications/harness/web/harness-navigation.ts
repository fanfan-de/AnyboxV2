export interface HarnessRoute { hostId?: string; inner: string }
export function harnessTargetRoute(route: HarnessRoute | undefined, hostId: string): HarnessRoute {
  return { hostId, inner: route?.inner ?? '#' }
}
export function harnessHash(route: HarnessRoute): string {
  const query = new URLSearchParams()
  if (route.hostId) query.set('host', route.hostId)
  if (route.inner !== '#') query.set('view', route.inner)
  return `#/harness/workspace${query.size ? `?${query}` : ''}`
}
export function parseHarnessRoute(hash: string): HarnessRoute | undefined {
  if (/^#\/projects\//.test(hash)) return { inner: hash }
  const match = /^#\/harness\/(workspace|models|prompts)(?:\?(.*))?$/.exec(hash)
    ?? /^#\/products\/agent(?:\/pages\/(workspace|models|prompts))?(?:\?(.*))?$/.exec(hash)
  if (!match) return undefined
  const query = new URLSearchParams(match[2])
  // Retired feature pages resolve to the workspace; their locations are not project routes.
  return { hostId: query.get('host') ?? undefined, inner: !match[1] || match[1] === 'workspace' ? query.get('view') ?? '#' : '#' }
}

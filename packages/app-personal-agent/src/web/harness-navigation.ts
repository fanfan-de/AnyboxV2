export interface HarnessRoute { hostId?: string; inner: string }
export function harnessTargetRoute(route: HarnessRoute | undefined, hostId: string): HarnessRoute {
  return { hostId, inner: route?.inner ?? '#' }
}
export function harnessLocationRoute(route: HarnessRoute | undefined, inner: string, fallbackHostId?: string): HarnessRoute {
  return { hostId: route?.hostId ?? fallbackHostId, inner }
}
export function workspaceRoute(route: HarnessRoute): string {
  const query = new URLSearchParams()
  if (route.hostId) query.set('host', route.hostId)
  if (route.inner !== '#') query.set('view', route.inner)
  return `workspace${query.size ? `?${query}` : ''}`
}
export function parseWorkspaceRoute(path: string): HarnessRoute | undefined {
  const match = /^workspace(?:\?(.*))?$/.exec(path)
  if (!match) return undefined
  const query = new URLSearchParams(match[1])
  return { hostId: query.get('host') ?? undefined, inner: query.get('view') ?? '#' }
}

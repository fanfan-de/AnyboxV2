/** The internal directory binding scopes the composer and file sidebar. */
export interface SessionRef {
  readonly projectId: string
  readonly sessionId: string
  readonly continuous?: boolean
}
export interface Pane extends SessionRef { readonly id: string }

export function restoreLegacyProject(value: unknown): string | null {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('sidebarProjectId' in value)) return null
  const id = value.sidebarProjectId
  return typeof id === 'string' && id.length > 0 && id.length <= 512 ? id : null
}

export function parseRoute(hash: string): { projectId: string; sessionId?: string } | undefined {
  const match = /^#\/projects\/([^/]+)(?:\/sessions\/([^/]+))?$/.exec(hash)
  if (!match) return undefined
  try { return { projectId: decodeURIComponent(match[1]), ...(match[2] ? { sessionId: decodeURIComponent(match[2]) } : {}) } }
  catch { return undefined }
}

export function sessionHash(ref: SessionRef): string {
  return `#/projects/${encodeURIComponent(ref.projectId)}/sessions/${encodeURIComponent(ref.sessionId)}`
}

import type { JsonValue } from '@anybox/models'
import { localAttachmentId } from '../unit/domain.js'
import type { UnitAttachment, UnitAttachmentOrigin, UnitAttachmentState } from '../unit/domain.js'

/** Public environment identity is its existing attachment identity; no execution or credential is exposed. */
export interface ComputerEnvironment {
  readonly environmentId: string
  readonly origin: UnitAttachmentOrigin
  readonly state: UnitAttachmentState
  readonly unitId: string | null
  readonly platform: string | null
  readonly architecture: string | null
  readonly connectionState: 'on-demand' | 'connected' | 'offline' | 'pending' | 'revoked'
}
export interface ComputerEnvironments {
  readonly defaultEnvironmentId: string
  readonly environments: readonly ComputerEnvironment[]
}

/** A read-only projection: listing the local environment never probes or starts its worker. */
export function projectComputerEnvironments(attachments: readonly UnitAttachment[],
  local: { readonly platform: string; readonly architecture: string }, connected: ReadonlyMap<string, boolean>): ComputerEnvironments {
  const defaultEnvironmentId = localAttachmentId('computer')
  const environments = attachments.filter(attachment => attachment.unitKind === 'computer').map((attachment): ComputerEnvironment => {
    const capabilities = attachment.capabilities
    const record = capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities) ? capabilities as Readonly<Record<string, JsonValue>> : {}
    const isLocal = attachment.attachmentId === defaultEnvironmentId && attachment.origin === 'local'
    return Object.freeze({ environmentId: attachment.attachmentId, origin: attachment.origin, state: attachment.state, unitId: attachment.unitId,
      platform: isLocal ? local.platform : typeof record.platform === 'string' ? record.platform : null,
      architecture: isLocal ? local.architecture : typeof record.architecture === 'string' ? record.architecture : null,
      connectionState: attachment.state !== 'approved' ? attachment.state : isLocal ? 'on-demand' : connected.get(attachment.attachmentId) ? 'connected' : 'offline' })
  })
  environments.sort((a, b) => Number(b.environmentId === defaultEnvironmentId) - Number(a.environmentId === defaultEnvironmentId))
  return Object.freeze({ defaultEnvironmentId, environments: Object.freeze(environments) })
}

import type { JsonValue } from '@anybox/models'
import { localAttachmentId } from '../unit/domain.js'
import type { UnitAttachment, UnitAttachmentOrigin, UnitAttachmentState } from '../unit/domain.js'
import type { UnitConnection } from '../unit/transport-domain.js'
import type { ObservedWorkerInfo, WorkerInfo } from './worker-port.js'
import { parseComputerToolManifest } from './tool-support.js'
import type { ComputerToolManifest } from './tool-support.js'

export type ComputerToolSupport = { readonly state: 'unknown' } | {
  readonly state: 'reported'
  readonly workerId: string
  readonly bootId: string
  readonly manifest: ComputerToolManifest
}
type EnvironmentConnection = UnitConnection & { readonly connected: boolean }
const unknownTools: ComputerToolSupport = Object.freeze({ state: 'unknown' })
function reportedTools(info: (Omit<WorkerInfo, 'toolManifest'> & { readonly toolManifest?: unknown }) | undefined): ComputerToolSupport {
  if (!info || [info.workerId, info.bootId].some(value => typeof value !== 'string' || !value.trim() || value.length > 256 || /[\0-\x1f\x7f]/.test(value))) return unknownTools
  const manifest = parseComputerToolManifest(info.toolManifest)
  return manifest ? Object.freeze({ state: 'reported', workerId: info.workerId, bootId: info.bootId, manifest }) : unknownTools
}

/** Public environment identity is its existing attachment identity; no execution or credential is exposed. */
export interface ComputerEnvironment {
  readonly environmentId: string
  readonly origin: UnitAttachmentOrigin
  readonly state: UnitAttachmentState
  readonly unitId: string | null
  readonly platform: string | null
  readonly architecture: string | null
  readonly connectionState: 'on-demand' | 'connected' | 'offline' | 'pending' | 'revoked'
  readonly toolSupport: ComputerToolSupport
}
export interface ComputerEnvironments {
  readonly defaultEnvironmentId: string
  readonly environments: readonly ComputerEnvironment[]
}

/** A read-only projection: listing the local environment never probes or starts its worker. */
export function projectComputerEnvironments(attachments: readonly UnitAttachment[],
  local: { readonly platform: string; readonly architecture: string }, connected: ReadonlyMap<string, boolean | EnvironmentConnection>, localInfo?: ObservedWorkerInfo): ComputerEnvironments {
  const defaultEnvironmentId = localAttachmentId('computer')
  const environments = attachments.filter(attachment => attachment.unitKind === 'computer').map((attachment): ComputerEnvironment => {
    const capabilities = attachment.capabilities
    const record = capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities) ? capabilities as Readonly<Record<string, JsonValue>> : {}
    const isLocal = attachment.attachmentId === defaultEnvironmentId && attachment.origin === 'local'
    const observation = connected.get(attachment.attachmentId), connection = typeof observation === 'object' ? observation : undefined
    const isConnected = connection ? connection.connected : observation === true
    let toolSupport = unknownTools
    if (attachment.state === 'approved') {
      if (isLocal && localInfo?.platform === local.platform && localInfo.architecture === local.architecture) toolSupport = reportedTools(localInfo)
      else if (!isLocal && connection && connection.unitId === attachment.unitId) {
        const report = connection.capabilities
        const toolManifest = report && typeof report === 'object' && !Array.isArray(report) ? (report as Readonly<Record<string, JsonValue>>).computerTools : undefined
        toolSupport = reportedTools({ workerId: connection.unitId, bootId: connection.bootId, platform: connection.platform, architecture: connection.architecture,
          toolManifest })
      }
    }
    return Object.freeze({ environmentId: attachment.attachmentId, origin: attachment.origin, state: attachment.state, unitId: attachment.unitId,
      platform: isLocal ? local.platform : typeof record.platform === 'string' ? record.platform : null,
      architecture: isLocal ? local.architecture : typeof record.architecture === 'string' ? record.architecture : null,
      connectionState: attachment.state !== 'approved' ? attachment.state : isLocal ? 'on-demand' : isConnected ? 'connected' : 'offline', toolSupport })
  })
  environments.sort((a, b) => Number(b.environmentId === defaultEnvironmentId) - Number(a.environmentId === defaultEnvironmentId))
  return Object.freeze({ defaultEnvironmentId, environments: Object.freeze(environments) })
}

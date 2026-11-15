import { readFileSync } from 'node:fs'

const receipt = new URL('./worker-build.json', import.meta.url)
function readBuildId(): string | undefined {
  try {
    const value = JSON.parse(readFileSync(receipt, 'utf8')) as { formatVersion?: unknown; buildId?: unknown }
    return value.formatVersion === 1 && typeof value.buildId === 'string' && /^[a-f0-9]{64}$/.test(value.buildId) ? value.buildId : undefined
  } catch { return undefined }
}

/** The loaded code keeps its identity even when a development build replaces files on disk. */
export const workerBuildId = readBuildId()
export function workerBuildUnchanged(): boolean { return workerBuildId !== undefined && readBuildId() === workerBuildId }

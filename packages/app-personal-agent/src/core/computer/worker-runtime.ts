import { processRuntimeAvailable } from '@anybox/computer-tools/platform/process-runtime'
import { searchRuntimeAvailable } from '@anybox/computer-tools/files'
import { workerBuildUnchanged } from './worker-build.js'
import type { WorkerRuntimeHealth } from './worker-port.js'

export { workerBuildId } from './worker-build.js'

/** Worker-owned observations never infer execution readiness from the client's package. */
export function workerRuntimeHealth(): WorkerRuntimeHealth {
  if (!workerBuildUnchanged()) return { state: 'unavailable', reason: 'build-changed' }
  if (!processRuntimeAvailable()) return { state: 'unavailable', reason: 'process-unavailable' }
  if (!searchRuntimeAvailable()) return { state: 'unavailable', reason: 'search-unavailable' }
  return { state: 'ready' }
}

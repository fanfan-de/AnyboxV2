import { installHarnessServerCore } from '../../dist/applications/harness/core/index.js'
import { runAdmissionServiceKey } from '../../dist/applications/harness/core/run/component.js'

/** Test application host: its close owns the root; the Harness facade has no close method. */
export async function createTestHarnessServerCore(root, options) {
  let installation
  try { installation = await installHarnessServerCore(root, options) }
  catch (error) {
    try { await root.fiber.dispose() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Test application startup and cleanup failed') }
    throw error
  }
  let closing
  const close = () => {
    if (closing) return closing
    const api = root.get('host.http')
    root.get(runAdmissionServiceKey)?.closeAdmission()
    // Accepted ordinary HTTP writes retain their providers until the listener has drained.
    const stopped = api ? api.close().then(() => installation.close(), async error => {
      await installation.close(); throw error
    }) : installation.close()
    closing = (async () => {
      const results = await Promise.allSettled([stopped])
      try { await root.fiber.dispose() } catch (error) { results.push({ status: 'rejected', reason: error }) }
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Test application cleanup failed')
    })()
    return closing
  }
  return Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(installation.api),
    root: { value: root, enumerable: true }, close: { value: close, enumerable: true } })
}

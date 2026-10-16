import { installHarnessServerCore } from '../../dist/applications/harness/core/index.js'
import { runAdmissionServiceKey } from '../../dist/applications/harness/core/run/component.js'
import { createBashComponent } from '../../dist/applications/harness/core/tool/bash-component.js'
import { createApplyPatchComponent } from '../../dist/applications/harness/core/tool/apply-patch-component.js'
import { createProcessToolsComponent } from '../../dist/applications/harness/core/tool/process-component.js'
import { createFileToolsComponent } from '../../dist/applications/harness/core/tool/files-component.js'
import { createControlledComputerWorker } from './computer-services.mjs'

/** Test application host: its close owns the root; the Harness facade has no close method. */
export async function createTestHarnessServerCore(root, options, { legacyTools = true } = {}) {
  let installation
  try {
    // These providers belong to the fixture worker. Install without waiting for
    // Projects, which the application composition supplies on this same root.
    // The composition's router serves `computer.worker`; the fixture only stands in for the loopback worker behind it.
    if (!root.get('computer.local-worker')) {
      const fibers = [createBashComponent(), createApplyPatchComponent(), createProcessToolsComponent(), createFileToolsComponent()]
        .map(component => root.installComponent(component))
      for (const fiber of fibers) void Promise.resolve(fiber).catch(() => {})
      const worker = createControlledComputerWorker(root, { serviceKey: 'computer.local-worker' })
      await root.installComponent(worker.component)
    }
    installation = await installHarnessServerCore(root, options)
  }
  catch (error) {
    try { await root.fiber.dispose() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Test application startup and cleanup failed') }
    throw error
  }
  // Existing loop fixtures exercise the original contracts explicitly. Production
  // and library integration fixtures use the recommended mixed-source defaults.
  if (legacyTools) for (const agent of options.agents) {
    const selection = await installation.api.getAgentTools(agent.id)
    if (selection.revision === 0) await installation.api.setAgentTools(agent.id,
      { toolIds: ['anybox.bash', 'anybox.apply_patch'], expectedRevision: selection.revision })
  }
  let closing
  const close = () => {
    if (closing) return closing
    const api = root.get('host.http')
    root.get(runAdmissionServiceKey)?.closeAdmission()
    closing = (async () => {
      const invoke = work => Promise.resolve().then(work)
      const listener = invoke(() => api?.close())
      const core = (async () => {
        const results = await Promise.allSettled([invoke(() => root.get('harness.http')?.close())])
        // Ordinary handlers finish before their providers close. Retained Run
        // leases belong to the listener and must drain alongside core cleanup.
        results.push(...await Promise.allSettled([invoke(() => installation.close())]))
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        if (errors.length) throw new AggregateError(errors, 'Test application request and core cleanup failed')
      })()
      const results = await Promise.allSettled([listener, core])
      try { await root.fiber.dispose() } catch (error) { results.push({ status: 'rejected', reason: error }) }
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Test application cleanup failed')
    })()
    return closing
  }
  return Object.defineProperties({}, { ...Object.getOwnPropertyDescriptors(installation.api),
    root: { value: root, enumerable: true }, close: { value: close, enumerable: true } })
}

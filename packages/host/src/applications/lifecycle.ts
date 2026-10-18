import type { ActivityFreeze, ProductActivityPort, ProductsPort } from '@anybox/application-api'

/** Freezes product controls before inspecting all application-owned guards. No business cancellation. */
export async function freezeApplicationRole(products: ProductsPort, activity: ProductActivityPort): Promise<ActivityFreeze> {
  if (!products.freezeControls) throw Object.assign(new Error('Role control coordination unavailable'), { code: 'activation-coordination-unavailable' })
  const controls = products.freezeControls()
  let operations: ActivityFreeze | undefined
  try {
    await controls.drain()
    operations = activity.freeze(products.list().map(product => product.definition.id))
    await operations.drain()
  } catch (error) {
    const failures: unknown[] = [error]
    try { operations?.release() } catch (cleanup) { failures.push(cleanup) }
    try { controls.release() } catch (cleanup) { failures.push(cleanup) }
    if (failures.length > 1) throw Object.assign(new AggregateError(failures, 'Role coordination cleanup failed'), { phase: 'cleanup' })
    throw error
  }
  let released = false
  return { drain: async () => {}, release() {
    if (released) return
    released = true
    const failures: unknown[] = []
    try { operations!.release() } catch (error) { failures.push(error) }
    try { controls.release() } catch (error) { failures.push(error) }
    if (failures.length) throw Object.assign(new AggregateError(failures, 'Role coordination cleanup failed'), { phase: 'cleanup' })
  } }
}

import type { ApplicationWebContext, MountedApplication } from '../../../host/web/application-contracts.js'
import { mountHarnessPage } from './harness-page-client.js'
import type { HarnessMountedPage } from './harness-page-client.js'
import { parseHarnessRoute, harnessHash } from './harness-navigation.js'
export function resolveLegacyRoute(hash: string): string | undefined {
  const route = parseHarnessRoute(hash)
  return route && harnessHash(route).replace(/^#\/harness\//, '')
}
export function restoreLegacyRoute(storage: Pick<Storage, 'getItem'>): string | undefined {
  try { const route = storage.getItem('anybox.harness.route.v1'); return route ? resolveLegacyRoute(route) : undefined } catch { return undefined }
}
export async function mount(root: HTMLElement, context: ApplicationWebContext): Promise<MountedApplication> {
  const response = await fetch('/apps/agent/template.html', { signal: context.signal, cache: 'no-store' })
  if (!response.ok) throw new Error('Anybox Harness interface unavailable')
  root.innerHTML = await response.text()
  const surface = document.createElement('div'); surface.className = 'harness-surface'; root.append(surface)
  let page: HarnessMountedPage | undefined, active = false, disposed = false, tail: Promise<void> = Promise.resolve()
  const rebuild = async () => {
    await page?.dispose(); page = undefined
    if (disposed || context.signal.aborted) return
    surface.replaceChildren()
    page = await mountHarnessPage(surface, { context, templates: root, isActive: () => active, connectionsChanged() {
      tail = tail.then(rebuild).catch(() => { if (!disposed) surface.textContent = '连接界面暂时无法刷新，请重新打开界面。' })
    } })
    if (disposed || context.signal.aborted) { await page.dispose(); page = undefined; return }
    await page.activate(active, 'restore')
  }
  try { await rebuild() } catch (error) { disposed = true; await page?.dispose(); throw error }
  return {
    async setActive(value, reason) { active = value; await tail; await page?.activate(value, reason) },
    canClose: () => page?.canLeave() ?? true,
    async dispose() { disposed = true; await tail; await page?.dispose(); page = undefined; root.replaceChildren() },
  }
}

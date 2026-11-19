import { requireApplicationHttp } from '@anybox/application-api/web'
import type { ApplicationWebContext, MountedApplication } from '@anybox/application-api/web'
import { mountHarnessPage } from './harness-page-client.js'
import type { HarnessMountedPage } from './harness-page-client.js'

export async function mount(root: HTMLElement, input: ApplicationWebContext): Promise<MountedApplication> {
  const context = requireApplicationHttp(input)
  const response = await fetch(new URL('../template.html', import.meta.url), { signal: context.signal, cache: 'no-store' })
  if (!response.ok) throw new Error('Personal Agent interface unavailable')
  root.innerHTML = await response.text()
  const surface = document.createElement('div'); surface.className = 'harness-surface'; root.append(surface)
  let page: HarnessMountedPage | undefined, active = false, disposed = false, tail: Promise<void> = Promise.resolve()
  const rebuild = async () => {
    const settingsState = page?.settingsState()
    await page?.dispose(); page = undefined
    if (disposed || context.signal.aborted) return
    surface.replaceChildren()
    page = await mountHarnessPage(surface, { context, templates: root, isActive: () => active, settingsState, connectionsChanged() {
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

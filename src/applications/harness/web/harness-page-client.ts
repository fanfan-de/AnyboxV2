import { createHarnessClient, requestJSON, connectionHeaders } from './harness-client.js'
import type { HarnessClient, HarnessConnection } from './harness-client.js'
import { setupConnections } from './connections-view.js'
import { messageFor } from './client-errors.js'
import { parseHarnessRoute, harnessHash, harnessTargetRoute, harnessLocationRoute } from './harness-navigation.js'
import type { HarnessRoute } from './harness-navigation.js'
import type { MountedPage } from './page-lifecycle.js'
import type { ProductView } from '../../../host/applications/contracts.js'
import { migrateLegacyState } from './legacy-state.js'
import type { ApplicationWebContext, ApplicationActivation } from '../../../host/web/application-contracts.js'

export interface HarnessMountedPage extends MountedPage { activate(active: boolean, reason: ApplicationActivation): Promise<void> }
/** Harness has one workspace; device configuration belongs to its dialogs. */
export async function mountHarnessPage(root: HTMLElement, options: { context: ApplicationWebContext; templates: ParentNode; isActive(): boolean; connectionsChanged(): void }): Promise<HarnessMountedPage> {
  const readHash = () => '#/harness/' + (options.context.route.read() || 'workspace')
  const writeHash = (hash: string, replace = false) => options.context.route.navigate(hash.replace(/^#\/harness\//, ''), replace)
  const route = (): HarnessRoute => parseHarnessRoute(readHash()) ?? { inner: '#' }
  root.innerHTML = '<section class="harness-app"><div class="harness-content"></div></section>'
  const content = root.querySelector<HTMLElement>('.harness-content')!
  const lifetime = new AbortController()
  const abort = () => lifetime.abort()
  options.context.signal.addEventListener('abort', abort, { once: true })
  if (options.context.signal.aborted) abort()
  let manager: HarnessClient | undefined, api: HarnessClient | undefined, child: MountedPage | undefined
  let connectionUI: ReturnType<typeof setupConnections> | undefined
  let disposed = false, busy = false, mountedKey: string | undefined, transitions: Promise<void> = Promise.resolve()
  const remember = () => { try { sessionStorage.setItem('anybox.harness.route.v1', readHash()) } catch { /* Optional position. */ } }
  const disposeWorkspace = async () => {
    const previous = child; child = undefined
    await previous?.dispose(); await api?.dispose(); api = undefined
    await connectionUI?.dispose(); connectionUI = undefined
    content.replaceChildren(); mountedKey = undefined
  }
  try {
    const [connections, local] = await Promise.all([
      requestJSON<readonly HarnessConnection[]>(`${options.context.apiBase}/connections`, undefined, lifetime.signal),
      requestJSON<{ instanceId: string | null }>(`${options.context.apiBase}/local`, undefined, lifetime.signal),
    ])
    const initial = route()
    let selectedId = connections.find(connection => connection.instanceId === initial.hostId)?.id
    try { selectedId ??= connections.find(connection => connection.id === sessionStorage.getItem('anybox.client.selected'))?.id } catch { /* Optional selection. */ }
    selectedId ??= connections[0]?.id
    const selected = () => connections.find(connection => connection.id === selectedId)
    manager = createHarnessClient(connections, selectedId)
    const target = async <T>(connection: HarnessConnection, path: string, body?: object) => requestJSON<T>(`${options.context.apiBase}/connections/${encodeURIComponent(connection.id)}/v1${path}`, body, lifetime.signal, connectionHeaders(connection, 'agent'))
    const running = async (connection: HarnessConnection, activate: boolean) => {
      const info = await target<{ capabilities: readonly string[] }>(connection, '/instance')
      if (!info.capabilities.includes('products.v2')) { await target(connection, '/agents'); return true }
      let state = await target<ProductView>(connection, '/products/agent')
      if (activate && state.state !== 'running') state = await target<ProductView>(connection, state.state === 'failed' || state.state === 'blocked' ? '/products/agent/retry' : '/products/agent/open', {})
      if (state.state === 'failed') throw Object.assign(new Error(state.error?.code), { status: 503, code: state.error?.code })
      return state.state === 'running'
    }
    const show = (message = '') => {
      const notice = content.querySelector<HTMLElement>('#agent--workspace-notice')
      if (notice) { notice.textContent = message; notice.hidden = !message }
    }
    async function mountWorkspace(activate = false) {
      if (disposed || busy) return
      const connection = selected()
      busy = true
      try {
        let activationError = ''
        if (activate && connection) {
          try { await running(connection, true) } catch (error) { activationError = messageFor(error) }
        }
        const states = await Promise.all(connections.map(async item => { try { return await running(item, false) ? item : undefined } catch { return undefined } }))
        const active = states.filter((item): item is HarnessConnection => !!item)
        const key = JSON.stringify(active.map(item => item.id))
        if (mountedKey === key) { if (activationError) show(activationError); return }
        if (child && !child.canLeave()) return
        await disposeWorkspace()
        if (disposed) return
        content.append((options.templates.querySelector('#agent--agent-product-template') as HTMLTemplateElement).content.cloneNode(true))
        connectionUI = setupConnections(content, manager!, selectedId, messageFor, () => !busy && (child?.canLeave() ?? true), changed => {
          if (changed) writeHash(harnessHash(harnessTargetRoute(route(), changed.instanceId)), true)
          options.connectionsChanged()
        }, options.context.apiBase, () => options.connectionsChanged())
        const select = content.querySelector<HTMLSelectElement>('#agent--harness-select')!
        for (const option of select.options) {
          const item = connections.find(value => value.id === option.value)!
          option.textContent = `${item.instanceId === local.instanceId ? '本地' : '远程'} · ${item.name}`
        }
        api = createHarnessClient(active, selectedId)
        if (active.some(item => item.instanceId === local.instanceId)) await migrateLegacyState(sessionStorage, local.instanceId!, async (id, project) => {
          const localConnection = active.find(item => item.instanceId === local.instanceId)!
          try { const session = await api!.forConnection(localConnection.id)<{ id: string; projectId: string }>(`/sessions/${encodeURIComponent(id)}`); return session.id === id && (!project || project === session.projectId) } catch { return false }
        })
        const { mountAgentPage } = await import('./agent-client.js')
        child = mountAgentPage(content, api, { selectedId, selectedName: connection?.name, selectedInstanceId: connection?.instanceId, isActive: options.isActive, route: {
          read: () => route().inner,
          subscribe: listener => options.context.route.subscribe(listener),
          write(inner, push) {
            if (disposed) return
            // Route listeners may write the location before a device switch rebuilds this workspace.
            writeHash(harnessHash(harnessLocationRoute(route(), inner, connection?.instanceId)), !push); remember()
          },
        } })
        child.setActive?.(options.isActive()); connectionUI.setActive(options.isActive())
        if (connections.length && !active.some(item => item.id === selectedId)) {
          content.querySelector<HTMLElement>('#agent--project-picker-status')!.textContent = '请先在“管理连接”中启动所选执行设备，再选择项目目录。'
        }
        mountedKey = key
        show(activationError || (connection && !active.some(item => item.id === connection.id) ? '所选执行设备尚未启动或暂时无法连接，请在“管理连接”中检查并启动。' : ''))
        remember()
      } finally { busy = false }
    }
    const schedule = (activate: boolean) => { transitions = transitions.then(() => mountWorkspace(activate)).catch(error => { if (!disposed) show(messageFor(error)) }) }
    await mountWorkspace()
    const canonical = harnessHash(route())
    if (readHash() !== canonical) writeHash(canonical, true)
    return {
      async activate(active, reason) {
        if (disposed) return
        connectionUI?.setActive(active); child?.setActive?.(active)
        if (!active) for (const dialog of root.querySelectorAll<HTMLDialogElement>('dialog[open]')) dialog.close()
        if (reason === 'open') { schedule(true); await transitions; if (active && !connections.length) connectionUI?.open() }
      },
      canLeave: () => !busy && (child?.canLeave() ?? true) && (connectionUI?.canLeave() ?? true),
      async dispose() {
        disposed = true; remember(); options.context.signal.removeEventListener('abort', abort); lifetime.abort()
        await transitions; await disposeWorkspace(); await manager?.dispose()
      },
    }
  } catch (error) {
    disposed = true; options.context.signal.removeEventListener('abort', abort); lifetime.abort()
    await disposeWorkspace(); await manager?.dispose(); throw error
  }
}

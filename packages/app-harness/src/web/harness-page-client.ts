import { createHarnessClient, requestJSON, connectionHeaders } from './harness-client.js'
import type { HarnessClient, HarnessConnection } from './harness-client.js'
import { setupConnections } from './connections-view.js'
import { messageFor } from './client-errors.js'
import { parseHarnessRoute, harnessHash, harnessTargetRoute, harnessLocationRoute } from './harness-navigation.js'
import type { HarnessRoute } from './harness-navigation.js'
import type { MountedPage } from './page-lifecycle.js'
import type { AgentMountedPage } from './agent-client.js'
import type { SettingsViewState } from './settings-client.js'
import type { ProductView } from '@anybox/application-api/contracts'
import { migrateLegacyState } from './legacy-state.js'
import type { ApplicationHttpWebContext, ApplicationActivation } from '@anybox/application-api/web'

export interface HarnessMountedPage extends MountedPage {
  activate(active: boolean, reason: ApplicationActivation): Promise<void>
  settingsState(): SettingsViewState | undefined
}
/** Anybox Harness has one workspace; device configuration belongs to its dialogs. */
export async function mountHarnessPage(root: HTMLElement, options: { context: ApplicationHttpWebContext; templates: ParentNode; isActive(): boolean; connectionsChanged(): void; settingsState?: SettingsViewState }): Promise<HarnessMountedPage> {
  const readHash = () => '#/harness/' + (options.context.route.read() || 'workspace')
  const writeHash = (hash: string, replace = false) => options.context.route.navigate(hash.replace(/^#\/harness\//, ''), replace)
  const route = (): HarnessRoute => parseHarnessRoute(readHash()) ?? { inner: '#' }
  root.innerHTML = '<section class="harness-app"><div class="harness-content"></div></section>'
  const content = root.querySelector<HTMLElement>('.harness-content')!
  const lifetime = new AbortController()
  const abort = () => lifetime.abort()
  options.context.signal.addEventListener('abort', abort, { once: true })
  if (options.context.signal.aborted) abort()
  let manager: HarnessClient | undefined, api: HarnessClient | undefined, child: AgentMountedPage | undefined
  let connectionUI: ReturnType<typeof setupConnections> | undefined
  let pendingSettingsState: SettingsViewState | undefined
  let disposed = false, busy = false, rebuilding = false, mountedKey: string | undefined, transitions: Promise<void> = Promise.resolve()
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
    const deviceName = (connection: HarnessConnection) => connection.instanceId === local.instanceId ? '这台电脑' : connection.name
    manager = createHarnessClient(connections, selectedId)
    const target = async <T>(connection: HarnessConnection, path: string, body?: object, signal = lifetime.signal) => requestJSON<T>(`${options.context.apiBase}/connections/${encodeURIComponent(connection.id)}/v1${path}`, body, signal, connectionHeaders(connection, 'agent'))
    const running = async (connection: HarnessConnection, activate: boolean) => {
      // Read-only discovery must not trap the settings dialog behind an unresponsive device.
      // Explicit activation keeps its original lifetime and is never retried by discovery.
      const signal = activate ? lifetime.signal : AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)])
      const info = await target<{ capabilities: readonly string[] }>(connection, '/instance', undefined, signal)
      if (!info.capabilities.includes('products.v2')) { await target(connection, '/agents', undefined, signal); return true }
      let state = await target<ProductView>(connection, '/products/agent', undefined, signal)
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
        const settingsState = child?.settingsState() ?? options.settingsState
        await disposeWorkspace()
        if (disposed) return
        content.append((options.templates.querySelector('#agent--agent-product-template') as HTMLTemplateElement).content.cloneNode(true))
        const refreshConnections = (changed?: HarnessConnection) => {
          if (disposed || rebuilding) return
          pendingSettingsState = child?.settingsState()
          rebuilding = true
          // Freeze controls after the leave checks until the old page has really exited.
          // Modal dialogs escape ancestor inertness, so freeze the dialog explicitly too.
          content.inert = true
          content.querySelector<HTMLDialogElement>('#agent--settings-dialog')!.inert = true
          if (changed) writeHash(harnessHash(harnessTargetRoute(route(), changed.instanceId)), true)
          options.connectionsChanged()
        }
        connectionUI = setupConnections(content, manager!, selectedId, messageFor, () => {
          if (busy || rebuilding) return false
          if (child?.canLeave() === false) { child.showSettingsBlocked(); return false }
          return true
        }, refreshConnections, options.context.apiBase, () => refreshConnections())
        api = createHarnessClient(active, selectedId)
        if (active.some(item => item.instanceId === local.instanceId)) await migrateLegacyState(sessionStorage, local.instanceId!, async (id, project) => {
          const localConnection = active.find(item => item.instanceId === local.instanceId)!
          try { const session = await api!.forConnection(localConnection.id)<{ id: string; projectId: string }>(`/sessions/${encodeURIComponent(id)}`); return session.id === id && (!project || project === session.projectId) } catch { return false }
        })
        const { mountAgentPage } = await import('./agent-client.js')
        child = mountAgentPage(content, api, {
          selectedId, selectedName: connection ? deviceName(connection) : undefined, selectedInstanceId: connection?.instanceId, isActive: options.isActive,
          devices: connections.map(item => ({ id: item.id, name: deviceName(item) })), settingsState,
          localApi: (path, body, signal) => requestJSON(`${options.context.apiBase}${path}`, body, signal),
          selectDevice: id => connectionUI?.selectConnection(id) ?? false, route: {
          read: () => route().inner,
          subscribe: listener => options.context.route.subscribe(listener),
          write(inner, push) {
            if (disposed) return
            // Route listeners may write the location before a device switch rebuilds this workspace.
            writeHash(harnessHash(harnessLocationRoute(route(), inner, connection?.instanceId)), !push); remember()
          },
        } })
        child.setActive?.(options.isActive()); connectionUI.setActive(options.isActive())
        child.restoreSettings()
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
      settingsState: () => pendingSettingsState ?? child?.settingsState() ?? options.settingsState,
      async activate(active, reason) {
        if (disposed) return
        connectionUI?.setActive(active); child?.setActive?.(active)
        if (!active) for (const dialog of root.querySelectorAll<HTMLDialogElement>('dialog[open]')) dialog.close()
        if (reason === 'open') { schedule(true); await transitions; if (active && !connections.length) connectionUI?.open() }
      },
      canLeave: () => !busy && !rebuilding && (child?.canLeave() ?? true) && (connectionUI?.canLeave() ?? true),
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

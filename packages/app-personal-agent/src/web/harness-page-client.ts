import { createHarnessClient, executionProductPath, requestJSON } from './harness-client.js'
import type { HarnessClient, HarnessConnection } from './harness-client.js'
import { setupConnections } from './connections-view.js'
import { messageFor } from './client-errors.js'
import { parseWorkspaceRoute, workspaceRoute, harnessTargetRoute, harnessLocationRoute } from './harness-navigation.js'
import type { HarnessRoute } from './harness-navigation.js'
import type { MountedPage } from './page-lifecycle.js'
import type { AgentMountedPage } from './agent-client.js'
import type { SettingsViewState } from './settings-client.js'
import type { ProductView } from '@anybox/application-api/contracts'
import type { ApplicationHttpWebContext, ApplicationActivation } from '@anybox/application-api/web'

export interface HarnessMountedPage extends MountedPage {
  activate(active: boolean, reason: ApplicationActivation): Promise<void>
  settingsState(): SettingsViewState | undefined
}
/** Personal Agent has one workspace; device configuration belongs to its dialogs. */
export async function mountHarnessPage(root: HTMLElement, options: { context: ApplicationHttpWebContext; templates: ParentNode; isActive(): boolean; connectionsChanged(): void; settingsState?: SettingsViewState }): Promise<HarnessMountedPage> {
  const readRoute = () => options.context.route.read() || 'workspace'
  const writeRoute = (path: string, replace = false) => options.context.route.navigate(path, replace)
  const route = (): HarnessRoute => parseWorkspaceRoute(readRoute()) ?? { inner: '#' }
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
    try { selectedId ??= connections.find(connection => connection.id === sessionStorage.getItem('anybox.personal-agent.client.selected'))?.id } catch { /* Optional selection. */ }
    selectedId ??= connections[0]?.id
    const selected = () => connections.find(connection => connection.id === selectedId)
    const deviceName = (connection: HarnessConnection) => connection.instanceId === local.instanceId ? '这台电脑' : connection.name
    manager = createHarnessClient(options.context.apiBase, connections, selectedId)
    const running = async (connection: HarnessConnection, activate: boolean) => {
      const target = manager!.forConnection(connection.id)
      // Read-only discovery must not trap the settings dialog behind an unresponsive device.
      // Explicit activation keeps its original lifetime and is never retried by discovery.
      const signal = activate ? lifetime.signal : AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)])
      const info = await target<{ capabilities: readonly string[] }>('/instance', undefined, signal)
      if (!info.capabilities.includes('products.v2')) throw Object.assign(new Error('version-incompatible'), { status: 409, code: 'version-incompatible' })
      let state = await target<ProductView>(executionProductPath, undefined, signal)
      if (activate && state.state !== 'running') {
        const action = state.state === 'failed' || state.state === 'blocked' ? 'retry' : 'open'
        state = await target<ProductView>(`${executionProductPath}/${action}`, {}, signal)
      }
      if (state.state === 'failed') throw Object.assign(new Error(state.error?.code), { status: 503, code: state.error?.code })
      return state.state === 'running'
    }
    const show = (message = '') => {
      const notice = content.querySelector<HTMLElement>('#personal-agent--workspace-notice')
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
        content.append((options.templates.querySelector('#personal-agent--agent-product-template') as HTMLTemplateElement).content.cloneNode(true))
        const refreshConnections = (changed?: HarnessConnection) => {
          if (disposed || rebuilding) return
          pendingSettingsState = child?.settingsState()
          rebuilding = true
          // Freeze controls after the leave checks until the old page has really exited.
          // Modal dialogs escape ancestor inertness, so freeze the dialog explicitly too.
          content.inert = true
          content.querySelector<HTMLDialogElement>('#personal-agent--settings-dialog')!.inert = true
          if (changed) writeRoute(workspaceRoute(harnessTargetRoute(route(), changed.instanceId)), true)
          options.connectionsChanged()
        }
        connectionUI = setupConnections(content, manager!, selectedId, messageFor, () => {
          if (busy || rebuilding) return false
          if (child?.canLeave() === false) { child.showSettingsBlocked(); return false }
          return true
        }, refreshConnections, options.context.apiBase, () => refreshConnections())
        api = createHarnessClient(options.context.apiBase, active, selectedId)
        const { mountAgentPage } = await import('./agent-client.js')
        child = mountAgentPage(content, api, {
          selectedId, selectedName: connection ? deviceName(connection) : undefined, isActive: options.isActive,
          localApi: (path, body, signal) => requestJSON(`${options.context.apiBase}${path}`, body, signal),
          devices: connections.map(item => ({ id: item.id, name: deviceName(item) })), settingsState,
          selectDevice: id => connectionUI?.selectConnection(id) ?? false, route: {
          read: () => route().inner,
          subscribe: listener => options.context.route.subscribe(listener),
          write(inner, push) {
            if (disposed) return
            // Route listeners may write the location before a device switch rebuilds this workspace.
            writeRoute(workspaceRoute(harnessLocationRoute(route(), inner, connection?.instanceId)), !push)
          },
        } })
        child.setActive?.(options.isActive()); connectionUI.setActive(options.isActive())
        child.restoreSettings()
        mountedKey = key
        show(activationError || (connection && !active.some(item => item.id === connection.id) ? '所选执行设备尚未启动或暂时无法连接，请在“管理连接”中检查并启动。' : ''))
      } finally { busy = false }
    }
    const schedule = (activate: boolean) => { transitions = transitions.then(() => mountWorkspace(activate)).catch(error => { if (!disposed) show(messageFor(error)) }) }
    await mountWorkspace()
    const canonical = workspaceRoute(route())
    if (options.context.route.read() !== canonical) writeRoute(canonical, true)
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
        disposed = true; options.context.signal.removeEventListener('abort', abort); lifetime.abort()
        await transitions; await disposeWorkspace(); await manager?.dispose()
      },
    }
  } catch (error) {
    disposed = true; options.context.signal.removeEventListener('abort', abort); lifetime.abort()
    await disposeWorkspace(); await manager?.dispose(); throw error
  }
}

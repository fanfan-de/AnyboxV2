import { requestJSON } from './harness-client.js'
import { createPageRequests } from './page-lifecycle.js'
import type { HarnessConnection, HarnessClient } from './harness-client.js'
import type { ProductView } from '../../../host/applications/contracts.js'
import type { LocalPairingStatus } from '../client/connections.js'
export function setupConnections(root: HTMLElement, api: HarnessClient, selectedId: string | undefined, messageFor: (error: unknown) => string, canLeave: () => boolean, changed: (connection?: HarnessConnection) => void, apiBase: string, targetChanged: () => void) {
  const lifetime = new AbortController()
  const owned = createPageRequests((path, body, signal) => requestJSON(path, body, signal))
  const targets: ReturnType<typeof createPageRequests>[] = []
  const control = owned.api
  const select = root.querySelector('#agent--harness-select') as HTMLSelectElement
  select.replaceChildren(...api.connections.map(connection => {
    const option = document.createElement('option'); option.value = connection.id; option.textContent = connection.name; return option
  }))
  if (selectedId) select.value = selectedId
  select.disabled = !api.connections.length
  const selectConnection = (connection: HarnessConnection) => {
    try { sessionStorage.setItem('anybox.client.selected', connection.id) } catch { /* Optional selection. */ }
    changed(connection)
  }
  select.addEventListener('change', () => {
    if (!canLeave() || !canLeaveConnection()) { select.value = selectedId ?? api.connections[0]?.id ?? ''; return }
    const connection = api.connections.find(item => item.id === select.value)
    if (connection) selectConnection(connection)
  }, { signal: lifetime.signal })
  const settingsDialog = root.querySelector<HTMLDialogElement>('#agent--settings-dialog')!
  const panel = root.querySelector<HTMLElement>('#agent--connections-settings')!
  panel.innerHTML = `<header class="settings-panel-heading"><h3 id="agent--connections-title">管理连接</h3>
    <p>连接自己的执行设备。项目、模型配置和会话保存在对应设备上。</p></header>
    <section data-local class="settings-card" hidden><p data-local-status role="status"></p><button type="button" data-local-retry>重试本机连接</button></section>
    <div data-list></div><section data-tokens class="settings-card" hidden></section><p data-status class="notice" role="status" hidden></p>
    <form data-form class="settings-card"><h3 data-heading>添加连接</h3>
    <label>名称<input name="name" required maxlength="200" autocomplete="off"></label>
    <label>服务地址<input name="endpoint" required type="url" placeholder="https://harness.example.com" autocomplete="off"></label>
    <label>访问令牌<input name="token" type="password" autocomplete="new-password" placeholder="初始化命令提供的访问令牌"></label>
    <p class="settings-hint">修改连接时留空令牌可保留原凭据。更换到其他实例需要添加新连接。</p>
    <div class="settings-actions"><button type="submit" class="primary-button">验证并保存</button><button type="button" data-new>新连接</button></div></form>`
  const list = panel.querySelector<HTMLElement>('[data-list]')!, notice = panel.querySelector<HTMLElement>('[data-status]')!
  const form = panel.querySelector<HTMLFormElement>('[data-form]')!
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement
  let editing: HarnessConnection | undefined, busy = false, suspended = false
  const canLeaveConnection = () => !busy && !field('token').value && field('name').value === (editing?.name ?? '') && field('endpoint').value === (editing?.endpoint ?? '')
  const status = (message: string) => { notice.textContent = message; notice.hidden = !message }
  const action = async (work: () => Promise<void>) => {
    if (busy) return; busy = true
    const buttons = [...panel.querySelectorAll<HTMLButtonElement>('button')].map(button => ({ button, disabled: button.disabled })); buttons.forEach(({ button }) => { button.disabled = true })
    try { await work() } catch (error) { status(messageFor(error)) }
    finally { busy = false; buttons.forEach(({ button, disabled }) => { button.disabled = disabled }) }
  }
  const localCard = panel.querySelector<HTMLElement>('[data-local]')!, localNotice = panel.querySelector<HTMLElement>('[data-local-status]')!, localRetry = panel.querySelector<HTMLButtonElement>('[data-local-retry]')!
  let localTimer: ReturnType<typeof setTimeout> | undefined
  let localEnabled = false, refreshingLocal = false
  const pollLocal = (delay: number) => {
    clearTimeout(localTimer); localTimer = undefined
    if (localEnabled && !suspended && !lifetime.signal.aborted) localTimer = setTimeout(() => { void refreshLocal() }, delay)
  }
  const renderLocal = (value?: LocalPairingStatus) => {
    if (lifetime.signal.aborted) return
    localEnabled = !!value?.enabled
    localCard.hidden = !value?.enabled || value.state === 'ready'
    localRetry.hidden = value?.state !== 'failed'
    localNotice.textContent = value?.state === 'pending' ? '正在连接本机执行设备…' : value?.state === 'failed' ? `本机连接未能完成：${messageFor(Object.assign(new Error(), { status: 503, code: value.error?.code ?? 'connection-unavailable' }))}` : ''
    if (value?.state === 'ready' && value.connectionId && !api.connections.some(connection => connection.id === value.connectionId && connection.revision === value.connectionRevision) && !busy && canLeave() && canLeaveConnection()) changed()
    // Reading status never restarts or pairs a worker. A ready revision can change after
    // an explicit native restart; keep observing until unsaved UI work permits rebuilding.
    pollLocal(value?.state === 'pending' ? 500 : 5000)
  }
  const refreshLocal = async () => {
    clearTimeout(localTimer); localTimer = undefined
    if (refreshingLocal || lifetime.signal.aborted) return
    refreshingLocal = true
    try { renderLocal((await control<{ status?: LocalPairingStatus }>(`${apiBase}/local`)).status) }
    catch { pollLocal(5000) /* Connection rows remain usable when the local worker is unavailable. */ }
    finally { refreshingLocal = false }
  }
  localRetry.addEventListener('click', () => {
    if (!canLeave() || !canLeaveConnection()) { status('有尚未保存的连接修改，请先保存或点击“新连接”放弃修改。'); return }
    void action(async () => {
      clearTimeout(localTimer); localTimer = undefined
      renderLocal({ enabled: true, state: 'pending', instanceId: null, connectionId: null })
      const value = await control<LocalPairingStatus>(`${apiBase}/local/retry`, {})
      renderLocal(value)
      if (value.state === 'ready') changed()
    })
  }, { signal: lifetime.signal })
  void refreshLocal()
  for (const connection of api.connections) {
    const row = document.createElement('section'); row.className = 'settings-card connection-row'
    const title = document.createElement('strong'), address = document.createElement('p'), result = document.createElement('p')
    title.textContent = connection.name; address.textContent = connection.endpoint; result.textContent = '尚未检查'
    row.append(title, address, result)
    const button = (label: string, handler: () => void) => { const node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.addEventListener('click', handler); row.append(node) }
    const target = createPageRequests(api.forConnection(connection.id)); targets.push(target)
    let targetState: ProductView | undefined
    const start = document.createElement('button'), stop = document.createElement('button')
    start.type = stop.type = 'button'; start.textContent = '启动 Agent'; stop.textContent = '停止 Agent'
    start.hidden = stop.hidden = true
    const refreshTarget = async () => {
      const instance = await target.api<{ capabilities: readonly string[] }>('/instance')
      if (!instance.capabilities.includes('products.v2')) { result.textContent = '已连接'; return }
      targetState = await target.api<ProductView>('/products/agent')
      const labels = { disabled: '尚未启动', applying: '正在启动', running: '运行中', blocked: '等待依赖', failed: '启动失败' }
      result.textContent = labels[targetState.state]
      start.hidden = targetState.state === 'running'; stop.hidden = targetState.state === 'disabled'
      start.disabled = stop.disabled = targetState.state === 'applying'
    }
    start.addEventListener('click', () => {
      if (!canLeave() || !canLeaveConnection()) { status('有尚未保存的连接修改，请先保存或点击“新连接”放弃修改。'); return }
      void action(async () => {
        const path = targetState?.state === 'failed' || targetState?.state === 'blocked' ? '/products/agent/retry' : '/products/agent/open'
        const state = await target.api<ProductView>(path, {})
        if (state.state !== 'running') throw Object.assign(new Error(state.error?.code ?? 'service-unavailable'), { code: state.error?.code ?? 'service-unavailable' })
        targetChanged()
      })
    })
    stop.addEventListener('click', () => {
      if (!canLeave() || !canLeaveConnection()) { status('有尚未保存的连接修改，请先保存或点击“新连接”放弃修改。'); return }
      void action(async () => {
        const state = await target.api<ProductView>('/products/agent/stop', {})
        if (state.state !== 'disabled') throw Object.assign(new Error(state.error?.code ?? 'service-unavailable'), { code: state.error?.code ?? 'service-unavailable' })
        targetChanged()
      })
    })
    row.append(start, stop)
    button('检查连接', () => void action(async () => {
      try { await control(`${apiBase}/connections/${connection.id}/check`, {}); await refreshTarget() }
      catch (error) { result.textContent = messageFor(error); throw error }
    }))
    button('访问令牌', () => void action(async () => {
      const section = panel.querySelector<HTMLElement>('[data-tokens]')!
      section.hidden = false; section.replaceChildren()
      const title = document.createElement('h3'); title.textContent = `${connection.name} · 设备访问令牌`; section.append(title)
      const target = api.forConnection(connection.id)
      const tokenList = document.createElement('div'), once = document.createElement('p'); once.className = 'token-once'
      const render = async () => {
        const values = await target<readonly { id: string; name: string; createdAt: string; revokedAt: string | null }[]>('/access/tokens')
        tokenList.replaceChildren(...values.map(value => {
          const row = document.createElement('p'), label = document.createElement('span'), revoke = document.createElement('button')
          label.textContent = `${value.name} · ${value.revokedAt ? '已撤销' : value.createdAt} `
          revoke.type = 'button'; revoke.textContent = '撤销'; revoke.disabled = !!value.revokedAt
          revoke.addEventListener('click', () => void action(async () => { await target(`/access/tokens/${value.id}/revoke`, {}); row.textContent = `${value.name} · 已撤销` }))
          row.append(label, revoke); return row
        }))
      }
      const label = document.createElement('label'), name = document.createElement('input'), issue = document.createElement('button')
      label.textContent = '新设备名称'; name.value = 'New device'; name.maxLength = 200; label.append(name)
      issue.type = 'button'; issue.textContent = '发行设备令牌'
      issue.addEventListener('click', () => void action(async () => {
        const result = await target<{ token: string }>('/access/tokens', { name: name.value })
        once.textContent = `仅本次显示，请复制到新设备：${result.token}`; await render()
      }))
      section.append(tokenList, label, issue, once); await render()
    }))
    button('编辑', () => { editing = connection; field('name').value = connection.name; field('endpoint').value = connection.endpoint; field('token').value = ''; panel.querySelector('[data-heading]')!.textContent = `编辑 ${connection.name}` })
    button('移除连接', () => { if (canLeave() && canLeaveConnection()) void action(async () => { await control(`${apiBase}/connections/${connection.id}/delete`, { expectedRevision: connection.revision }); changed() }) })
    list.append(row)
    void refreshTarget().catch(error => { if (!lifetime.signal.aborted) result.textContent = messageFor(error) })
  }
  panel.querySelector('[data-new]')!.addEventListener('click', () => { editing = undefined; form.reset(); panel.querySelector('[data-heading]')!.textContent = '添加连接' })
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!form.reportValidity() || !canLeave()) return
    const token = field('token').value; field('token').value = ''
    void action(async () => {
      const saved = await control<HarnessConnection>(`${apiBase}/connections`, { name: field('name').value, endpoint: field('endpoint').value, ...(token ? { token } : {}), ...(editing ? { id: editing.id, expectedRevision: editing.revision } : {}) })
      selectConnection(saved)
    })
  })
  settingsDialog.addEventListener('close', () => { if (suspended) return; field('token').value = ''; panel.querySelector('[data-tokens]')!.replaceChildren() }, { signal: lifetime.signal })
  const open = () => {
    suspended = false
    root.querySelector<HTMLButtonElement>('[data-settings-section="connections"]')!.click()
    if (!settingsDialog.open) root.querySelector<HTMLButtonElement>('#agent--open-settings')!.click()
  }
  return { open, setActive(active: boolean) { suspended = !active; clearTimeout(localTimer); localTimer = undefined; if (active) void refreshLocal() },
    canLeave: canLeaveConnection, async dispose() { lifetime.abort(); clearTimeout(localTimer); await Promise.all([owned.dispose(), ...targets.map(target => target.dispose())]); panel.replaceChildren() } }
}

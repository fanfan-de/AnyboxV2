import { requestJSON } from './harness-client.js'
import type { HarnessConnection, HarnessClient } from './harness-client.js'
export function setupConnections(api: HarnessClient, selectedId: string | undefined, messageFor: (error: unknown) => string): void {
  const select = document.getElementById('harness-select') as HTMLSelectElement
  select.replaceChildren(...api.connections.map(connection => {
    const option = document.createElement('option'); option.value = connection.id; option.textContent = connection.name; return option
  }))
  if (selectedId) select.value = selectedId
  select.disabled = !api.connections.length
  select.addEventListener('change', () => { sessionStorage.setItem('anybox.client.selected', select.value); location.reload() })
  const dialog = document.createElement('dialog'); dialog.className = 'settings-dialog connections-dialog'
  dialog.setAttribute('aria-labelledby', 'connections-title')
  dialog.innerHTML = `<div class="settings-heading"><h2 id="connections-title">Harness 连接</h2><button type="button" data-close aria-label="关闭连接管理">×</button></div>
    <p class="settings-hint">连接自己的执行设备。项目、模型配置和会话保存在对应设备上。</p>
    <div data-list></div><section data-tokens class="settings-card" hidden></section><p data-status class="notice" role="status" hidden></p>
    <form data-form class="settings-card"><h3 data-heading>添加连接</h3>
    <label>名称<input name="name" required maxlength="200" autocomplete="off"></label>
    <label>服务地址<input name="endpoint" required type="url" placeholder="https://harness.example.com" autocomplete="off"></label>
    <label>访问令牌<input name="token" type="password" autocomplete="new-password" placeholder="初始化命令提供的访问令牌"></label>
    <p class="settings-hint">修改连接时留空令牌可保留原凭据。更换到其他实例需要添加新连接。</p>
    <div class="settings-actions"><button type="submit" class="primary-button">验证并保存</button><button type="button" data-new>新连接</button></div></form>`
  document.body.append(dialog)
  dialog.querySelector('[data-close]')!.addEventListener('click', () => dialog.close())
  const list = dialog.querySelector<HTMLElement>('[data-list]')!, notice = dialog.querySelector<HTMLElement>('[data-status]')!
  const form = dialog.querySelector<HTMLFormElement>('[data-form]')!
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement
  let editing: HarnessConnection | undefined, busy = false
  const status = (message: string) => { notice.textContent = message; notice.hidden = !message }
  const action = async (work: () => Promise<void>) => {
    if (busy) return; busy = true
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')].map(button => ({ button, disabled: button.disabled })); buttons.forEach(({ button }) => { button.disabled = true })
    try { await work() } catch (error) { status(messageFor(error)) }
    finally { busy = false; buttons.forEach(({ button, disabled }) => { button.disabled = disabled }) }
  }
  for (const connection of api.connections) {
    const row = document.createElement('section'); row.className = 'settings-card connection-row'
    const title = document.createElement('strong'), address = document.createElement('p'), result = document.createElement('p')
    title.textContent = connection.name; address.textContent = connection.endpoint; result.textContent = '尚未检查'
    row.append(title, address, result)
    const button = (label: string, handler: () => void) => { const node = document.createElement('button'); node.type = 'button'; node.textContent = label; node.addEventListener('click', handler); row.append(node) }
    button('检查连接', () => void action(async () => {
      try { await requestJSON(`/api/client/v1/connections/${connection.id}/check`, {}); result.textContent = '已连接' }
      catch (error) { result.textContent = messageFor(error); throw error }
    }))
    button('访问令牌', () => void action(async () => {
      const section = dialog.querySelector<HTMLElement>('[data-tokens]')!
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
    button('编辑', () => { editing = connection; field('name').value = connection.name; field('endpoint').value = connection.endpoint; field('token').value = ''; dialog.querySelector('[data-heading]')!.textContent = `编辑 ${connection.name}` })
    button('移除连接', () => void action(async () => { await requestJSON(`/api/client/v1/connections/${connection.id}/delete`, { expectedRevision: connection.revision }); location.reload() }))
    list.append(row)
  }
  dialog.querySelector('[data-new]')!.addEventListener('click', () => { editing = undefined; form.reset(); dialog.querySelector('[data-heading]')!.textContent = '添加连接' })
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!form.reportValidity()) return
    const token = field('token').value; field('token').value = ''
    void action(async () => {
      const saved = await requestJSON<HarnessConnection>('/api/client/v1/connections', { name: field('name').value, endpoint: field('endpoint').value, ...(token ? { token } : {}), ...(editing ? { id: editing.id, expectedRevision: editing.revision } : {}) })
      sessionStorage.setItem('anybox.client.selected', saved.id); location.reload()
    })
  })
  dialog.addEventListener('close', () => { field('token').value = ''; dialog.querySelector('[data-tokens]')!.replaceChildren() })
  document.getElementById('manage-harnesses')!.addEventListener('click', () => dialog.showModal())
  if (!api.connections.length) dialog.showModal()
}

import { readDevices, readLocal, requestJSON } from './client.js'
import type { DeviceConnection } from './client.js'
import { messageFor } from './state.js'
import { el } from './view.js'

/** This dialog owns only Claude Agent's saved connections and clears its credential draft on close. */
export function openConnectionManager(container: HTMLElement, apiBase: string, domId: (name: string) => string, changed: () => Promise<void>) {
  const controller = new AbortController(), tasks = new Set<Promise<unknown>>()
  let editing: DeviceConnection | undefined, closing: Promise<void> | undefined, disposed = false, busy = false
  const name = el('input', { id: domId('connection-name'), required: true, maxlength: '200', autocomplete: 'off' })
  const endpoint = el('input', { id: domId('connection-endpoint'), type: 'url', required: true, placeholder: 'https://device.example', autocomplete: 'off' })
  const token = el('input', { id: domId('connection-token'), type: 'password', required: true, autocomplete: 'off' })
  const field = (label: string, input: HTMLInputElement) => el('label', { for: input.id }, el('span', { text: label }), input)
  const save = el('button', { type: 'submit', class: 'primary-button', text: '添加连接' })
  const reset = el('button', { type: 'button', text: '新建连接' })
  const closeButton = el('button', { type: 'button', text: '关闭' })
  const local = el('button', { type: 'button', text: '启动并连接本机服务', hidden: true })
  const status = el('p', { role: 'status', class: 'ca-connections-status' })
  const list = el('ul', { class: 'ca-connections-list', 'aria-label': '已保存的连接' })
  const form = el('form', { class: 'ca-connections-form' }, field('名称', name), field('服务地址', endpoint), field('访问令牌', token),
    el('div', { class: 'ca-connections-actions' }, save, reset))
  const title = el('h2', { id: domId('connections-title'), text: '管理连接' })
  const dialog = el('dialog', { class: 'ca-connections-dialog', 'aria-labelledby': title.id },
    el('header', {}, title, closeButton), local, status, list, form)
  const clearDraft = () => { editing = undefined; form.reset(); token.value = ''; token.required = true; token.placeholder = ''; save.textContent = '添加连接' }
  const close = (): Promise<void> => {
    if (closing) return closing
    if (disposed) return Promise.resolve()
    disposed = true; clearDraft(); controller.abort(); dialog.close(); dialog.remove()
    closing = Promise.allSettled([...tasks]).then(() => {})
    return closing
  }
  const run = (work: () => Promise<void>): void => {
    if (disposed || busy) return
    busy = true; status.textContent = ''
    for (const input of dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')) if (input !== closeButton) input.disabled = true
    const task = work().catch(error => { if (!disposed && !controller.signal.aborted) status.textContent = messageFor(error) }).finally(() => {
      tasks.delete(task); busy = false
      if (!disposed) for (const input of dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')) input.disabled = false
    })
    tasks.add(task)
  }
  const refresh = async () => {
    const directory = await readDevices(apiBase, controller.signal)
    if (disposed) return
    list.replaceChildren(...directory.connections.map(connection => {
      const edit = el('button', { type: 'button', text: '编辑', 'aria-label': `编辑 ${connection.name}` })
      const remove = el('button', { type: 'button', text: '删除', 'aria-label': `删除 ${connection.name}` })
      edit.addEventListener('click', () => {
        if (busy || disposed) return
        editing = connection; name.value = connection.name; endpoint.value = connection.endpoint
        token.value = ''; token.required = false; token.placeholder = '留空保留现有令牌'; save.textContent = '保存修改'; name.focus()
      })
      remove.addEventListener('click', () => run(async () => {
        await requestJSON(`${apiBase}/connections/${encodeURIComponent(connection.id)}/delete`, { expectedRevision: connection.revision }, controller.signal)
        if (disposed) return
        if (editing?.id === connection.id) clearDraft()
        await refresh(); if (!disposed) await changed()
      }))
      return el('li', {}, el('div', {}, el('strong', { text: connection.name }), el('small', { text: connection.endpoint })),
        el('div', { class: 'ca-connections-actions' }, edit, remove))
    }))
  }
  form.addEventListener('submit', event => {
    event.preventDefault()
    run(async () => {
      const input = { name: name.value.trim(), endpoint: endpoint.value.trim(), ...(token.value ? { token: token.value } : {}),
        ...(editing ? { id: editing.id, expectedRevision: editing.revision } : {}) }
      try { await requestJSON(`${apiBase}/connections`, input, controller.signal) } finally { token.value = '' }
      if (disposed) return
      clearDraft(); await refresh(); if (!disposed) await changed()
    })
  })
  local.addEventListener('click', () => run(async () => {
    const result = await requestJSON<{ state: string; error?: { code: string } }>(`${apiBase}/local/retry`, {}, controller.signal)
    if (result.state === 'failed') throw Object.assign(new Error(result.error?.code ?? 'connection-unavailable'), result.error)
    if (!disposed) { await refresh(); if (!disposed) await changed() }
  }))
  reset.addEventListener('click', clearDraft)
  closeButton.addEventListener('click', () => { void close() })
  dialog.addEventListener('cancel', event => { event.preventDefault(); void close() })
  dialog.addEventListener('close', () => { void close() })
  container.append(dialog); dialog.showModal()
  run(async () => {
    const identity = await readLocal(apiBase, controller.signal) as { status?: { enabled: boolean } }
    if (!disposed) local.hidden = !identity.status?.enabled
    await refresh()
  })
  return { close }
}

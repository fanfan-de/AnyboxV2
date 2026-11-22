import type { Api, ProjectView } from './client-types.js'
import type { ComputerEnvironments } from '../core/computer/environments.js'
import type { ProjectWorkspaces } from '../core/project/members.js'
import type { SessionWorkspaceSelection } from '../core/session/domain.js'
import { environmentLabel, environmentStateLabel } from './project-directory-client.js'

const workspacePath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/workspaces`

/** Each dialog captures one project. Changing the selected connection cannot retarget a mutation. */
export function projectWorkspaceDialogs(root: HTMLElement, api: Api, messageFor: (error: unknown) => string,
  updateCount: (projectId: string, count: number) => void) {
  let active: HTMLDialogElement | undefined
  function mount(title: string, project: ProjectView) {
    active?.close()
    const dialog = document.createElement('dialog')
    dialog.className = 'settings-dialog project-workspaces-dialog'
    dialog.setAttribute('aria-label', title)
    dialog.innerHTML = `<header><div><small></small><h2></h2></div><button type="button" aria-label="关闭">×</button></header>
      <div class="workspace-dialog-body"></div><p class="workspace-dialog-status" role="status"></p>`
    dialog.querySelector('h2')!.textContent = title
    dialog.querySelector('small')!.textContent = project.name
    const status = dialog.querySelector<HTMLElement>('[role=status]')!, body = dialog.querySelector<HTMLElement>('.workspace-dialog-body')!
    const exit = new AbortController()
    dialog.querySelector('header button')!.addEventListener('click', () => dialog.close())
    dialog.addEventListener('close', () => { exit.abort(); dialog.remove(); if (active === dialog) active = undefined }, { once: true })
    root.append(dialog); active = dialog; dialog.showModal()
    return { dialog, body, status, signal: exit.signal }
  }

  async function choose(project: ProjectView, signal: AbortSignal): Promise<SessionWorkspaceSelection | undefined | null> {
    const state = await api<ProjectWorkspaces>(workspacePath(project.id), undefined, signal)
    signal.throwIfAborted()
    if (state.workspaces.length === 1) return undefined
    const { dialog, body } = mount('选择会话工作区', project)
    const form = document.createElement('form')
    body.append(form)
    const checked = new Set<string>()
    for (const item of state.workspaces) {
      const row = document.createElement('label'), box = document.createElement('input')
      row.className = 'workspace-choice'
      box.type = 'checkbox'; box.checked = item.primary; box.disabled = item.primary
      box.addEventListener('change', () => box.checked ? checked.add(item.id) : checked.delete(item.id))
      const text = document.createElement('span'), name = document.createElement('strong'), path = document.createElement('small')
      name.textContent = item.name + (item.primary ? ' · 主工作区' : ''); path.textContent = item.path
      text.append(name, path); row.append(box, text); form.append(row)
    }
    const submit = document.createElement('button')
    submit.type = 'submit'; submit.textContent = '创建会话'; form.append(submit)
    return new Promise(resolve => {
      let selection: SessionWorkspaceSelection | null = null
      const close = () => dialog.close()
      form.addEventListener('submit', event => { event.preventDefault(); selection = { workspaceIds: [...checked], projectWorkspaceRevision: state.revision }; close() })
      signal.addEventListener('abort', close, { once: true })
      dialog.addEventListener('close', () => { signal.removeEventListener('abort', close); resolve(selection) }, { once: true })
    })
  }

  async function manage(project: ProjectView, computers: (signal: AbortSignal) => Promise<ComputerEnvironments>) {
    const { dialog, body, status, signal } = mount('项目工作区', project)
    const base = workspacePath(project.id)
    let snapshot: ProjectWorkspaces, inventory: ComputerEnvironments
    let busy = false
    function render() {
      body.replaceChildren()
      const mutate = async (suffix: string, input: object) => {
        if (busy) return
        busy = true; body.inert = true; status.textContent = '正在保存…'
        try {
          snapshot = await api<ProjectWorkspaces>(base + suffix, { ...input, expectedRevision: snapshot.revision, requestId: crypto.randomUUID() })
          updateCount(project.id, snapshot.workspaces.length)
          if (!signal.aborted) { status.textContent = ''; render() }
        } catch (error) {
          if (!signal.aborted) {
            status.textContent = messageFor(error)
            // A committed write can lose its response. Refresh before allowing another edit.
            try {
              snapshot = await api<ProjectWorkspaces>(base, undefined, signal)
              if (!signal.aborted) { updateCount(project.id, snapshot.workspaces.length); render() }
            }
            catch { if (!signal.aborted) { body.inert = true; return } }
          }
        } finally { busy = false }
        body.inert = false
      }
      for (const item of snapshot.workspaces) {
        const row = document.createElement('div'); row.className = 'workspace-entry'
        const label = document.createElement('strong'), info = document.createElement('small')
        label.textContent = item.name + (item.primary ? ' · 主工作区' : '')
        const device = inventory.environments.find(device => device.environmentId === item.computerAttachmentId)
        info.textContent = [device ? environmentLabel(device) : item.computerAttachmentId, item.path].join(' · ')
        const text = document.createElement('div'); text.append(label, info); row.append(text)
        const rename = document.createElement('button'); rename.type = 'button'; rename.textContent = '改名'
        rename.addEventListener('click', () => {
          const form = document.createElement('form'), input = document.createElement('input'), save = document.createElement('button')
          input.value = item.name; input.required = true; input.maxLength = 80; input.setAttribute('aria-label', '工作区名称')
          save.textContent = '保存'; row.replaceChildren(form); form.append(input, save); input.select()
          form.addEventListener('submit', event => { event.preventDefault(); void mutate('/' + encodeURIComponent(item.id) + '/rename', { name: input.value.trim() }) })
        })
        row.append(rename)
        if (!item.primary) {
          const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '移除'
          remove.addEventListener('click', () => { void mutate('/' + encodeURIComponent(item.id) + '/remove', {}) })
          row.append(remove)
        }
        body.append(row)
      }
      const available = inventory.environments.filter(device => device.state === 'approved' &&
        !snapshot.workspaces.some(item => item.computerAttachmentId === device.environmentId))
      if (!available.length) {
        const hint = document.createElement('p'); hint.textContent = '要添加其他电脑，请先在「执行环境」中接入并批准设备。'; body.append(hint); return
      }
      const form = document.createElement('form'); form.className = 'workspace-add-form'
      form.innerHTML = `<h3>添加工作区</h3><label>电脑<select required></select></label>
        <label>工作区名称<input name="label" required maxlength="80" placeholder="例如，预发布服务器"></label>
        <label>电脑上的工作目录<input name="path" required placeholder="例如，/srv/shop" spellcheck="false"></label>
        <button type="submit">添加工作区</button>`
      const select = form.querySelector('select')!
      for (const device of available) {
        const option = document.createElement('option'); option.value = device.environmentId
        option.textContent = `${environmentLabel(device)} · ${environmentStateLabel(device)}`; select.append(option)
      }
      form.addEventListener('submit', event => {
        event.preventDefault()
        const data = new FormData(form)
        void mutate('', { name: String(data.get('label')).trim(), path: String(data.get('path')), computerAttachmentId: select.value })
      })
      body.append(form)
    }
    status.textContent = '正在读取工作区…'
    try {
      ;[snapshot, inventory] = await Promise.all([api<ProjectWorkspaces>(base, undefined, signal), computers(signal)])
      if (dialog.open) { status.textContent = ''; render() }
    } catch (error) { if (dialog.open) status.textContent = messageFor(error) }
  }
  return { manage, choose, close: () => active?.close() }
}

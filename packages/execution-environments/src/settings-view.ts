import { environmentToolKey } from './contracts.js'
import type { EnvironmentTool, GrantChange } from './contracts.js'
import type { EnvironmentAccessView, EnvironmentSelection, EnvironmentTarget } from './management.js'

interface Options {
  api<T>(path: string, body?: object): Promise<T>
  messageFor(error: unknown): string
  storageKey: string
  continuousSessionId?(agentId: string): string | undefined
}
interface Draft {
  name?: string
  view?: EnvironmentAccessView
  tools: Map<string, EnvironmentTool>
  environments: Set<string>
  picked: Map<string, Set<string>>
  open: Set<string>
  session?: { id: string; selection: EnvironmentSelection }
  change?: GrantChange
  pendingId?: string
  writing: boolean
  busy: boolean
  notice: string
}
const section = (tag: 'section' | 'div' | 'p' | 'strong' | 'h4' | 'span' | 'small', value?: string) => {
  const element = document.createElement(tag)
  if (value !== undefined) element.textContent = value
  return element
}
function button(label: string, disabled: boolean, action: () => void) {
  const element = document.createElement('button')
  element.type = 'button'; element.textContent = label; element.disabled = disabled
  element.addEventListener('click', action)
  return element
}
function check(label: string, checked: boolean, disabled: boolean, update: (value: boolean) => void) {
  const row = document.createElement('label')
  row.className = 'tool-option'
  const input = document.createElement('input')
  input.type = 'checkbox'; input.checked = checked; input.disabled = disabled
  input.addEventListener('change', () => update(input.checked))
  row.append(input, section('span', label))
  return row
}
const names: Readonly<Record<string, string>> = { computer: 'Computer', 'model-search': '模型提供方搜索' }
const stateName = { draining: '权限已更新，正在等待已接纳的操作退出。', completed: '授权变更已完成。', 'exit-unknown': '已禁止新调用，部分操作的退出尚未确认。' }
function progress(change: GrantChange) {
  return change.affectedCount ? stateName[change.state] + ` 影响 ${change.affectedCount} 项操作，等待退出 ${change.pendingCount} 项，退出未知 ${change.unknownCount} 项。` : stateName[change.state]
}
function sameTools(picked: ReadonlyMap<string, ReadonlySet<string>>, saved: EnvironmentSelection) {
  const entries = Object.entries(saved.toolIdsByEnvironment ?? {})
  return picked.size === entries.length && entries.every(([env, ids]) => {
    const selection = picked.get(env)
    return selection?.size === ids.length && ids.every(id => selection.has(id))
  })
}
function changed(draft: Draft): { grants: boolean; preference: boolean } {
  const view = draft.view
  if (!view) return { grants: false, preference: false }
  return {
    grants: draft.tools.size !== view.authorization.grants.length || view.authorization.grants.some(grant => !draft.tools.has(environmentToolKey(grant.tool))),
    preference: !sameTools(draft.picked, view.preference) || draft.environments.size !== view.preference.environmentIds.length || view.preference.environmentIds.some(id => !draft.environments.has(id)),
  }
}

/** The enclosing app supplies a request port bound to one execution instance. */
export function mountEnvironmentAccess(panel: HTMLElement, options: Options) {
  const drafts = new Map<string, Draft>()
  let active = '', disposed = false
  const path = (id: string) => '/agents/' + encodeURIComponent(id) + '/environment-access'
  const storage = (id: string) => JSON.stringify(['anybox.environment-grant-request.v1', options.storageKey, id])
  const remember = (id: string, draft: Draft, requestId?: string) => {
    draft.pendingId = requestId
    try {
      if (requestId) sessionStorage.setItem(storage(id), requestId)
      else sessionStorage.removeItem(storage(id))
    } catch { /* The current view still owns the original request ID. */ }
  }
  const run = async (id: string, draft: Draft, work: () => Promise<void>, writing = false) => {
    if (disposed || draft.busy) return
    draft.busy = true; draft.writing = writing; draft.notice = ''; render()
    try { await work() } catch (error) { draft.notice = options.messageFor(error) }
    finally { draft.busy = false; draft.writing = false; if (id === active) render() }
  }
  async function read(id: string, draft: Draft) {
    const view = await options.api<EnvironmentAccessView>(path(id))
    if (disposed) return
    draft.view = view
    draft.tools = new Map(view.authorization.grants.map(grant => [environmentToolKey(grant.tool), grant.tool]))
    draft.environments = new Set(view.preference.environmentIds)
    draft.picked = new Map(Object.entries(view.preference.toolIdsByEnvironment ?? {}).map(([env, ids]) => [env, new Set(ids)]))
  }
  async function readSession(id: string, draft: Draft) {
    draft.session = undefined
    const sessionId = options.continuousSessionId?.(id)
    if (!sessionId) return
    const selection = await options.api<EnvironmentSelection>('/sessions/' + encodeURIComponent(sessionId) + '/environments')
    if (!disposed) draft.session = { id: sessionId, selection }
  }
  async function observe(id: string, draft: Draft) {
    const requestId = draft.pendingId ?? (draft.change?.state !== 'completed' ? draft.change?.requestId : undefined)
    if (!requestId) return
    try {
      draft.change = await options.api<GrantChange>(path(id) + '/changes/' + encodeURIComponent(requestId))
    } catch (error) {
      if (typeof error !== 'object' || !error || !('code' in error) || error.code !== 'environment-change-not-found') throw error
      draft.change = undefined
      remember(id, draft)
      draft.notice = '执行端未登记该变更。请核对当前授权后再操作。'
      return
    }
    draft.notice = progress(draft.change)
    remember(id, draft)
  }
  function reload(id: string, draft: Draft) {
    return run(id, draft, async () => { await observe(id, draft); await read(id, draft); await readSession(id, draft) })
  }
  async function saveGrants(id: string, draft: Draft) {
    if (!draft.view || draft.pendingId) return
    const expectedRevision = draft.view.authorization.revision, tools = [...draft.tools.values()]
    await run(id, draft, async () => {
      const requestId = crypto.randomUUID()
      remember(id, draft, requestId)
      draft.change = undefined
      try {
        draft.change = await options.api<GrantChange>(path(id) + '/grants', { requestId, expectedRevision, tools })
      } catch (error) {
        // Only a definite admission failure frees the original request for another edit.
        if (typeof error === 'object' && error && 'status' in error && [400, 403, 409].includes(Number(error.status))) remember(id, draft)
        throw error
      }
      draft.notice = progress(draft.change)
      remember(id, draft)
      await read(id, draft)
      await readSession(id, draft)
    }, true)
  }
  function render() {
    if (disposed) return
    const id = active, draft = drafts.get(id)
    const previousFocus = panel.contains(document.activeElement) ? (document.activeElement as HTMLElement)?.dataset.control : undefined
    panel.replaceChildren()
    if (!draft) return
    function group(key: string, title: string) {
      const details = document.createElement('details')
      details.open = draft!.open.has(key)
      const summary = document.createElement('summary')
      summary.textContent = title
      details.append(summary)
      details.addEventListener('toggle', () => {
        if (!details.isConnected) return
        if (details.open) draft!.open.add(key)
        else draft!.open.delete(key)
      })
      return details
    }
    function choice(key: string, label: string, selected: boolean, disabled: boolean, change: (value: boolean) => void) {
      const row = check(label, selected, disabled, value => { change(value); render() })
      const control = row.firstElementChild as HTMLInputElement
      control.dataset.control = key
      return row
    }
    const dirty = changed(draft), view = draft.view
    const observing = draft.pendingId || (draft.change && draft.change.state !== 'completed') || view?.pendingChanges.length
    const refresh = button(dirty.grants || dirty.preference ? '放弃修改并重新读取' : observing ? '查看原变更进度' : '刷新环境授权',
      draft.busy, () => { void reload(id, draft) })
    if (view) {
      const grants = section('section'); grants.className = 'settings-card'
      grants.append(section('h4', (draft.name || id) + ' 的环境授权'), section('p', '仅勾选允许此 Agent 调用的工具。移除授权并保存将阻止新调用，并等待相关操作退出。'))
      for (const change of view.pendingChanges) {
        const details = group('change:' + change.requestId, '第 ' + change.revision + ' 次授权变更 · ' + progress(change))
        details.append(section('small', change.requestId))
        grants.append(details)
      }
      const targets: EnvironmentTarget[] = [...view.targets]
      const available = new Set(targets.flatMap(target => target.tools.map(environmentToolKey)))
      const unavailable = view.authorization.grants.map(grant => grant.tool).filter(tool => !available.has(environmentToolKey(tool)))
      if (unavailable.length) targets.push({ environmentId: '', targetId: '', name: '已失效的绑定（可撤销）', tools: unavailable })
      for (const target of targets) {
        const title = target.environmentId && target.environmentId !== target.name
          ? (names[target.environmentId] ?? target.environmentId) + ' · ' + target.name : target.name
        const details = group(JSON.stringify([target.environmentId, target.targetId]), title)
        if (target.environmentId) details.append(section('small', target.targetId))
        if (target.environmentId === 'model-search') details.append(section('p', '搜索由模型提供方执行。撤权会阻止后续发送，已提交的搜索以提供方回执为准。'))
        for (const tool of target.tools) {
          const key = environmentToolKey(tool)
          const label = tool.toolId + ' · ' + tool.version.split('@')[0]
          const row = choice(key, label, draft.tools.has(key), draft.busy || !!draft.pendingId || dirty.preference, selected => {
            if (selected) draft.tools.set(key, tool)
            else draft.tools.delete(key)
          })
          row.title = target.targetId || tool.targetId
          details.append(row)
        }
        grants.append(details)
      }
      if (!targets.length) grants.append(section('p', '此执行端尚无可授权工具。'))
      grants.append(button('保存授权', !dirty.grants || dirty.preference || draft.busy || !!draft.pendingId, () => { void saveGrants(id, draft) }))

      const preferences = document.createElement('fieldset')
      preferences.className = 'settings-card'
      const legend = document.createElement('legend')
      legend.textContent = 'Agent 环境与工具偏好'
      preferences.append(legend, section('p', options.continuousSessionId
        ? '环境选择用于新会话。连续对话可手动采用新环境，环境内的工具偏好在下一次运行时读取。'
        : '保存后，新会话将使用选中的环境和工具。'))
      preferences.disabled = draft.busy || dirty.grants || !!draft.pendingId
      const displayed = new Set([...view.targets.map(target => target.environmentId), ...view.preference.environmentIds, ...draft.picked.keys()])
      const granted = new Set(view.authorization.grants.filter(grant => available.has(environmentToolKey(grant.tool))).map(grant => grant.tool.environmentId))
      for (const env of displayed) {
        const name = names[env] ?? env, enabled = draft.environments.has(env)
        preferences.append(choice('env:' + env, name + (granted.has(env) ? '' : '（尚无当前工具授权）'), enabled, false, selected => {
          if (selected) draft.environments.add(env)
          else draft.environments.delete(env)
        }))
        if (env === 'computer') continue
        const selected = draft.picked.get(env)
        const details = group('preference:' + env, name + '的工具偏好')
        details.append(choice('all:' + env, '使用此环境中所有已授权的工具', selected === undefined, false, all => {
          if (all) draft.picked.delete(env)
          else draft.picked.set(env, new Set())
        }))
        if (selected) {
          const ids = new Set([...view.targets.filter(target => target.environmentId === env).flatMap(target => target.tools.map(tool => tool.toolId)), ...selected])
          for (const id of ids) details.append(choice(JSON.stringify(['pick', env, id]), id, selected.has(id), false, on => {
            if (on) selected.add(id)
            else selected.delete(id)
          }))
        }
        preferences.append(details)
      }
      preferences.append(button('保存环境偏好', !dirty.preference, () => {
        const input = { environmentIds: [...draft.environments], expectedVersion: view.preference.version,
          toolIdsByEnvironment: Object.fromEntries([...draft.picked].map(([env, set]) => [env, [...set]])) }
        void run(id, draft, async () => {
          await options.api(path(id) + '/preferences', input)
          await read(id, draft)
          await readSession(id, draft)
          draft.notice = '已保存环境与工具偏好。'
        }, true)
      }))
      panel.append(grants, preferences)
      if (options.continuousSessionId) {
        const adopt = section('section'); adopt.className = 'settings-card'
        adopt.append(section('h4', '当前连续对话'))
        const original = draft.session
        if (original) adopt.append(section('p', '当前环境：' + (original.selection.environmentIds.map(env => names[env] ?? env).join('、') || '无')))
        const current = original?.selection.environmentIds
        const same = current && current.length === view.preference.environmentIds.length && current.every(env => view.preference.environmentIds.includes(env))
        adopt.append(button('应用已保存的环境到后续运行', draft.busy || !original || !!same || dirty.preference || dirty.grants, () => {
          if (!original || options.continuousSessionId?.(id) !== original.id || changed(draft).preference || changed(draft).grants) return
          void run(id, draft, async () => {
            const selection = await options.api<EnvironmentSelection>('/sessions/' + encodeURIComponent(original.id) + '/environments', {
              environmentIds: view.preference.environmentIds, expectedVersion: original.selection.version, expectedGrantRevision: view.authorization.revision,
            })
            draft.session = { id: original.id, selection }; draft.notice = '新环境将用于此对话的后续运行。'
          }, true)
        }))
        if (!original) adopt.append(section('p', '打开该 Agent 的连续对话后刷新，即可查看本对话使用的环境。'))
        panel.append(adopt)
      }
    }
    const notice = section('p', draft.notice || (draft.busy ? '正在处理…' : '')); notice.setAttribute('role', 'status')
    notice.hidden = !notice.textContent
    panel.append(refresh, notice)
    if (previousFocus) {
      const next = [...panel.querySelectorAll<HTMLInputElement>('[data-control]')].find(input => input.dataset.control === previousFocus)
      next?.focus({ preventScroll: true })
    }
  }
  return {
    selectAgent(id: string, name?: string) {
      if (disposed) return
      const existing = drafts.get(id)
      if (existing && name && existing.name !== name) { existing.name = name; render() }
      if (active === id) return
      active = id
      if (id && !drafts.has(id)) {
        let pendingId: string | undefined
        try { pendingId = sessionStorage.getItem(storage(id)) || undefined } catch { /* Optional continuity. */ }
        const draft: Draft = { name, tools: new Map(), environments: new Set(), picked: new Map(), open: new Set(), busy: false, writing: false, notice: '', pendingId }
        drafts.set(id, draft)
        void reload(id, draft)
      }
      render()
    },
    refresh() {
      const draft = drafts.get(active)
      if (!draft || draft.busy) return
      const dirty = changed(draft)
      if (!dirty.grants && !dirty.preference) void reload(active, draft)
    },
    currentAgentId: () => active,
    canLeave() {
      for (const [id, draft] of drafts) {
        const dirty = changed(draft)
        if (!draft.writing && !dirty.grants && !dirty.preference) continue
        active = id; draft.notice = draft.writing ? '正在保存环境设置。' : '请先保存环境设置，或放弃修改并重新读取。'
        render(); return false
      }
      return true
    },
    dispose() { disposed = true; drafts.clear(); panel.replaceChildren() },
  }
}

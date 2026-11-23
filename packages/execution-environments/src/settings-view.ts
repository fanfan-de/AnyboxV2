import { environmentToolKey, targetKey } from './contracts.js'
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
  targeted: Map<string, Set<string>>
  connections?: readonly McpConnection[]
  newConnection: { transport: 'http' | 'stdio'; name: string; endpoint: string; command: string; args: string; cwd: string }
  open: Set<string>
  session?: { id: string; selection: EnvironmentSelection }
  change?: GrantChange
  pendingId?: string
  writing: boolean
  busy: boolean
  notice: string
}
type McpConnection = {
  readonly id: string
  readonly name: string
  readonly status: 'unverified' | 'ready' | 'unavailable' | 'disabled'
  readonly toolCount: number
  readonly error?: string
} & ({ readonly transport?: 'http'; readonly endpoint: string } | { readonly transport: 'stdio'; readonly command: string })
const newConnectionDraft = (): Draft['newConnection'] => ({ transport: 'http', name: '', endpoint: '', command: '', args: '', cwd: '' })
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
const names: Readonly<Record<string, string>> = { computer: 'Computer', mcp: 'MCP', 'model-search': '模型提供方搜索' }
const connectionStatus = { unverified: '尚未发现工具', ready: '可用', unavailable: '不可用', disabled: '已停用' }
const connectionErrors = new Map([
  ['mcp-invalid-connection', '连接信息无效，请检查连接配置。'],
  ['mcp-invalid-endpoint', '请输入 HTTPS 地址，回环地址可以使用 HTTP。'],
  ['mcp-invalid-stdio', '请输入执行设备上的绝对路径，并检查参数与工作目录。'],
  ['mcp-stdio-unavailable', '此执行端的本地进程管理不可用。'],
  ['mcp-stdio-already-connected', '已有连接使用此启动配置。'],
  ['mcp-endpoint-already-connected', '已有连接使用此地址。'],
  ['mcp-connection-limit', '此执行端的 MCP 连接已达到上限。'],
  ['mcp-connection-not-found', '当前连接不存在，请刷新连接状态。'],
  ['mcp-connection-unavailable', '当前 MCP 连接不可用。'],
  ['mcp-connection-conflict', '连接已被修改或正在处理，请刷新连接状态。'],
  ['mcp-authentication-required', '该 Server 要求认证。'],
  ['mcp-incompatible-server', '该 Server 的协议版本或工具能力不兼容。'],
  ['mcp-invalid-tool-list', '该 Server 返回了无法识别的工具目录。'],
  ['mcp-catalog-too-large', '该 Server 的工具目录超出上限。'],
  ['mcp-unavailable', '无法读取 MCP Server 的工具目录。'],
  ['mcp-exit-unknown', '部分调用的实际退出尚未确认。'],
  ['mcp-stdio-exit-unknown', 'stdio 进程树的实际退出尚未确认。'],
])
const stateName = { draining: '权限已更新，正在等待已接纳的操作退出。', completed: '授权变更已完成。', 'exit-unknown': '已禁止新调用，部分操作的退出尚未确认。' }
function progress(change: GrantChange) {
  return change.affectedCount ? stateName[change.state] + ` 影响 ${change.affectedCount} 项操作，等待退出 ${change.pendingCount} 项，退出未知 ${change.unknownCount} 项。` : stateName[change.state]
}
function sameTools(picked: ReadonlyMap<string, ReadonlySet<string>>, saved?: Readonly<Record<string, readonly string[]>>) {
  const entries = Object.entries(saved ?? {})
  return picked.size === entries.length && entries.every(([env, ids]) => {
    const selection = picked.get(env)
    return selection?.size === ids.length && ids.every(id => selection.has(id))
  })
}
function targetEnvironment(key: string): string {
  return (JSON.parse(key) as [string, string])[0]
}

function selectedTargetKeys(selection: EnvironmentSelection, includeEmpty = false) {
  return Object.entries(selection.toolIdsByTarget ?? {}).filter(([key, ids]) =>
    (includeEmpty || ids.length > 0) && selection.environmentIds.includes(targetEnvironment(key))).map(([key]) => key)
}

function sameSelection(left: EnvironmentSelection, right: EnvironmentSelection) {
  const targets = selectedTargetKeys(left, true), expectedTargets = selectedTargetKeys(right)
  return left.environmentIds.length === right.environmentIds.length && left.environmentIds.every(id => right.environmentIds.includes(id)) &&
    targets.length === expectedTargets.length && targets.every(key => expectedTargets.includes(key))
}

function toolLabel(environmentId: string, toolId: string) {
  return environmentId === 'mcp' ? toolId.replace(/^mcp\.[0-9a-f-]{36}\./, '') : toolId
}

function changed(draft: Draft): { grants: boolean; preference: boolean } {
  const view = draft.view
  if (!view) return { grants: false, preference: false }
  return {
    grants: draft.tools.size !== view.authorization.grants.length || view.authorization.grants.some(grant => !draft.tools.has(environmentToolKey(grant.tool))),
    preference: !sameTools(draft.picked, view.preference.toolIdsByEnvironment) || !sameTools(draft.targeted, view.preference.toolIdsByTarget) ||
      draft.environments.size !== view.preference.environmentIds.length || view.preference.environmentIds.some(id => !draft.environments.has(id)),
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
    try { await work() } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? error.code : undefined
      draft.notice = (typeof code === 'string' ? connectionErrors.get(code) : undefined) ?? options.messageFor(error)
    }
    finally { draft.busy = false; draft.writing = false; if (id === active) render() }
  }
  async function read(id: string, draft: Draft) {
    const view = await options.api<EnvironmentAccessView>(path(id))
    if (disposed) return
    draft.view = view
    if (!view.mcpStdio) draft.newConnection.transport = 'http'
    draft.tools = new Map(view.authorization.grants.map(grant => [environmentToolKey(grant.tool), grant.tool]))
    draft.environments = new Set(view.preference.environmentIds)
    draft.picked = new Map(Object.entries(view.preference.toolIdsByEnvironment ?? {}).map(([env, ids]) => [env, new Set(ids)]))
    draft.targeted = new Map(Object.entries(view.preference.toolIdsByTarget ?? {}).map(([key, ids]) => [key, new Set(ids)]))
    if (view.mcpManagement) {
      const connections = await options.api<readonly McpConnection[]>('/mcp-connections')
      if (!disposed) draft.connections = connections
    } else draft.connections = undefined
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
  function manageConnection(id: string, draft: Draft, path: string, input: object, creating = false) {
    return run(id, draft, async () => {
      let connection: McpConnection
      try { connection = await options.api<McpConnection>(path, input) }
      catch (error) { await read(id, draft).catch(() => {}); throw error }
      if (creating) draft.newConnection = newConnectionDraft()
      await read(id, draft)
      await readSession(id, draft)
      draft.notice = connection.name + ' · ' + connectionStatus[connection.status]
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
      if (view.mcpManagement) {
        const settings = section('section'); settings.className = 'settings-card'
        settings.append(section('h4', 'MCP 连接'))
        const locked = draft.busy || dirty.grants || dirty.preference || !!draft.pendingId
        for (const connection of draft.connections ?? []) {
          const row = section('div')
          row.append(section('strong', connection.name), section('p', connection.transport === 'stdio' ? 'stdio · ' + connection.command : connection.endpoint),
            section('small', connectionStatus[connection.status] + (connection.status === 'ready' ? ` · ${connection.toolCount} 个工具` : '')))
          if (connection.error) row.append(section('small', connectionErrors.get(connection.error) ?? '可更新连接状态后再次发现工具。'))
          const path = '/mcp-connections/' + encodeURIComponent(connection.id)
          if (connection.status !== 'disabled') row.append(
            button('发现工具 · ' + connection.name, locked, () => { void manageConnection(id, draft, path + '/refresh', {}) }),
            button('停用 · ' + connection.name, locked, () => { void manageConnection(id, draft, path + '/disable', {}) }),
          )
          settings.append(row)
        }
        const connection = draft.newConnection
        const field = (key: 'name' | 'endpoint' | 'command' | 'cwd', title: string, type = 'text') => {
          const label = document.createElement('label'), input = document.createElement('input')
          input.type = type; input.value = connection[key]; input.disabled = locked; input.dataset.control = 'mcp:' + key
          input.addEventListener('input', () => { connection[key] = input.value })
          label.append(section('span', title), input)
          settings.append(label)
        }
        field('name', '连接名称')
        if (view.mcpStdio) {
          const transportLabel = document.createElement('label'), transport = document.createElement('select')
          for (const [value, label] of [['http', 'Streamable HTTP'], ['stdio', 'stdio（执行设备上的进程）']] as const) {
            const option = document.createElement('option')
            option.value = value; option.textContent = label
            transport.append(option)
          }
          transport.value = connection.transport; transport.disabled = locked; transport.dataset.control = 'mcp:transport'
          transport.addEventListener('change', () => { connection.transport = transport.value === 'stdio' ? 'stdio' : 'http'; render() })
          transportLabel.append(section('span', '传输方式'), transport)
          settings.append(transportLabel)
        }
        if (connection.transport === 'stdio') {
          field('command', '可执行文件的绝对路径')
          const argsLabel = document.createElement('label'), args = document.createElement('textarea')
          args.value = connection.args; args.disabled = locked; args.dataset.control = 'mcp:args'
          args.rows = 2; args.placeholder = '["/path/to/server.js"]'
          args.addEventListener('input', () => { connection.args = args.value })
          argsLabel.append(section('span', '参数（JSON 字符串数组，可留空）'), args)
          settings.append(argsLabel)
          field('cwd', '工作目录的绝对路径（可选）')
        } else field('endpoint', 'Streamable HTTP 地址', 'url')
        settings.append(button('添加 MCP 连接', locked, () => {
          const name = connection.name.trim()
          if (connection.transport === 'http') {
            const endpoint = connection.endpoint.trim()
            if (!name || !endpoint) { draft.notice = '请输入连接名称和地址。'; render(); return }
            void manageConnection(id, draft, '/mcp-connections', { name, endpoint }, true)
            return
          }
          const command = connection.command.trim(), cwd = connection.cwd.trim()
          if (!name || !command) { draft.notice = '请输入连接名称和可执行文件路径。'; render(); return }
          let args: unknown
          try { args = JSON.parse(connection.args.trim() || '[]') } catch { /* Invalid JSON is reported with other invalid argument lists. */ }
          if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
            draft.notice = '参数必须是 JSON 字符串数组。'; render(); return
          }
          void manageConnection(id, draft, '/mcp-connections', { name, transport: 'stdio', command, args, ...(cwd ? { cwd } : {}) }, true)
        }))
        panel.append(settings)
      }
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
          const label = toolLabel(tool.environmentId, tool.toolId) + (tool.environmentId === 'mcp' ? '' : ' · ' + tool.version.split('@')[0])
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
      const displayed = new Set([...view.targets.map(target => target.environmentId), ...view.preference.environmentIds, ...draft.picked.keys(),
        ...[...draft.targeted.keys()].map(targetEnvironment), ...(view.mcpManagement ? ['mcp'] : [])])
      const granted = new Set(view.authorization.grants.filter(grant => available.has(environmentToolKey(grant.tool))).map(grant => grant.tool.environmentId))
      for (const env of displayed) {
        const name = names[env] ?? env, enabled = draft.environments.has(env)
        preferences.append(choice('env:' + env, name + (granted.has(env) ? '' : '（尚无当前工具授权）'), enabled, false, selected => {
          if (selected) draft.environments.add(env)
          else draft.environments.delete(env)
        }))
        if (env === 'computer') continue
        const availableTargets = new Map(view.targets.filter(target => target.environmentId === env && target.selectionId !== undefined)
          .map(target => [targetKey(env, target.selectionId!), target]))
        const targetKeys = new Set([...availableTargets.keys(), ...[...draft.targeted.keys()].filter(key => targetEnvironment(key) === env)])
        if (targetKeys.size || env === 'mcp') {
          for (const key of targetKeys) {
            const target = availableTargets.get(key)
            const selected = draft.targeted.get(key) ?? new Set<string>()
            const offered = new Set(target?.tools.map(tool => tool.toolId) ?? [])
            const label = target?.name ?? (JSON.parse(key) as [string, string])[1]
            const details = group('preference:target:' + key, label + '的工具偏好')
            for (const toolId of new Set([...offered, ...selected])) details.append(choice(JSON.stringify(['pick-target', key, toolId]),
              toolLabel(env, toolId) + (offered.has(toolId) ? '' : '（不可用）'), selected.has(toolId), false, on => {
                if (on) selected.add(toolId)
                else selected.delete(toolId)
                if (selected.size) draft.targeted.set(key, selected)
                else draft.targeted.delete(key)
              }))
            preferences.append(details)
          }
          continue
        }
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
          toolIdsByEnvironment: Object.fromEntries([...draft.picked].map(([env, set]) => [env, [...set]])),
          ...(draft.targeted.size || view.preference.toolIdsByTarget !== undefined ?
            { toolIdsByTarget: Object.fromEntries([...draft.targeted].map(([key, set]) => [key, [...set]])) } : {}) }
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
        const same = original && sameSelection(original.selection, view.preference)
        adopt.append(button('应用已保存的环境到后续运行', draft.busy || !original || !!same || dirty.preference || dirty.grants, () => {
          if (!original || options.continuousSessionId?.(id) !== original.id || changed(draft).preference || changed(draft).grants) return
          void run(id, draft, async () => {
            const selection = await options.api<EnvironmentSelection>('/sessions/' + encodeURIComponent(original.id) + '/environments', {
              environmentIds: view.preference.environmentIds, expectedVersion: original.selection.version, expectedGrantRevision: view.authorization.revision,
              ...(view.preference.toolIdsByTarget === undefined ? {} : { toolIdsByTarget: Object.fromEntries(
                selectedTargetKeys(view.preference).map(key => [key, view.preference.toolIdsByTarget![key]])) }),
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
        const draft: Draft = { name, tools: new Map(), environments: new Set(), picked: new Map(), targeted: new Map(),
          newConnection: newConnectionDraft(), open: new Set(), busy: false, writing: false, notice: '', pendingId }
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

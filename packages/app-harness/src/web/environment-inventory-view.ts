import type { ComputerEnvironment } from '../core/computer/environments.js'
import type { UnitAttachment } from '../core/unit/domain.js'
import { environmentStateLabel } from './project-directory-client.js'
import type { EnvironmentInventoryTarget } from '@anybox/execution-environments/management'

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (className) node.className = className
  return node
}

function chevron() {
  const arrow = element('span', undefined, 'environment-chevron')
  arrow.setAttribute('aria-hidden', 'true')
  return arrow
}

function identifiers(entries: readonly [string, string][]) {
  const details = element('details', undefined, 'environment-identifiers')
  const fields = element('dl')
  for (const [label, value] of entries) fields.append(element('dt', label), element('dd', value))
  details.append(element('summary', '技术标识'), fields)
  return details
}

const platformNames = new Map([['darwin', 'macOS'], ['linux', 'Linux'], ['win32', 'Windows']])
const attachmentStates: Readonly<Record<UnitAttachment['state'], string>> = { approved: '已批准', pending: '等待对方使用附着码', revoked: '已撤销' }

export function renderEnvironmentDevice(environment: ComputerEnvironment, attachment: UnitAttachment | undefined, revoke: () => void) {
  const details = element('details', undefined, 'environment-device')
  details.dataset.attachmentId = environment.environmentId
  const local = environment.origin === 'local'
  const platform = environment.platform && (platformNames.get(environment.platform) ?? environment.platform)
  const name = local ? '本机（默认）' : platform ? platform + ' 电脑' : '远端电脑'
  const title = element('span', undefined, 'environment-device-name')
  title.append(element('strong', name))
  const description = [local ? platform : '远端', environment.architecture, local ? undefined : environment.environmentId.slice(0, 8)].filter(Boolean).join(' · ')
  if (description) title.append(element('small', description))
  const summary = element('summary', undefined, 'environment-summary')
  const icon = element('span', undefined, 'environment-device-icon')
  icon.setAttribute('aria-hidden', 'true')
  const state = element('span', environmentStateLabel(environment), 'execution-environment-status')
  state.dataset.state = environment.connectionState
  const support = environment.toolSupport
  if (support?.state === 'reported') title.append(element('small', `Worker 已报告 ${support.manifest.tools.length} 项工具`))
  summary.append(icon, title, state, chevron())

  const body = element('div', undefined, 'environment-device-body')
  const fields = element('dl', undefined, 'environment-device-fields')
  fields.append(element('dt', '接入状态'), element('dd', attachmentStates[environment.state]))
  const scope = attachment?.scope ?? attachment?.requestedScope
  if (scope?.kind === 'computer') {
    const requested = environment.state === 'pending'
    fields.append(element('dt', requested ? '申请的目录' : '目录范围'), element('dd', scope.projects === 'all' ? '不限' : scope.projects.join('、') || '无'),
      element('dt', requested ? '申请的工具' : '工具范围'), element('dd', scope.tools === 'all' ? '不限' : scope.tools.join('、') || '无'))
  }
  if (support?.state === 'reported' && support.manifest.tools.length) {
    const tools = element('ul', undefined, 'environment-reported-tools')
    for (const tool of support.manifest.tools) tools.append(element('li', tool.toolId))
    const value = element('dd')
    value.append(tools)
    fields.append(element('dt', '工具报告'), value)
  } else {
    fields.append(element('dt', '工具报告'), element('dd', support?.state === 'reported' ? '报告中没有工具' : 'Worker 尚未报告工具'))
  }
  const identity: [string, string][] = [['环境 ID', environment.environmentId]]
  if (environment.unitId) identity.push(['设备 ID', environment.unitId])
  if (attachment) identity.push(['授权代次', String(attachment.epoch)])
  body.append(fields, element('p', '命令以这台电脑的系统账户运行。目录范围仅用于工具授权，系统账户的文件访问权限仍然适用。', 'settings-hint'), identifiers(identity))
  if (!local && environment.state !== 'revoked') {
    const button = element('button', '撤销附着', 'secondary-button')
    button.type = 'button'
    button.addEventListener('click', revoke)
    body.append(button)
  }
  details.append(summary, body)
  return details
}

const sourceTypes = new Map([
  ['computer', '电脑工具'],
  ['mcp', 'MCP 连接'],
  ['model-search', '模型提供方搜索'],
])

export function renderEnvironmentTarget(target: EnvironmentInventoryTarget): HTMLDetailsElement {
  const grantsByTool = new Map<string, string[]>()
  for (const tool of target.tools) grantsByTool.set(tool.toolId, [])
  let agentCount = 0
  for (const agent of target.agents) {
    let authorized = false
    for (const id of new Set(agent.toolIds)) {
      const grants = grantsByTool.get(id)
      if (grants) {
        grants.push(agent.name || agent.id)
        authorized = true
      }
    }
    if (authorized) agentCount++
  }

  const details = element('details', undefined, 'environment-target')
  const kind = sourceTypes.get(target.environmentId)
  const name = target.name === target.environmentId && kind ? kind : target.name
  const summary = element('summary', undefined, 'environment-summary')
  const label = element('span', undefined, 'environment-target-name')
  label.append(element('strong', name))
  if (kind && kind !== name) label.append(element('small', kind, 'environment-kind'))
  const counts = element('span', `${grantsByTool.size} 项工具 · ${agentCount} 个已授权 Agent`, 'environment-counts')
  summary.append(label, counts, chevron())

  const table = element('table', undefined, 'environment-tools')
  const head = element('thead'), heading = element('tr')
  for (const title of ['工具 ID', '已授权 Agent']) {
    const column = element('th', title)
    column.scope = 'col'
    heading.append(column)
  }
  head.append(heading)
  const rows = element('tbody')
  for (const [toolId, agents] of grantsByTool) {
    const row = element('tr'), tool = element('th', toolId)
    tool.scope = 'row'
    row.append(tool, element('td', agents.length ? agents.join('、') : '未授权'))
    rows.append(row)
  }
  table.append(head, rows)

  const body = element('div', undefined, 'environment-target-body')
  body.append(table, identifiers([['环境 ID', target.environmentId], ['目标 ID', target.targetId]]))
  details.append(summary, body)
  return details
}

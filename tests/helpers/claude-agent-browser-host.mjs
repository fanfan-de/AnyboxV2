/**
 * Isolated, disposable Claude Agent browser QA fixture. The real published web app
 * mounts against an in-memory gateway; all projects, transcripts, approvals and
 * model answers are invented. An optional --model-catalog JSON file can supply a
 * previously captured, nonsecret model list for visual review; it never queries
 * a real Claude environment itself. It never opens a project, database, credential store,
 * Claude process or external connection. Only registered static assets are read.
 * Build first, then run: node tests/helpers/claude-agent-browser-host.mjs
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { claudeAgentDefinition } from '../../packages/app-claude-agent/dist/definition.js'
import { claudeAgentAssets } from '../../packages/app-claude-agent/dist/client/assets.js'
import { shellAssets } from '../../packages/host/dist/assets.js'
import { availableModelsView } from '../../packages/app-claude-agent/dist/core/sdk/models.js'

const { values } = parseArgs({ options: { port: { type: 'string', default: '0' }, 'model-catalog': { type: 'string' } } })
const port = Number(values.port)
if (!/^\d+$/.test(values.port) || !Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('--port must be an integer from 0 to 65535')

const apiBase = '/api/client/v1/apps/claude-agent', appBase = '/apps/claude-agent', instanceId = 'qa-local'
const assets = new Map([...shellAssets, ...claudeAgentAssets].map(asset => [asset.path, asset]))
const modelCatalog = values['model-catalog']
  ? availableModelsView(JSON.parse(await readFile(values['model-catalog'], 'utf8')).models)
  : availableModelsView([
    { value: 'claude-sonnet', displayName: 'Claude Sonnet', description: '界面验收模拟模型 · 日常编码与分析' },
    { value: 'claude-opus', displayName: 'Claude Opus', description: '界面验收模拟模型 · 复杂任务与深入推理' },
  ])
const now = () => new Date().toISOString(), ago = minutes => new Date(Date.now() - minutes * 60_000).toISOString()
const text = value => ({ kind: 'text', text: value, truncated: false })
const thinking = value => ({ kind: 'thinking', text: value, truncated: false })
const tool = (id, name, input) => ({ kind: 'tool_use', toolUseId: id, name, input, inputTruncated: false })
const output = (id, value, isError = false) => ({ kind: 'tool_result', toolUseId: id, text: value, isError, truncated: false })
const message = (id, role, ...blocks) => ({ id, role, blocks })
const sampleResult = value => ({ subtype: 'success', isError: false, durationMs: 8400, durationApiMs: 6200, numTurns: 3, totalCostUsd: 0.034,
  usage: { inputTokens: 1280, outputTokens: 436, cacheReadInputTokens: 2400, cacheCreationInputTokens: 0 }, stopReason: 'end_turn', text: value })
const fixtureAssets=new Map(),fixtureInputs=new Map()
const threads = new Map(), histories = new Map(), runs = new Map(), views = new Map(), approvals = new Map(), connections = new Map()
const sessionGrants = new Map([['review', [{ id: 'grant-review', rules: ['Bash(npm run check:*)'], createdAt: '2026-10-18T00:00:00.000Z' }]]]);
const streams = new Map(), timers = new Set()
let nextId = 0, closing = false, productEnabled = true
// Only Claude Agent is installed in this disposable host. Use the real shell's public product shape.
const productView = () => ({
  definition: { ...claudeAgentDefinition, runtime: true, http: true, web: { entry: '/applications/claude-agent/web/app.js', styles: ['/apps/claude-agent/style.css'] } },
  desiredEnabled: productEnabled, state: productEnabled ? 'running' : 'disabled',
  capabilities: [
    { id: 'storage.sqlite', range: '^1.0.0', required: true, status: 'ready', version: '1.0.0' },
    { id: 'system.directory-picker', range: '^1.0.0', required: false, status: 'ready', version: '1.0.0' },
  ],
})
const instanceView = () => ({ instanceId, name: '界面验收设备', apiVersion: 1, capabilities: ['products.v2', 'claude-agent.v1', 'sse'] })
const later = (callback, ms) => { const timer = setTimeout(() => { timers.delete(timer); callback() }, ms); timers.add(timer); return timer }
const seed = (id, projectPath, title, minutes, history = [], status = 'completed') => {
  const time = ago(minutes), runId = `run-${id}`
  const thread = { schemaVersion: 1, id, projectPath, title, titleSource: 'user', nativeSessionId: `session-${id}`, createdAt: time, updatedAt: time,
    lastRun: history.length || status === 'running' ? { id: runId, status } : null, pendingApprovals: status === 'running' ? 1 : 0 }
  threads.set(id, thread); histories.set(id, history)
  if (thread.lastRun) {
    const run = { schemaVersion: 1, id: runId, threadId: id, status, prompt: history.find(item => item.role === 'user')?.blocks[0]?.text ?? '检查发布前的构建结果。',
      model: null, resolvedModel: 'claude-sonnet', effort: null, nativeSessionId: thread.nativeSessionId, createdAt: time,
      finishedAt: status === 'running' ? null : time, result: status === 'running' ? null : sampleResult('演示任务已完成。'), error: null }
    runs.set(runId, run)
  }
  return thread
}
const reviewAnswer = `## 界面审查已完成

当前最影响使用的，是**项目选择占据了常驻侧栏**、会话导航不清晰，以及工具输出打断阅读。建议优先处理下面三项：

1. **让项目选择按需出现**：用“新建会话”打开独立面板，保留最近项目入口。
2. **把会话组织清楚**：按项目分组，提供搜索，并区分运行中、待审批和完成状态。
3. **让结果更容易阅读**：正文支持 Markdown，思考和工具过程收进可展开的摘要。

| 区域 | 调整 | 用户收益 |
| --- | --- | --- |
| 左侧导航 | 项目分组与会话搜索 | 更快找回工作 |
| 消息区域 | 稳定阅读宽度与代码块 | 减少横向扫读 |
| 输入区域 | 项目、模型、强度合并到工具栏 | 发消息更直接 |

### 建议的验证顺序

~~~bash
npm run check
~~~

先检查新建会话、审批和长历史滚动，再验证窄窗口下的侧栏与输入框。可以参考 [Claude Code 官方文档](https://code.claude.com/docs/en/desktop)。

这份内容来自隔离的界面演示夹具，未读取或修改任何真实项目。`
seed('review', '/demo/AnyboxV2', '优化 Claude Agent 的工作界面', 1, [
  message('review-user', 'user', text('帮我审查一下 Claude 应用的前端，先找出影响可用性的关键问题。')),
  message('review-thinking', 'assistant', thinking('先梳理项目选择、会话导航、阅读与发送四条主要路径，再按用户完成任务的频率排序。')),
  message('review-tool', 'assistant', tool('inspect-view', 'Read', { file_path: 'packages/app-claude-agent/src/web/app.ts', limit: 120 })),
  message('review-result', 'assistant', output('inspect-view', '已读取界面结构：项目选择、会话列表、消息区、审批区与输入框。\n这是演示输出，没有读取真实文件。')),
  message('review-answer', 'assistant', text(reviewAnswer)),
])
seed('tests', '/demo/AnyboxV2', '梳理发布前的测试流程', 26, [
  message('tests-user', 'user', text('介绍一下发布前需要运行的检查。')),
  message('tests-answer', 'assistant', text('先运行 `npm run check`，它会完成类型检查与行为测试。\n\n- 验证应用独立构建\n- 验证取消与清理行为\n- 验证浏览器资产与依赖闭包\n\n这是演示说明，没有执行任何命令。')),
])
seed('docs', '/demo/AnyboxV2', '整理应用开发文档', 140, [message('docs-user', 'user', text('整理一下应用开发的文档入口。')), message('docs-answer', 'assistant', text('建议从 `docs/README.md` 开始，再阅读应用开发与包管理的模块手册。'))])
seed('approval', '/demo/AnyboxV2', '检查构建结果', 3, [], 'running')
seed('design', '/demo/DesignKit', '检查组件的交互状态', 65, [message('design-user', 'user', text('检查组件在不同状态下的可用性。')), message('design-answer', 'assistant', text('## 检查范围\n\n- 默认、悬停与键盘焦点\n- 加载、禁用与失败\n- 窄窗口与长内容\n\n建议优先确认每个按钮都提供明确的动作与反馈。'))])
seed('architecture', '/demo/NyaCore', '理解组件的生命周期', 380, [message('architecture-user', 'user', text('解释一下组件清理与依赖撤销的关系。')), message('architecture-answer', 'assistant', text('组件先停止接收新工作，再等待在途操作退出，最后释放自己的资源。\n\n> 关闭完成应表示资源已实际退出。'))])
const longHistory = Array.from({ length: 40 }, (_, index) => [
  message(`long-user-${index}`, 'user', text(`第 ${index + 1} 轮：继续审查这一部分的交互。`)),
  message(`long-assistant-${index}`, 'assistant', text(`### 第 ${index + 1} 轮检查\n\n这一轮重点检查**导航清晰度**与反馈的一致性。用户需要知道自己在哪个项目、当前任务是否完成，以及下一步可以做什么。\n\n- 给主要动作保留稳定的位置\n- 在失败时保留输入与恢复入口\n- 在长历史中保持输入框可见\n\n**view-${index + 1}.ts** 的检查记录已整理，接下来可以继续验证键盘操作。`)),
]).flat()
seed('history', '/demo/DesignKit', '长会话：逐轮交互审查', 120, longHistory)

const approval = { schemaVersion: 1, id: 'approval-build', runId: 'run-approval', threadId: 'approval', toolUseId: 'build-command', toolName: 'Bash', kind: 'permission',
  rememberRules: ['addRules · allow · Bash(npm run check:*)'], blockedPath: null, rememberUnavailableReason: null,
  title: '允许 Claude 运行构建检查？', description: 'Claude 想检查这个项目的构建结果。', reason: '需要运行项目定义的检查命令，确认当前变更可以构建。',
  input: { command: 'npm run check', description: '运行类型检查与行为测试' }, inputTruncated: false, questions: null,
  allowSessionAvailable: true, defaultToNo: true, requestedAt: ago(2), decision: null, answers: null, resolvedAt: null }
approvals.set(approval.id, approval)
views.set('run-approval', { schemaVersion: 1, runId: 'run-approval', threadId: 'approval', seq: 2,
  init: { nativeSessionId: 'session-approval', model: 'claude-sonnet', cwd: '/demo/AnyboxV2', permissionMode: 'default', claudeCodeVersion: 'qa', toolCount: 3 },
  items: [{ id: 'approval-plan', role: 'assistant', blocks: [{ block: text('我会先运行项目的检查流程，再整理构建结果。这个操作需要你的确认。'), state: 'final' }] }],
  approvals: [approval], notices: [], modelStatus: null, result: null, error: null })

const directoryTree = new Map([
  ['/demo', ['AnyboxV2', 'DesignKit', 'NyaCore']], ['/demo/AnyboxV2', ['docs', 'packages', 'scripts', 'tests']],
  ['/demo/AnyboxV2/packages', ['app-claude-agent', 'app-harness', 'host']], ['/demo/DesignKit', ['components', 'tokens']], ['/demo/NyaCore', ['packages', 'tests']],
])
for (const [path, names] of [...directoryTree]) for (const name of names) if (!directoryTree.has(`${path}/${name}`)) directoryTree.set(`${path}/${name}`, [])

const emit = (threadId, event, data) => {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const [response, target] of streams) if (target === threadId && !response.destroyed) response.write(frame)
}
const runChanged = run => emit(run.threadId, 'run-changed', { threadId: run.threadId, runId: run.id, status: run.status, seq: views.get(run.id)?.seq ?? 0 })
const finishRun = (run, answer, status = 'completed') => {
  if (run.status !== 'running' && run.status !== 'cancelling') return
  run.status = status; run.finishedAt = now(); run.result = sampleResult(answer)
  const thread = threads.get(run.threadId)
  if (!thread) return
  thread.lastRun = { id: run.id, status }; thread.pendingApprovals = 0; thread.updatedAt = now()
  const current = histories.get(run.threadId) ?? []
  if (!current.some(item => item.id === `${run.id}-prompt`)) current.push(message(`${run.id}-prompt`, 'user', text(run.prompt)))
  current.push(message(`${run.id}-answer`, 'assistant', text(answer))); histories.set(run.threadId, current)
  const view = views.get(run.id)
  if (view) { view.approvals = []; view.result = run.result; view.seq++ }
  runChanged(run)
}
const json = (response, data, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(data)) }
const failure = (response, code, status = 404) => json(response, { error: { code } }, status)
const readBody = async request => {
  let source = ''
  for await (const chunk of request) { source += chunk; if (source.length > 1_048_576) throw new RangeError('Fixture request too large') }
  return source ? JSON.parse(source) : {}
}
const productControl = (response, action) => {
  // The fixture follows the real product's busy guard; stopping never cancels a Run.
  if (action === 'stop' && [...runs.values()].some(run => run.status === 'running' || run.status === 'cancelling')) return failure(response, 'product-busy', 409)
  productEnabled = action !== 'stop'
  return json(response, productView())
}
const gateway = async (request, response, url, path) => {
  const post = request.method === 'POST', body = post ? await readBody(request) : {}
  if (path === '/instance' && !post) return json(response, instanceView())
  const productRoute = /^\/products\/claude-agent(?:\/(open|stop|retry))?$/.exec(path)
  if (productRoute) {
    if (post && productRoute[1]) return productControl(response, productRoute[1])
    if (!post && !productRoute[1]) return json(response, productView())
    return failure(response, 'not-found')
  }
  if (!productEnabled) return failure(response, 'product-unavailable', 503)
  if (!path.startsWith(appBase)) return failure(response, 'not-found')
  path = path.slice(appBase.length)
  if (path === '/environment') return json(response, { schemaVersion: 1, platform: 'darwin', executable: { path: '/demo/bin/claude', source: 'override' } })
  if (path === '/models') {
    if (post || [...url.searchParams.keys()].some(key => key !== 'cwd') || url.searchParams.getAll('cwd').length > 1) return failure(response, 'invalid-input', 400)
    const cwd = url.searchParams.get('cwd')
    if (cwd && !directoryTree.has(cwd)) return failure(response, 'project-path-missing')
    return json(response, modelCatalog)
  }
  if (path === '/models/recent') return json(response, { schemaVersion: 1, models: ['claude-sonnet', 'claude-opus'] })
  const capabilityCatalog = source => ({ schemaVersion: 1, source, permissionMode: 'default',
    skills: [{ name: 'review', description: '审查代码变更，按影响程度整理发现与建议。', argumentHint: '<目标或提交>', builtin: false }, { name: 'test', description: '运行项目检查，定位失败原因并汇报结果。', argumentHint: '<范围>', builtin: false }],
    mcp: [{ name: 'project-files', status: 'connected', source: 'project', tools: ['read_file', 'list_directory'] }, { name: 'design-library', status: 'needs-auth', source: 'user', tools: [] }],
    agents: [{ name: 'Explore', description: '快速查找文件、理解代码结构与依赖。', model: 'haiku' }, { name: 'Plan', description: '拆解复杂任务并制定实现计划。', model: null }] })
  if (path === '/capabilities') return json(response, capabilityCatalog('project'))
  if (path === '/account') return json(response, { schemaVersion: 1, checkedAt: now(), account: { email: 'preview@example.com', organization: null, subscription: 'max', provider: 'firstParty' }, accountError: null,
    quotas: { status: 'available', reason: null, fiveHour: { usedPercent: 23, resetsAt: new Date(Date.now() + 38 * 60_000).toISOString() }, weekly: { usedPercent: 61, resetsAt: new Date(Date.now() + 2 * 86400_000 + 4 * 3600_000).toISOString() } } })
  if (path === '/projects/recent') return json(response, { schemaVersion: 1, partial: false, projects: ['/demo/AnyboxV2', '/demo/DesignKit', '/demo/NyaCore'].map((path, index) => ({ path, name: path.split('/').at(-1), lastUsedAt: ago(index * 90), source: 'both' })) })
  if (path === '/directories') {
    const requested = url.searchParams.get('path') || '~', target = requested === '~' || requested === '~/' ? '/demo' : requested.replace(/^~\//, '/demo/').replace(/\/$/, '')
    if (!target.startsWith('/')) return failure(response, 'project-path-invalid', 400)
    const names = directoryTree.get(target)
    if (!names) return failure(response, 'project-path-missing')
    return json(response, { schemaVersion: 1, path: target, parent: target === '/demo' ? null : target.slice(0, target.lastIndexOf('/')), entries: names.map(name => ({ name, path: `${target}/${name}` })), truncated: false })
  }
  if (path === '/events') {
    const id = url.searchParams.get('threadId')
    if (!threads.has(id)) return failure(response, 'thread-not-found')
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    response.write('event: ready\ndata: {}\n\n'); streams.set(response, id)
    const keepalive = setInterval(() => { if (!response.destroyed) response.write(': fixture keepalive\n\n') }, 15_000)
    response.once('close', () => { streams.delete(response); clearInterval(keepalive) }); return
  }
  if(path==='/attachments'&&post){const id=crypto.randomUUID(),value={id,name:body.name,mime:body.mime,size:body.size,received:0,ready:false};fixtureAssets.set(id,value);return json(response,value,201)}
  const asset=/^\/attachments\/([^/]+)\/(chunks|discard)$/.exec(path)
  if(asset&&post){const value=fixtureAssets.get(asset[1]);if(!value)return failure(response,'attachment-not-found');if(asset[2]==='discard'){fixtureAssets.delete(asset[1]);return json(response,{ok:true})}value.received+=Buffer.from(body.data,'base64').length;value.ready=value.received===value.size;return json(response,value)}
  const queued=/^\/runs\/([^/]+)\/messages(?:\/([^/]+)\/cancel)?$/.exec(path)
  if(queued){const run=runs.get(queued[1]);if(!run)return failure(response,'run-not-found');const messages=fixtureInputs.get(run.id)??[];fixtureInputs.set(run.id,messages);if(!post)return json(response,messages);let value;if(queued[2]){value=messages.find(x=>x.id===queued[2]);if(value)value.status='cancelled'}else{value={id:crypto.randomUUID(),runId:run.id,prompt:body.prompt,attachments:(body.attachmentIds??[]).map(id=>fixtureAssets.get(id)),status:'queued',createdAt:now()};messages.push(value)}let view=views.get(run.id);if(!view){view={schemaVersion:1,runId:run.id,threadId:run.threadId,seq:0,init:null,items:[],approvals:[],notices:[],modelStatus:null,result:null,error:null};views.set(run.id,view)}view.inputs=messages;view.toolProgress=[{id:'demo-tool',name:'Bash',elapsedSeconds:8,parentToolUseId:null}];view.seq++;emit(run.threadId,'run-event',{threadId:run.threadId,runId:run.id,seq:view.seq,event:{type:'input',message:value}});return json(response,value??{ok:true},202)}
  const native=/^\/threads\/([^/]+)\/native-sessions$/.exec(path)
  if(native)return json(response,post?threads.get(native[1]):[{sessionId:'demo-import',title:'Claude 环境中的示例会话',updatedAt:now()}],post?201:200)
  if (path === '/threads') {
    if (!post) return json(response, [...threads.values()].sort((first, second) => second.updatedAt.localeCompare(first.updatedAt)))
    const directory = typeof body.projectPath === 'string' ? body.projectPath : '/demo/AnyboxV2'
    if (!directoryTree.has(directory)) return failure(response, 'project-path-missing')
    return json(response, seed(`new-${++nextId}`, directory, body.title || directory.split('/').at(-1), 0, []), 201)
  }
  const workspaceRoute = /^\/threads\/([^/]+)\/(context|options|interactions|agents|agents\/([^/]+)\/messages|file|checkpoints|rewind|manage|mcp\/connect|mcp\/jobs|mcp\/jobs\/([^/]+))$/.exec(path)
  if (workspaceRoute) {
    const [, id, part, agentId, jobId] = workspaceRoute, thread = threads.get(id)
    if (!thread) return failure(response, 'thread-not-found')
    if (part === 'context') return json(response, { schemaVersion: 1, model: 'claude-sonnet', totalTokens: 32140, maxTokens: 200000, percentage: 16.07, estimated: url.searchParams.get('detail')!=='full',details:url.searchParams.get('detail')==='full'?[{group:'记忆文件',name:'CLAUDE.md',tokens:1260},{group:'MCP 工具',name:'project-files / read_file',tokens:520}]:undefined, categories: [{ name: '系统提示词', tokens: 3420, kind: 'used' }, { name: '对话消息', tokens: 22450, kind: 'used' }, { name: '工具', tokens: 6270, kind: 'used' }, { name: '剩余空间', tokens: 167860, kind: 'free' }] })
    if (part === 'options') { thread.options = body; return json(response, thread) }
    if (part === 'mcp/jobs') return json(response, [])
    if (part === 'interactions') return json(response, [])
    if (part === 'agents') return json(response, ['explore-auth', 'review-implementation'])
    if (agentId) return json(response, { messages: [message('child-1', 'user', text('检查认证边界。')), message('child-2', 'assistant', text('## 检查结果\n\n凭据保留在执行设备，没有进入浏览器历史。'))], hasMore: false })
    if (part === 'file') return json(response, { path: '/demo/AnyboxV2/src/auth.ts', contents: '// 隔离界面夹具中的示例文件\nexport const authenticated = true;\n', truncated: false })
    if (part === 'checkpoints') return json(response, [{ id: 'checkpoint-1', threadId: id, runId: 'run-history', nativeSessionId: thread.nativeSessionId, createdAt: ago(30) }])
    if (part === 'rewind') return json(response, { canRewind: true, error: null, files: ['src/auth.ts'], insertions: 3, deletions: 8, skippedLinks: 0 })
    if (part === 'manage') {
      if(body.action==='delete'){threads.delete(id);return json(response,{...thread,deleted:true})}
      if (body.action === 'rename') thread.title = body.value
      if (body.action === 'tag') thread.tag = body.value
      if (body.action === 'archive' || body.action === 'restore') thread.archived = body.action === 'archive'
      if (body.action === 'fork') return json(response, seed('fork-' + ++nextId, thread.projectPath, thread.title + ' · 分支', 0, histories.get(id)))
      return json(response, thread)
    }
    if (part === 'mcp/connect' || jobId) return json(response, { id: jobId || 'job-test', threadId: id, status: 'completed', result: capabilityCatalog('project'), error: null })
  }
  let match = /^\/threads\/([^/]+)\/permissions\/([^/]+)\/revoke$/.exec(path)
  if (match && post) { sessionGrants.set(match[1], (sessionGrants.get(match[1]) ?? []).filter(grant => grant.id !== match[2])); return json(response, { schemaVersion: 1, threadId: match[1], grants: sessionGrants.get(match[1]), canRevoke: true }) }
  match = /^\/threads\/([^/]+)(?:\/(messages|runs|approvals|delete|capabilities|permissions))?$/.exec(path)
  if (match) {
    const [, id, kind] = match, thread = threads.get(id)
    if (kind === 'permissions') return json(response, { schemaVersion: 1, threadId: id, grants: sessionGrants.get(id) ?? [], canRevoke: thread?.lastRun?.status !== 'running' })
    if (kind === 'capabilities') return json(response, capabilityCatalog(thread?.lastRun?.status === 'running' ? 'run' : 'project'))
    if (!thread) return failure(response, 'thread-not-found')
    if (kind === 'delete' && post) { threads.delete(id); histories.delete(id); return json(response, { ok: true }) }
    if (!kind) { if (post && typeof body.title === 'string') thread.title = body.title; return json(response, thread) }
    if (kind === 'messages') return json(response, { nativeSessionId: thread.nativeSessionId, messages: histories.get(id) ?? [] })
    if (kind === 'approvals') return json(response, [...approvals.values()].filter(item => item.threadId === id && item.decision === null))
    if (kind === 'runs') {
      if (!post) return json(response, [...runs.values()].filter(run => run.threadId === id))
      if ([...runs.values()].some(run => run.threadId === id && run.status === 'running')) return failure(response, 'run-active', 409)
      const run = { schemaVersion: 1, id: `qa-run-${++nextId}`, threadId: id, status: 'running', prompt: String(body.prompt || ''), model: body.model || null,
        resolvedModel: body.model || 'claude-sonnet', effort: body.effort || null, nativeSessionId: thread.nativeSessionId, createdAt: now(), finishedAt: null, result: null, error: null }
      runs.set(run.id, run); thread.lastRun = { id: run.id, status: 'running' }; thread.updatedAt = now()
      views.set(run.id, { schemaVersion: 1, runId: run.id, threadId: id, seq: 1, init: null, items: [{ id: `${run.id}-working`, role: 'assistant',
        blocks: [{ block: text('正在整理这条消息的演示回复…'), state: 'final' }] }], approvals: [], notices: [], modelStatus: 'requesting', result: null, error: null })
      json(response, run, 201)
      later(() => runChanged(run), 60)
      later(() => finishRun(run, `## 已收到你的任务\n\n你说的是：\n\n> ${run.prompt.replaceAll('\n', '\n> ')}\n\n这是浏览器验收的**模拟回复**。没有调用模型、执行命令或访问真实目录。\n\n- 输入框与会话创建可以正常交互\n- 草稿、项目切换与历史展示使用正式前端\n- 所有演示状态仅保存在当前夹具进程内存中`), 900)
      return
    }
  }
  match = /^\/runs\/([^/]+)(?:\/(view|cancel|control))?$/.exec(path)
  if (match) {
    const run = runs.get(match[1])
    if (!run) return failure(response, 'run-not-found')
    if (match[2] === 'control' && post) {
      if (body.action === 'permission-mode') run.permissionMode = body.mode
      return json(response, { ok: true })
    }
    if (match[2] === 'view') return json(response, views.get(run.id) ?? { schemaVersion: 1, runId: run.id, threadId: run.threadId, seq: 0, init: null, items: [], approvals: [], notices: [], modelStatus: null, result: run.result, error: null })
    if (match[2] === 'cancel' && post) {
      for (const value of approvals.values()) if (value.runId === run.id && value.decision === null) { value.decision = 'cancelled'; value.resolvedAt = now() }
      finishRun(run, '演示任务已停止。没有真实命令或模型请求需要取消。', 'cancelled')
    }
    return json(response, run)
  }
  match = /^\/approvals\/([^/]+)$/.exec(path)
  if (match && post) {
    const value = approvals.get(match[1])
    if (!value) return failure(response, 'approval-resolved', 409)
    value.decision = body.decision; value.answers = body.answers ?? null; value.resolvedAt = now()
    const run = runs.get(value.runId), view = views.get(value.runId)
    if (view) { view.seq++; emit(value.threadId, 'run-event', { threadId: value.threadId, runId: value.runId, seq: view.seq, event: { type: 'approval-resolved', approval: value } }) }
    json(response, value)
    later(() => {
      if (!run || run.status !== 'running') return
      const allowed = value.decision !== 'deny'
      histories.get(run.threadId).push(message(`${run.id}-prompt`, 'user', text(run.prompt)))
      if (allowed) histories.get(run.threadId).push(message('approval-command', 'assistant', tool('build-command', 'Bash', { command: 'npm run check' })), message('approval-output', 'assistant', output('build-command', '类型检查通过\n所有行为测试通过\n\n以上是隔离夹具的模拟结果，没有运行真实命令。')))
      finishRun(run, allowed ? '## 检查已完成\n\n类型检查与行为测试均已通过。你可以继续审查变更。\n\n这是一条模拟结果，没有执行真实构建。' : '已按你的选择拒绝这次操作。没有执行任何命令。')
    }, 500)
    return
  }
  process.stderr.write(`Unhandled QA API: ${request.method} ${url.pathname}\n`)
  return failure(response, 'not-found')
}

// Keep the published host markup and module graph intact. This bootstrap only migrates
// links from the old standalone fixture; all navigation and lifecycle controls belong to the shell.
const routeBootstrap = `<script>
(() => {
  const legacy = /^#\\/?host\\//.test(location.hash);
  let route;
  if (legacy) route = '/apps/claude-agent/' + location.hash.slice(1).replace(/^\\//, '');
  else if (!location.hash) {
    const scenario = new URLSearchParams(location.search).get('scenario');
    const thread = ['review', 'approval', 'history'].includes(scenario) ? scenario : 'review';
    route = '/apps/claude-agent/host/qa-local' + (scenario === 'empty' ? '' : '/thread/' + thread);
  }
  if (route) history.replaceState(null, '', '#' + route);
})();
</script>`
const shellPage = await readFile(assets.get('/').file, 'utf8')
const page = shellPage.replace('<script type="module" src="/host/web/client.js"></script>', `${routeBootstrap}\n  <script type="module" src="/host/web/client.js"></script>`)


const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(page); return }
    if (url.pathname === '/api/client/v1/instance' && request.method === 'GET') return json(response, instanceView())
    if (url.pathname === '/api/client/v1/products' && request.method === 'GET') return json(response, [productView()])
    const productRoute = /^\/api\/client\/v1\/products\/claude-agent(?:\/(open|stop|retry))?$/.exec(url.pathname)
    if (productRoute) {
      if (request.method === 'GET' && !productRoute[1]) return json(response, productView())
      if (request.method === 'POST' && productRoute[1]) { await readBody(request); return productControl(response, productRoute[1]) }
      return failure(response, 'not-found')
    }
    if (url.pathname === '/api/client/v1/app-packages' && request.method === 'GET') return json(response, { available: false, browserLifecycleAvailable: false, lifecycleAvailable: false, installations: [], operations: [], activations: [] })
    if (url.pathname.startsWith(apiBase)) {
      const path = url.pathname.slice(apiBase.length)
      if (path === '/connections') {
        if (request.method !== 'POST') return json(response, { connections: [...connections.values()], localInstanceId: instanceId })
        const body = await readBody(request), id = body.id || `connection-${++nextId}`
        // The submitted token is deliberately discarded; this gateway never contacts its endpoint.
        const connection = { id, name: String(body.name || '演示设备'), endpoint: String(body.endpoint || 'https://demo.invalid'), instanceId: `qa-${id}`, revision: (connections.get(id)?.revision ?? 0) + 1, credentialConfigured: true }
        connections.set(id, connection); return json(response, connection)
      }
      if (path === '/local') return json(response, { instanceId, picker: true, managed: true, device: { id: 'local', kind: 'local', name: '演示设备', instanceId, revision: 1 } })
      if (path === '/local/retry') return json(response, { state: 'ready' })
      if (/^\/(?:local|connections\/[^/]+)\/pick$/.test(path)) return json(response, { path: '/demo/AnyboxV2' })
      const deletion = /^\/connections\/([^/]+)\/delete$/.exec(path)
      if (deletion) { connections.delete(deletion[1]); return json(response, { ok: true }) }
      const forwarded = /^\/(?:local|connections\/[^/]+)\/v1(\/.*)$/.exec(path)
      if (forwarded) return await gateway(request, response, url, forwarded[1])
      return failure(response, 'not-found')
    }
    const asset = assets.get(url.pathname)
    if (!asset) return failure(response, 'not-found')
    response.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store' }); response.end(await readFile(asset.file))
  } catch (error) {
    process.stderr.write(`QA fixture: ${error instanceof Error ? error.message : 'request failed'}\n`)
    if (!response.headersSent) failure(response, 'fixture-request-failed', 500)
    else response.end()
  }
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
const url = `http://127.0.0.1:${server.address().port}`
process.stdout.write(JSON.stringify({ url, reviewUrl: `${url}/#/apps/claude-agent/host/${instanceId}/thread/review`, approvalUrl: `${url}/#/apps/claude-agent/host/${instanceId}/thread/approval`, historyUrl: `${url}/#/apps/claude-agent/host/${instanceId}/thread/history`, emptyUrl: `${url}/?scenario=empty` }) + '\n')
const close = () => {
  if (closing) return
  closing = true
  for (const timer of timers) clearTimeout(timer)
  for (const response of streams.keys()) response.end()
  server.close(); server.closeIdleConnections()
}
process.once('SIGINT', close); process.once('SIGTERM', close)

import type { HistoryMessageView, RunLiveView, RunView, ThreadView } from '../core/view.js'
import type { ConnectionJob } from '../core/runs/workspace.js'
import type { Checkpoint, ContextUsage, ElicitationView, FilePreview, RewindPreview, SessionOptions } from '../core/workspace.js'
import { defaultSessionOptions } from '../core/view.js'
import { el, renderItem } from './view.js'
import { messageFor } from './state.js'

type Tab = 'usage' | 'agents' | 'session' | 'mcp' | 'files'
const labels: Record<Tab, string> = { usage: '用量与预算', agents: '子 Agent 历史', session: '会话管理', mcp: 'MCP 连接', files: '文件与恢复' }
export interface WorkspaceTarget { readonly key: string; readonly thread: ThreadView; readonly run?: RunView; readonly live?: RunLiveView }
/** A contextual drawer. Native mutations are submitted once, and stale responses cannot change another thread. */
export function createWorkspacePanel(domId: (value: string) => string, options: {
  target(): WorkspaceTarget | undefined
  request<T>(path: string, body?: object, signal?: AbortSignal): Promise<T>
  changed(thread: ThreadView): void
  report(message: string): void
  interactions(count: number): void
}) {
  const heading = el('h2', { id: domId('workspace-title'), text: '会话详情' }), subtitle = el('p')
  const closeButton = el('button', { type: 'button', text: '×', 'aria-label': '关闭会话详情' })
  const body = el('div', { class: 'ca-workspace-body', id: domId('workspace-body'), role: 'tabpanel' })
  const status = el('p', { class: 'ca-workspace-status', role: 'status' })
  const discard = el('button', { type: 'button', text: '放弃修改并关闭', hidden: true })
  const tabs = (Object.keys(labels) as Tab[]).map(tab => {
    const button = el('button', { type: 'button', role: 'tab', text: labels[tab], 'aria-controls': body.id, id: domId(`workspace-${tab}`) })
    button.addEventListener('click', () => { if (!canLeave()) return; selected = tab; void load() })
    button.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault(); const index = tabs.indexOf(button), next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowLeft' ? tabs.length - 1 : 1)) % tabs.length
      tabs[next].click(); tabs[next].focus()
    })
    return button
  })
  const auth = el('div', { class: 'ca-mcp-interactions', 'aria-live': 'polite' })
  const element = el('dialog', { class: 'ca-workspace-dialog', 'aria-labelledby': heading.id }, el('header', { class: 'ca-workspace-head' }, el('div', {}, heading, subtitle), closeButton),
    el('nav', { role: 'tablist', 'aria-label': '会话详情分类', class: 'ca-workspace-tabs' }, ...tabs), status, discard, auth, body)
  let selected: Tab = 'usage', current: WorkspaceTarget | undefined, reads = new AbortController(), version = 0, busy = false, dirty = false, disposed = false
  let requestedFile:string|undefined, fullContext=false, runtimeServers:SessionOptions['mcpServers']|undefined, runtimeRunId:string|undefined
  const urls=new Set<string>();const clearUrls=()=>{for(const url of urls)URL.revokeObjectURL(url);urls.clear()}
  let focus: HTMLElement | undefined, poll: ReturnType<typeof setTimeout> | undefined, polling = false, authKey = '', activeJob: ConnectionJob | undefined
  const mutationKeys = new Map<string, string>()
  const requestId = (input: object) => { const name = `${key()}:${JSON.stringify(input)}`; let id = mutationKeys.get(name); if (!id) { id = crypto.randomUUID(); mutationKeys.set(name, id) }; return id }
  const key = () => options.target()?.key
  const relevant = (target = current) => !disposed && !!target && key() === target.key
  const base = (target = current) => `/apps/claude-agent/threads/${encodeURIComponent(target!.thread.id)}`
  const active = () => ['running', 'cancelling'].includes(options.target()?.run?.status ?? '') || activeJob?.status === 'running'
  const button = (text: string, action: () => void, disabled = false) => { const node = el('button', { type: 'button', text, disabled }); node.addEventListener('click', action); return node }
  const note = (text: string) => el('p', { class: 'ca-workspace-help', text })
  const field = (label: string, input: HTMLElement) => el('label', { class: 'ca-workspace-field' }, el('span', { text: label }), input)
  const canLeave = () => { if (!busy && !dirty) return true; status.textContent = busy ? '正在等待操作结果，请稍候。' : '有未保存的修改，请先保存，或放弃修改后关闭。'; discard.hidden = busy || !dirty; return false }
  const close = (force = false) => { if (!force && !canLeave()) return; clearUrls();reads.abort(); reads = new AbortController(); version++; element.close(); dirty = false; discard.hidden = true; focus?.focus() }
  const mutation = async <T>(path: string, input: object, done: (value: T) => void | Promise<void>) => {
    if (busy || !relevant()) return
    const target = current!
    busy = true; status.textContent = '正在等待执行设备确认…'; body.setAttribute('aria-busy', 'true')
    for (const node of body.querySelectorAll<HTMLButtonElement>('button')) node.disabled = true
    try { const value = await options.request<T>(path, input); if (relevant(target)) { busy = false; dirty = false; discard.hidden = true; await done(value); status.textContent = '已完成。' } }
    catch (error) { const message = `${messageFor(error)}。操作不会自动重试；结果未知时请先刷新核对。`; if (relevant(target)) status.textContent = message; else options.report(message) }
    finally { busy = false; body.setAttribute('aria-busy', 'false'); for (const node of body.querySelectorAll<HTMLButtonElement>('button')) node.disabled = node.dataset.idleOnly === 'true' && active() }
  }
  const save = (settings: SessionOptions) => mutation<ThreadView>(`${base()}/options`, { ...settings, revision: current?.thread.optionsRevision ?? 0 }, async value => { options.changed(value); if (current) current = { ...current, thread: value }; await load() })
  const idleButton = (text: string, action: () => void) => { const node = button(text, action, active()); node.dataset.idleOnly = 'true'; return node }
  const renderUsage = (context?: ContextUsage) => {
    const target = options.target()!, settings = target.thread.options ?? defaultSessionOptions
    const result = target.run?.result
    const summary = context ? el('section', { class: 'ca-context-card' }, el('strong', { text: `${context.percentage.toFixed(1)}% 上下文已用` }),
      el('progress', { value: String(context.percentage), max: '100', 'aria-label': '上下文占用' }),
      note(`${context.totalTokens.toLocaleString()} / ${context.maxTokens.toLocaleString()} tokens · ${context.model} · ${context.estimated?'估算':'详细计数'}`),
      ...context.categories.map(item => el('div', { class: 'ca-context-row' }, el('span', { text: `${item.name}${item.kind === 'deferred' ? '（未载入）' : item.kind === 'buffer' ? '（压缩预留）' : item.kind === 'free' ? '（剩余）' : ''}` }), el('span', { text: item.tokens.toLocaleString() })))) : note('尚无上下文快照。可刷新读取当前会话的估算用量。')
    const budget = el('input', { type: 'number', min: '0.01', max: '10000', step: '0.01', placeholder: '不限', value: settings.maxBudgetUsd === null ? '' : String(settings.maxBudgetUsd) })
    const turns = el('input', { type: 'number', min: '1', max: '10000', step: '1', placeholder: '不限', value: settings.maxTurns === null ? '' : String(settings.maxTurns) })
    const fallback = el('input', { type: 'text', placeholder: '不设置', value: settings.fallbackModel ?? '', maxlength: '100' })
    const form = el('form', { class: 'ca-workspace-form' }, el('h3', { text: '任务预算' }), note('保存后用于下一次任务。预算按 SDK 查询执行，最终费用可能略超阈值；轮次是模型与工具循环次数。'),
      field('每次任务费用上限（USD）', budget), field('最多执行轮次', turns), field('备用模型名称或别名', fallback), el('button', { type: 'submit', text: '保存预算', disabled: active(), 'data-idle-only': 'true' }))
    form.addEventListener('input', () => { dirty = true })
    form.addEventListener('submit', event => { event.preventDefault(); if (form.checkValidity()) void save({ ...settings, maxBudgetUsd: budget.value ? Number(budget.value) : null, maxTurns: turns.value ? Number(turns.value) : null, fallbackModel: fallback.value.trim() || null }) })
    body.replaceChildren(summary, button('刷新上下文', () => { if (canLeave()) {fullContext=false;void load(true)} }),button('查看详细占用',()=>{if(canLeave()){fullContext=true;void load(true)}}),...(context?.details?.length?[el('details',{},el('summary',{text:'记忆、工具与技能明细'}),...context.details.map(item=>el('p',{text:`${item.group} · ${item.name} · ${item.tokens.toLocaleString()} tokens`})))] : []), ...(result ? [el('section', { class: 'ca-context-card' }, el('h3', { text: 'Claude 报告的累计费用' }), el('strong', { text: `$${result.totalCostUsd.toFixed(4)}` }), note('续接或分叉可能包含历史累计值，请勿将每次任务的数字直接相加。'),
      ...(result.modelUsage ?? []).map(item => el('p', { text: `${item.model} · 输入 ${item.inputTokens.toLocaleString()} / 输出 ${item.outputTokens.toLocaleString()} · $${item.costUsd.toFixed(4)} · ${item.provider??'提供方未知'} · 缓存读取 ${item.cacheReadTokens??'未提供'} / 写入 ${item.cacheWriteTokens??'未提供'} · 思考 ${item.thinkingTokens??'未提供'} · 搜索 ${item.webSearchRequests??'未提供'}${item.costBasis==='unknown'?' · 价格来源未知，仅供参考':''}` })))] : []), form)
  }
  const renderAgents = async (signal: AbortSignal, target: WorkspaceTarget) => {
    const ids = await options.request<readonly string[]>(`${base(target)}/agents`, undefined, signal)
    if (signal.aborted || !relevant(target)) return
    body.replaceChildren(note('读取此原生会话保存的全部子 Agent 记录。按页加载，长工具内容会明确标记截断。'))
    if (!ids.length) body.append(note('此会话尚无已保存的子 Agent 历史。'))
    for (const id of ids) {
      const content = el('div', { class: 'ca-agent-history' }), summary = el('summary', { text: `子 Agent · ${id}` })
      const details = el('details', { class: 'ca-workspace-section' }, summary, content)
      let offset = 0, loaded = false, loading = false
      const next = button('加载更多消息', () => { void page() })
      const page = async () => {
        if (loading) return; loading = true; next.disabled = true
        try {
          const value = await options.request<{ messages: readonly HistoryMessageView[]; hasMore: boolean }>(`${base(target)}/agents/${encodeURIComponent(id)}/messages?offset=${offset}`, undefined, signal)
          if (signal.aborted || !relevant(target)) return
          for (const message of value.messages) content.append(renderItem({ ...message, streaming: false }))
          offset += value.messages.length; next.hidden = !value.hasMore; loaded = true
          if (!offset) content.append(note('暂无可读取的消息。'))
          details.append(next)
        } catch (error) { if (!signal.aborted) content.append(note(messageFor(error))) }
        finally { loading = false; next.disabled = false }
      }
      details.addEventListener('toggle', () => { if (details.open && !loaded) void page() })
      body.append(details)
    }
  }
  const renderSession = async (signal: AbortSignal, target: WorkspaceTarget) => {
    const title = el('input', { value: target.thread.title, maxlength: '200' }), tag = el('input', { value: target.thread.tag ?? '', maxlength: '100', placeholder: '例如：待复查' })
    const manage = (action: string, value?: string, messageId?: string) => mutation<ThreadView>(`${base(target)}/manage`, { action, ...(value === undefined ? {} : { value }), ...(messageId ? { messageId } : {}), idempotencyKey: requestId({ action, value, messageId }) }, async value => { mutationKeys.clear(); close(true); options.changed(value) })
    const messages = await options.request<{ messages: readonly HistoryMessageView[];previousOffset?:number|null }>(`${base(target)}/messages`, undefined, signal)
    if (signal.aborted || !relevant(target)) return
    const point = el('select', { 'aria-label': '分叉位置' }, el('option', { value: '', text: '完整会话 · 从最新位置继续' }), ...messages.messages.map((message, index) => el('option', { value: message.id, text: `${index + 1}. ${message.role === 'user' ? '你' : 'Claude'} · ${message.blocks.flatMap(block => block.kind === 'text' ? [block.text] : []).join(' ').slice(0, 80) || '工具或思考消息'}` })))
    body.replaceChildren(el('section', { class: 'ca-workspace-section' }, el('h3', { text: '名称与标签' }), field('会话名称', title), idleButton('重命名', () => { void manage('rename', title.value.trim()) }), field('标签', tag), idleButton('保存标签', () => { void manage('tag', tag.value.trim()) })),
      el('section', { class: 'ca-workspace-section' }, el('h3', { text: '创建会话分支' }), note('复制选定位置及之前的对话，原会话保持可用。分支共用项目文件，不复制文件检查点或会话授权。'), field('分叉位置', point), idleButton('创建分支', () => { void manage('fork', undefined, point.value || undefined) })),
      el('section', { class: 'ca-workspace-section' }, el('h3', { text: target.thread.archived ? '恢复会话' : '归档会话' }), note('归档会话可在侧栏“已归档”中恢复，Claude 原生历史会保留。'), idleButton(target.thread.archived ? '恢复到会话列表' : '归档此会话', () => { void manage(target.thread.archived ? 'restore' : 'archive') })))
    let previous=messages.previousOffset??null
    const earlier=button('加载更早的分叉位置',()=>{if(previous===null)return;earlier.disabled=true;void options.request<{messages:readonly HistoryMessageView[];previousOffset?:number|null}>(`${base(target)}/messages?offset=${previous}`,undefined,signal).then(page=>{if(signal.aborted||!relevant(target))return;for(const message of [...page.messages].reverse()){const option=el('option',{value:message.id,text:`${message.role==='user'?'你':'Claude'} · ${message.blocks.flatMap(b=>b.kind==='text'?[b.text]:[]).join(' ').slice(0,80)||'工具消息'}`});point.insertBefore(option,point.options[1]??null)}previous=page.previousOffset??null;earlier.hidden=previous===null}).catch(error=>{status.textContent=messageFor(error)}).finally(()=>{earlier.disabled=false})});earlier.hidden=previous===null;point.after(earlier)
    const nativeList=el('div'),more=button('查看此项目的 Claude 原生会话',()=>{void nativePage()});let nativeOffset=0
    const nativePage=async()=>{more.disabled=true;try{const sessions=await options.request<readonly {sessionId:string;title:string;updatedAt:string}[]>(`${base(target)}/native-sessions?offset=${nativeOffset}`,undefined,signal);if(signal.aborted||!relevant(target))return;for(const session of sessions.slice(0,50))nativeList.append(el('section',{class:'ca-workspace-section'},el('strong',{text:session.title}),note(session.updatedAt),button('在应用中打开',()=>{void mutation<ThreadView>(`${base(target)}/native-sessions`,{sessionId:session.sessionId},value=>{close(true);options.changed(value)})})));nativeOffset+=Math.min(50,sessions.length);more.textContent=sessions.length>50?'加载更多原生会话':'已显示全部';more.hidden=sessions.length<=50}catch(error){status.textContent=messageFor(error)}finally{more.disabled=false}}
    const deletion=el('section',{class:'ca-workspace-section ca-danger-zone'},el('h3',{text:'删除会话'}),note('删除此会话的 Claude 原生历史，并从应用列表移除。项目文件保留；此操作无法撤销。'))
    deletion.append(idleButton('删除此会话…',()=>{deletion.append(note(`确认删除“${target.thread.title}”？`),idleButton('确认永久删除会话历史',()=>{void manage('delete')}))}))
    body.append(el('section',{class:'ca-workspace-section'},el('h3',{text:'接入已有 Claude 会话'}),note('读取当前项目的原生会话；打开后继续使用原始历史，不复制会话。'),more,nativeList),deletion)
    title.addEventListener('input', () => { dirty = true }); tag.addEventListener('input', () => { dirty = true })
  }
  const renderMcp = () => {
    const settings = options.target()!.thread.options ?? defaultSessionOptions,run=options.target()?.run
    const running=run?.status==='running'
    if(runtimeRunId!==run?.id){runtimeRunId=run?.id;runtimeServers=undefined}
    const servers=running?(options.target()?.live?.mcpServers??runtimeServers??settings.mcpServers):settings.mcpServers
    const change=(next:SessionOptions['mcpServers'])=>running?mutation(`/apps/claude-agent/runs/${encodeURIComponent(run.id)}/control`,{action:'mcp-set',servers:next},()=>{runtimeServers=next;renderMcp()}):save({...settings,mcpServers:next})
    const list = el('div', { class: 'ca-mcp-config-list' })
    for (const [name, server] of Object.entries(servers)) list.append(el('section', { class: 'ca-workspace-section' }, el('strong', { text: name }), el('code', { text: server.type === 'stdio' ? [server.command, ...server.args].join(' ') : server.url }),
      button(running?'从当前任务移除':'移除此会话配置', () => { const next = { ...servers }; delete next[name]; void change(next) })))
    if (!Object.keys(servers).length) list.append(note('尚未添加会话专用服务。Claude 环境中已有的 MCP 继续生效，可在“技能与工具”查看。'))
    const name = el('input', { required: true, pattern: '[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}', placeholder: 'my-service' })
    const type = el('select', {}, el('option', { value: 'http', text: 'HTTP' }), el('option', { value: 'sse', text: 'SSE' }), el('option', { value: 'stdio', text: '本机命令（stdio）' }))
    const endpoint = el('input', { required: true, placeholder: 'https://example.com/mcp' }), args = el('textarea', { rows: '3', placeholder: '每行一个参数', hidden: true })
    const endpointLabel = el('span', { text: '服务地址' })
    type.addEventListener('change', () => { args.hidden = type.value !== 'stdio'; endpointLabel.textContent = type.value === 'stdio' ? '执行设备上的命令' : '服务地址'; endpoint.placeholder = type.value === 'stdio' ? '例如 /usr/local/bin/my-mcp' : 'https://example.com/mcp' })
    const form = el('form', { class: 'ca-workspace-form' }, el('h3', { text: '添加 MCP 服务' }), field('名称', name), field('连接方式', type), el('label', { class: 'ca-workspace-field' }, endpointLabel, endpoint), args,
      note('配置仅属于此会话。连接检查或发送任务会在执行设备连接服务；stdio 会启动指定程序。请勿把令牌或密码填入地址、命令或参数，认证沿用 Claude 环境。'), el('button', { type: 'submit', text: running?'添加到当前任务':'保存连接配置' }))
    form.addEventListener('input', () => { dirty = true })
    form.addEventListener('submit', event => { event.preventDefault(); if (!form.checkValidity()) return; const server = type.value === 'stdio' ? { type: 'stdio' as const, command: endpoint.value.trim(), args: args.value.split('\n').filter(Boolean) } : { type: type.value as 'http' | 'sse', url: endpoint.value.trim() }; void change({ ...servers, [name.value]: server }) })
    const connect = idleButton('检查连接与认证', () => { if (!canLeave()) return; void mutation<ConnectionJob>(`${base()}/mcp/connect`, {}, job => { activeJob = job; renderJob(); schedulePoll() }) })
    const job = el('section', { class: 'ca-mcp-job', 'data-mcp-job': '' })
    body.replaceChildren(el('h3', { text: running?'当前任务的 MCP 配置':'此会话的 MCP 配置' }),note(running?'动态增删只应用于当前任务。连接失败时请核对真实服务状态，操作不会自动重试；后续任务仍使用已保存的会话配置。':'保存后供后续任务使用。'), list, connect, job, form)
    renderJob()
  }
  const renderJob = () => {
    for (const node of body.querySelectorAll<HTMLButtonElement>('[data-idle-only]')) node.disabled = active()
    const node = body.querySelector<HTMLElement>('[data-mcp-job]')
    if (!node || !activeJob) return
    node.replaceChildren(note(activeJob.status === 'running' ? '正在连接，可在下方完成服务请求的认证或表单。' : activeJob.error || '连接检查完成。'))
    if (activeJob.status === 'running') node.append(button('取消连接检查', () => { void mutation(`${base()}/mcp/jobs/${encodeURIComponent(activeJob!.id)}/cancel`, {}, () => { schedulePoll() }) }))
    for (const server of activeJob.result?.mcp ?? []) node.append(el('p', { text: `${server.name} · ${server.status === 'connected' ? '已连接' : server.status === 'needs-auth' ? '需要登录；如未提供认证链接，请在执行设备的 Claude 环境登录后重试' : server.status} · ${server.tools.length} 个工具` }))
  }
  const renderFiles = async (signal: AbortSignal, target: WorkspaceTarget) => {
    clearUrls()
    const path = el('input', { value:requestedFile??'',placeholder: '相对项目路径，或执行设备上的绝对路径', required: true }), file = el('div', { class: 'ca-file-preview' })
    const form = el('form', { class: 'ca-file-form' }, field('文件路径', path), el('button', { type: 'submit', text: '打开文件' }))
    form.addEventListener('submit', event => { event.preventDefault(); if (!form.checkValidity()) return; void (async () => { try { const result = await options.request<FilePreview>(`${base(target)}/file?path=${encodeURIComponent(path.value)}`, undefined, signal); if (!signal.aborted && relevant(target)) {
          clearUrls();const binary=result.encoding==='base64',mime=result.mime??'text/plain',bytes=binary?Uint8Array.from(atob(result.contents),c=>c.charCodeAt(0)):new TextEncoder().encode(result.contents),url=URL.createObjectURL(new Blob([bytes],{type:mime}));urls.add(url)
          const download=el('a',{href:url,download:result.path.split('/').at(-1)??'file',text:result.truncated?'下载预览片段':'下载文件'})
          file.replaceChildren(el('strong',{text:result.path}),...(result.truncated?[note('预览内容已截断，下载也只包含此片段。')]:[]),download)
          if(binary){if(mime.startsWith('image/')&&!result.truncated)file.append(el('img',{src:url,alt:result.path.split('/').at(-1)??'文件预览',class:'ca-file-image'}));else file.append(note(result.truncated?'文件较大，无法完整预览。':'PDF 可下载后查看。'))}
          else{const code=el('pre',{class:'ca-code-preview'},...result.contents.split('\n').map((line,index)=>el('span',{class:'ca-code-line'},el('span',{'aria-hidden':'true',class:'ca-line-number',text:String(index+1)}),document.createTextNode(line||' '))));file.append(button('复制内容',()=>{void navigator.clipboard.writeText(result.contents).then(()=>{status.textContent='已复制。'}).catch(()=>{status.textContent='无法访问剪贴板，请选择文本复制。'})}),code)}
        } } catch (error) { if (!signal.aborted) file.replaceChildren(note(messageFor(error))) } })() })
    if(requestedFile){requestedFile=undefined;form.requestSubmit()}
    const settings = target.thread.options ?? defaultSessionOptions, enabled = el('input', { type: 'checkbox', checked: settings.checkpointing, disabled: active() })
    enabled.addEventListener('change', () => { void save({ ...settings, checkpointing: enabled.checked }) })
    const list = el('div'), checkpoints = await options.request<readonly Checkpoint[]>(`${base(target)}/checkpoints`, undefined, signal)
    if (signal.aborted || !relevant(target)) return
    for (const checkpoint of checkpoints) {
      const preview = el('div'), row = el('section', { class: 'ca-workspace-section' }, el('strong', { text: new Date(checkpoint.createdAt).toLocaleString() }), idleButton('预览恢复', () => { void mutation<RewindPreview>(`${base(target)}/rewind`, { checkpointId: checkpoint.id, dryRun: true }, result => {
        preview.replaceChildren(note(result.canRewind ? `${result.files.length} 个文件 · +${result.insertions} / −${result.deletions}` : result.error || '此检查点不可恢复。'), el('ul', {}, ...result.files.map(path => el('li', { text: path }))))
        const restoreKey = crypto.randomUUID()
        if (result.canRewind) preview.append(note('确认后将修改以上文件。对话保留；Bash 修改和大部分子 Agent 修改不在检查点范围内。'), idleButton('确认恢复这些文件', () => { void mutation<RewindPreview>(`${base(target)}/rewind`, { checkpointId: checkpoint.id, dryRun: false, idempotencyKey: restoreKey }, restored => { preview.replaceChildren(note(restored.canRewind ? `恢复操作已完成。跳过不安全链接：${restored.skippedLinks}。${restored.error ?? ''}` : restored.error || '未完成恢复，请检查文件状态。')) }) }))
      }) }), preview)
      list.append(row)
    }
    if (!checkpoints.length) list.append(note('尚无检查点。开启后，从下一次任务开始记录；历史任务不会补建检查点。'))
    body.replaceChildren(el('h3', { text: '文件预览' }), note('文件来自当前执行设备，读取遵循 Claude 原生权限。'), form, file, el('h3', { text: '文件检查点' }), field('为后续任务记录检查点', enabled), note('只恢复原生工具跟踪的文件内容。会话分支不继承原会话的检查点。'), list)
  }
  const renderAuth = (requests: readonly ElicitationView[]) => {
    const nextKey = `${key()}:${requests.map(item => item.id).join(',')}`
    options.interactions(requests.length)
    if (authKey === nextKey) return
    authKey = nextKey; auth.replaceChildren()
    for (const request of requests) {
      const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>()
      const form = el('form', { class: 'ca-mcp-auth-form' }, el('h3', { text: `${request.serverName} 请求${request.mode === 'url' ? '认证' : '填写信息'}` }), note(request.message), note('回答直接提交给此服务，不保存在聊天记录中。'))
      if (request.url) form.append(el('a', { href: request.url, target: '_blank', rel: 'noopener noreferrer', text: '打开服务认证页面' }), note(`目标：${new URL(request.url).host}。完成后返回确认；关闭此面板不会代你同意。`))
      for (const item of request.fields) {
        const input = item.choices ? el('select', { required: item.required }, el('option', { value: '', text: '请选择' }), ...item.choices.map(choice => el('option', { value: choice, text: choice }))) : el('input', { type: item.type === 'boolean' ? 'checkbox' : item.type === 'string' ? 'text' : 'number', required: item.required && item.type !== 'boolean', step: item.type === 'integer' ? '1' : 'any', maxlength: '8000' })
        inputs.set(item.name, input); form.append(field(`${item.title}${item.required ? ' *' : ''}`, input))
      }
      const answer = (action: 'accept' | 'decline') => {
        const content = Object.fromEntries(request.fields.flatMap(item => { const input = inputs.get(item.name)!; if (!item.required && item.type !== 'boolean' && !input.value) return []; return [[item.name, item.type === 'boolean' ? (input as HTMLInputElement).checked : item.type === 'string' ? input.value : Number(input.value)]] }))
        void mutation(`${base()}/interactions/${encodeURIComponent(request.id)}`, { action, ...(action === 'accept' && request.mode === 'form' ? { content } : {}) }, () => { authKey = ''; schedulePoll() })
      }
      form.append(el('button', { type: 'submit', text: request.mode === 'url' ? '我已完成认证，继续' : '提交给此服务' }), button('拒绝', () => answer('decline')))
      form.addEventListener('submit', event => { event.preventDefault(); if (form.checkValidity()) answer('accept') })
      auth.append(form)
    }
  }
  const pollNow = async () => {
    if (disposed || polling) return
    const target = options.target()
    if (!target || (!element.open && !active() && activeJob?.status !== 'running')) { options.interactions(0); return }
    polling = true
    try {
      const requests = await options.request<readonly ElicitationView[]>(`${base(target)}/interactions`, undefined, reads.signal)
      if (!disposed && key() === target.key) renderAuth(requests)
      if (activeJob?.threadId === target.thread.id && activeJob.status === 'running') {
        const job = await options.request<ConnectionJob>(`${base(target)}/mcp/jobs/${encodeURIComponent(activeJob.id)}`, undefined, reads.signal)
        if (!disposed && key() === target.key) { activeJob = job; renderJob() }
      }
    } catch { /* reads are reconciled on the next visible poll */ }
    finally { polling = false; schedulePoll() }
  }
  const schedulePoll = () => { if (poll) clearTimeout(poll); if (!disposed && (element.open || active() || activeJob?.status === 'running')) poll = setTimeout(() => { poll = undefined; void pollNow() }, 1500) }
  const load = async (refresh = false) => {
    const target = options.target()
    if (!target || !element.open || disposed) return
    reads.abort(); reads = new AbortController(); const signal = reads.signal, epoch = ++version
    current = target; status.textContent = '正在读取…'; subtitle.textContent = target.thread.title
    for (const [index, tab] of tabs.entries()) { const chosen = (Object.keys(labels) as Tab[])[index] === selected; tab.setAttribute('aria-selected', String(chosen)); tab.tabIndex = chosen ? 0 : -1 }
    body.setAttribute('aria-labelledby', domId(`workspace-${selected}`)); body.setAttribute('aria-busy', 'true'); body.replaceChildren()
    try {
      if (selected === 'usage') { const cached = target.live?.contextUsage ?? target.run?.contextUsage; const context = cached && !refresh ? cached : await options.request<ContextUsage>(`${base(target)}/context${fullContext?'?detail=full':''}`, undefined, signal); if (!signal.aborted && relevant(target)) renderUsage(context) }
      if (selected === 'agents') await renderAgents(signal, target)
      if (selected === 'session') await renderSession(signal, target)
      if (selected === 'mcp') { const jobs = await options.request<readonly ConnectionJob[]>(`${base(target)}/mcp/jobs`, undefined, signal); if (!signal.aborted && relevant(target)) { activeJob = jobs.find(job => job.status === 'running') ?? jobs.at(-1); renderMcp() } }
      if (selected === 'files') await renderFiles(signal, target)
      if (epoch === version && !signal.aborted) status.textContent = active() ? '任务进行中；设置、分叉和文件恢复需等待任务结束。' : ''
    } catch (error) { if (epoch === version && !signal.aborted) { status.textContent = `读取失败：${messageFor(error)}`; if (selected === 'usage') renderUsage(); else body.append(button('重试读取', () => { void load() })) } }
    finally { if (epoch === version) body.setAttribute('aria-busy', 'false'); schedulePoll() }
  }
  closeButton.addEventListener('click', () => close())
  discard.addEventListener('click', () => close(true))
  element.addEventListener('cancel', event => { event.preventDefault(); close() })
  return { element,
    openFile(path:string){if(!canLeave())return;requestedFile=path;selected='files';focus=document.activeElement as HTMLElement;current=options.target();if(!current)return;if(!element.open)element.showModal();void load()},
    open(tab: Tab = 'usage', returnFocus?: HTMLElement) { if ((dirty || busy) && current?.key === key()) { if (!element.open) element.showModal(); canLeave(); return }; selected = tab; focus = returnFocus; current = options.target(); if (!current) return; if (!element.open) element.showModal(); void load() },
    update() { if (current && key() !== current.key) { close(true); current = options.target(); activeJob = undefined; authKey = ''; auth.replaceChildren(); options.interactions(0) }; if (element.open && !busy && !dirty) for (const node of body.querySelectorAll<HTMLButtonElement>('[data-idle-only]')) node.disabled = active(); schedulePoll() },
    canClose: canLeave,
    hide() { reads.abort(); reads = new AbortController(); element.close() },
    close,
    dispose() { clearUrls();disposed = true; if (poll) clearTimeout(poll); reads.abort(); close(true) },
  }
}

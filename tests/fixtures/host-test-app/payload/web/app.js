const DRAFT_KEY = 'anybox.host-test.draft.v1'
const LOG_LIMIT = 16

/** A dependency-free application implementing the host's public web lifecycle. */
export async function mount(container, context) {
  let disposed = false, disposal, active = false, reason = '等待激活', ticks = 0, ticker
  let count = 0, savedDraft = '', storageError = false, task = null, sequence = 0
  let unsubscribeRoute = () => {}
  const listeners = [], events = []
  const instance = globalThis.crypto?.randomUUID?.() ?? `mount-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const element = (tag, text = '', className = '') => {
    const node = document.createElement(tag)
    node.id = context.domId(`test-${++sequence}`)
    if (text) node.textContent = text
    if (className) node.className = className
    return node
  }
  const on = (node, event, handler) => {
    const guarded = value => { if (!disposed && !context.signal.aborted) handler(value) }
    node.addEventListener(event, guarded)
    listeners.push(() => node.removeEventListener(event, guarded))
  }
  const button = (text, handler, className = '') => {
    const node = element('button', text, className)
    node.type = 'button'; on(node, 'click', handler)
    return node
  }
  const card = (title, description) => {
    const node = element('section', '', 'test-card')
    node.append(element('h2', title), element('p', description, 'test-hint'))
    return node
  }
  const row = (label, value) => {
    const node = element('div', '', 'test-detail-row')
    const content = element('dd', value)
    node.append(element('dt', label), content)
    return { node, content }
  }

  const root = element('main', '', 'abx-host-test')
  const header = element('header', '', 'test-header')
  const title = element('div', '', 'test-title')
  const heading = element('h1', 'Anybox Test')
  title.append(heading, element('span', '0.1.0', 'test-version'))
  const closeStatus = element('span', '', 'test-badge')
  closeStatus.setAttribute('role', 'status')
  const introduction = element('p', '一个最小应用，用来验证安装、界面交互与宿主生命周期。', 'test-intro')
  header.append(title, closeStatus)
  const tabs = element('div', '', 'test-tabs')
  tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '测试页面')
  const interactionTab = button('交互测试', () => context.route.navigate('/interaction'))
  const lifecycleTab = button('生命周期', () => context.route.navigate('/lifecycle'))
  const interaction = element('div', '', 'test-grid')
  const lifecycle = element('div', '', 'test-lifecycle')
  for (const [tab, panel] of [[interactionTab, interaction], [lifecycleTab, lifecycle]]) {
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-controls', panel.id)
    panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id)
    panel.tabIndex = 0
  }
  tabs.append(interactionTab, lifecycleTab)

  const counterCard = card('计数器', '切换页签或应用后，当前挂载内的计数会保留。')
  const counter = element('output', '0', 'test-count')
  counter.setAttribute('aria-label', '当前计数'); counter.setAttribute('aria-live', 'polite')
  const counterActions = element('div', '', 'test-actions')
  counterActions.append(button('加一', () => { count += 1; counter.textContent = String(count) }, 'test-primary'),
    button('重置', () => { count = 0; counter.textContent = '0'; log('计数器已重置') }))
  counterCard.append(counter, counterActions)

  const taskCard = card('模拟任务', '运行 5 秒。在途任务会阻止关闭，可随时取消。')
  const taskStatus = element('p', '尚未启动', 'test-task-status')
  taskStatus.setAttribute('role', 'status')
  const startButton = button('启动 5 秒任务', startTask, 'test-primary')
  const cancelButton = button('取消任务', () => { void cancelTask() })
  const taskActions = element('div', '', 'test-actions')
  taskActions.append(startButton, cancelButton); taskCard.append(taskStatus, taskActions)

  const draftCard = card('草稿与关闭保护', '修改后会阻止关闭。保存到当前浏览器，或放弃修改后可关闭。')
  draftCard.classList.add('test-draft-card')
  const draft = element('textarea')
  draft.rows = 4; draft.placeholder = '输入一些文字，再尝试关闭应用或应用更改…'
  const draftLabel = element('label', '测试草稿')
  draftLabel.htmlFor = draft.id
  const draftStatus = element('span', '', 'test-hint')
  draftStatus.setAttribute('role', 'status')
  draft.setAttribute('aria-describedby', draftStatus.id)
  try { savedDraft = localStorage.getItem(DRAFT_KEY) ?? '' } catch { storageError = true }
  draft.value = savedDraft
  const saveButton = button('保存草稿', () => {
    try {
      localStorage.setItem(DRAFT_KEY, draft.value)
      savedDraft = draft.value; storageError = false
      draftStatus.textContent = '已保存到此浏览器'; log('草稿已保存'); render()
    } catch {
      storageError = true; draftStatus.textContent = '保存失败：本地存储不可用，修改仍未保存。'
      log('草稿保存失败'); render()
    }
  }, 'test-primary')
  const discardButton = button('放弃修改', () => {
    draft.value = savedDraft
    draftStatus.textContent = '已恢复到上次保存的内容'; log('草稿修改已放弃'); render()
  })
  const draftActions = element('div', '', 'test-actions')
  draftActions.append(saveButton, discardButton, draftStatus)
  draftCard.append(draftLabel, draft, draftActions)
  on(draft, 'input', () => {
    draftStatus.textContent = draft.value === savedDraft ? '与已保存内容一致' : '有未保存的修改'
    render()
  })
  interaction.append(counterCard, taskCard, draftCard)

  const detailsCard = card('宿主生命周期', '切换应用会暂停活动计时，草稿与模拟任务保持原状态。')
  const details = element('dl', '', 'test-details')
  const phase = row('界面状态', '已挂载'), activation = row('激活原因', reason)
  const route = row('局部路由', context.route.read() || '/')
  const elapsed = row('活动计时', '0 秒'), identity = row('挂载实例', instance)
  for (const item of [phase, activation, route, elapsed, identity]) details.append(item.node)
  detailsCard.append(details)
  const logCard = card('事件记录', '仅保留当前挂载最近 16 条事件，不记录草稿内容。')
  const eventLog = element('ol', '', 'test-log')
  logCard.append(eventLog)
  lifecycle.append(detailsCard, logCard)
  root.append(header, introduction, tabs, interaction, lifecycle)
  container.replaceChildren(root)

  function log(message) {
    if (disposed) return
    events.unshift({ time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), message })
    events.splice(LOG_LIMIT)
    eventLog.replaceChildren(...events.map(item => {
      const entry = element('li')
      entry.append(element('time', item.time), document.createTextNode(item.message))
      return entry
    }))
  }
  function render() {
    if (disposed) return
    const dirty = draft.value !== savedDraft
    closeStatus.textContent = dirty && task ? '草稿未保存 · 任务运行中' : dirty ? '草稿未保存' : task ? '任务运行中' : '可以关闭'
    closeStatus.dataset.blocked = String(dirty || !!task)
    startButton.disabled = !!task; cancelButton.disabled = !task
    saveButton.disabled = !dirty; discardButton.disabled = !dirty
    phase.content.textContent = active ? '活动中' : '已挂载 · 未激活'
    activation.content.textContent = reason
    elapsed.content.textContent = `${ticks} 秒`
  }
  function renderRoute() {
    if (disposed) return
    const current = context.route.read() || '/'
    const showLifecycle = current === '/lifecycle'
    interaction.hidden = showLifecycle; lifecycle.hidden = !showLifecycle
    for (const [tab, selected] of [[interactionTab, !showLifecycle], [lifecycleTab, showLifecycle]]) {
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1
    }
    route.content.textContent = current
  }
  function stopTicker() { if (ticker !== undefined) { clearInterval(ticker); ticker = undefined } }
  function startTask() {
    if (task || disposed) return
    let resolve
    const running = { timer: undefined, done: new Promise(done => { resolve = done }), finish: null }
    running.finish = message => {
      if (task !== running) return
      clearTimeout(running.timer); running.timer = undefined; task = null
      if (!disposed) { taskStatus.textContent = message; log(`模拟任务${message}`); render() }
      resolve()
    }
    task = running
    taskStatus.textContent = '运行中 · 最多 5 秒'; log('模拟任务已启动'); render()
    running.timer = setTimeout(() => running.finish('已完成'), 5000)
  }
  async function cancelTask() {
    const running = task
    if (!running) return
    running.finish('已取消')
    await running.done
  }
  function dispose() {
    if (disposal) return disposal
    disposed = true; active = false; stopTicker(); unsubscribeRoute()
    context.signal.removeEventListener('abort', abort)
    for (const remove of listeners.splice(0)) remove()
    disposal = cancelTask().then(() => { container.replaceChildren() })
    return disposal
  }
  function abort() { void dispose() }
  on(tabs, 'keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const target = event.key === 'Home' ? interactionTab : event.key === 'End' ? lifecycleTab :
      document.activeElement === interactionTab ? lifecycleTab : interactionTab
    target.click(); target.focus()
  })
  unsubscribeRoute = context.route.subscribe(() => { renderRoute(); log(`路由变更：${context.route.read() || '/'}`) })
  context.signal.addEventListener('abort', abort, { once: true })
  draftStatus.textContent = storageError ? '本地存储不可用，保存可能失败。' : savedDraft ? '已载入上次保存的草稿' : '尚无已保存的草稿'
  log('界面已挂载'); renderRoute(); render()
  if (context.signal.aborted) await dispose()
  return {
    setActive(next, nextReason) {
      if (disposed) return
      active = next; reason = nextReason; stopTicker()
      if (active) ticker = setInterval(() => { if (!disposed && active) { ticks += 1; render() } }, 1000)
      log(`${active ? '激活' : '停用'}界面：${reason}`); render()
    },
    canClose: () => disposed || (!task && draft.value === savedDraft),
    dispose,
  }
}

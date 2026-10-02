import type { ProjectView } from './client-types.js'
import type { ProjectDirectoryTarget } from './harness-client.js'
import { createDirectoryPositions, createProjectDirectoryController } from './project-directory-client.js'

const messages: Readonly<Record<string, string>> = {
  'directory-permission-denied': '目标 Harness 的运行账户没有访问此目录的权限。请选择可访问的目录，或返回主目录。',
  'directory-missing': '此目录已删除或路径不存在。保留了输入，你可以重试、修改路径或返回主目录。',
  'directory-not-directory': '此路径不是目录。请输入已有文件夹的绝对路径。',
  'directory-link-loop': '此符号链接形成循环，无法进入。',
  'directory-unavailable': '目标目录暂时无法读取，请重试。',
  'directory-browse-invalid': '目录路径或浏览参数无效，请检查后重试。',
  'directory-browse-expired': '目录浏览已过期，请重试重新读取当前位置。',
  'directory-browse-conflict': '目录页已改变，请重新读取当前位置。',
  'directory-browse-busy': '目标设备正在处理其他目录请求，请稍后重试。',
  'directory-browse-unsupported': '该 Harness 暂不支持目录浏览，请升级远端 Harness 后重新打开。',
  'directory-browse-cleanup-failed': '目录句柄未能正常关闭，请重启目标 Harness 后重试。',
  'directory-browse-cancelled': '目录读取已取消，可以重试。',
  'connection-changed': '此连接的配置已改变。为避免提交到错误设备，请关闭窗口、刷新页面后重新选择。',
  'instance-mismatch': '此地址的实例身份已改变，已阻止浏览和提交。请关闭窗口并检查连接。',
}
export function directoryMessageFor(error: unknown, fallback: (error: unknown) => string): string {
  const code = error instanceof Error && 'code' in error ? String(error.code) : ''
  return messages[code] ?? fallback(error)
}

/** Owns one modal at a time. The controller and its fixed connection die with that modal. */
export function setupProjectDirectoryPicker(messageFor: (error: unknown) => string, selected: (project: ProjectView) => void, root: ParentNode) {
  const positions = createDirectoryPositions({ getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) })
  let active: { close(): void } | undefined, disposed = false
  return {
    open(target: ProjectDirectoryTarget, trigger: HTMLElement): void {
      if (disposed || active) return
      const dialog = document.createElement('dialog')
      dialog.className = 'settings-dialog project-directory-dialog'
      dialog.setAttribute('aria-labelledby', 'agent--project-directory-title')
      dialog.innerHTML = `<header class="settings-heading"><h2 id="agent--project-directory-title"></h2><button type="button" class="close-settings" data-cancel aria-label="取消选择项目目录">×</button></header>
        <div class="project-directory-body">
          <p class="project-directory-compat" data-compat hidden>此 Harness 版本不支持浏览目录。升级远端 Harness 后即可逐层选择；当前可以填写目标设备上已有文件夹的绝对路径。</p>
          <div class="project-directory-toolbar"><button type="button" class="secondary-button" data-parent>↑ 上一级</button><button type="button" class="secondary-button" data-home>⌂ 主目录</button><button type="button" class="secondary-button" data-native hidden>使用系统目录窗口</button></div>
          <nav class="project-directory-breadcrumbs" aria-label="当前目录层级" data-breadcrumbs></nav>
          <form class="project-directory-path" data-path-form><label for="agent--project-directory-path">目标设备上的路径</label><div><input id="agent--project-directory-path" data-path autocomplete="off" spellcheck="false" placeholder="由目标设备提供主目录"><button type="submit" class="secondary-button" data-jump>前往</button></div></form>
          <div class="project-directory-filters" data-filters><label>筛选当前目录<input data-filter type="search" placeholder="子目录名称" autocomplete="off"></label><label class="project-directory-hidden"><input data-hidden type="checkbox">显示隐藏目录</label></div>
          <p class="project-directory-status" data-status role="status" aria-live="polite"></p>
          <div class="project-directory-error" data-error hidden><p data-error-message role="alert"></p><button type="button" class="secondary-button" data-retry>重试</button></div>
          <ul class="project-directory-list" data-list aria-label="子目录" aria-describedby="agent--project-directory-help" tabindex="0"></ul>
          <div class="project-directory-pagination" data-pagination><span data-page></span><button type="button" class="secondary-button" data-restart>重新读取</button><button type="button" class="secondary-button" data-next hidden>下一页</button></div>
          <p class="settings-hint" id="agent--project-directory-help">双击或按 Enter 进入文件夹，↑↓ 移动焦点，Alt+↑ 返回上一级。选择按钮会登记当前路径。</p>
        </div><footer class="project-directory-footer"><button type="button" class="secondary-button" data-cancel>取消</button><button type="button" data-select>选择当前文件夹</button></footer>`
      root.appendChild(dialog)
      const get = <T extends HTMLElement>(selector: string) => dialog.querySelector<T>(selector)!
      get('h2').textContent = `选择项目目录 · ${target.connection.name}`
      const path = get<HTMLInputElement>('[data-path]'), filter = get<HTMLInputElement>('[data-filter]'), hidden = get<HTMLInputElement>('[data-hidden]')
      const list = get<HTMLUListElement>('[data-list]'), breadcrumbs = get<HTMLElement>('[data-breadcrumbs]')
      const listeners = new AbortController(), options = { signal: listeners.signal }
      let lastPage: unknown, rowFocus = '', closing = false, focusAfterLoad = false
      const controller = createProjectDirectoryController(target, { positions, changed: render, selected(project) { close(); selected(project) } })
      function close(): void {
        if (closing) return
        closing = true; controller.close(); listeners.abort(); dialog.close(); dialog.remove(); active = undefined
        if (!disposed) {
          const restore = trigger.isConnected && trigger.getClientRects().length ? trigger : root.querySelector<HTMLElement>('#agent--toggle-sidebar')
          restore?.focus({ preventScroll: true })
        }
      }
      function rows(): HTMLButtonElement[] { return [...list.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')] }
      function render(): void {
        if (closing) return
        const state = controller.snapshot(), busy = state.loading || state.submitting, browsing = state.mode === 'browse'
        const error = state.error ? directoryMessageFor(state.error, messageFor) : ''
        path.value = state.pathInput; filter.value = state.query; hidden.checked = state.showHidden
        path.disabled = state.submitting || state.blocked; filter.disabled = state.submitting || state.blocked
        hidden.disabled = state.submitting || state.blocked
        get('[data-compat]').hidden = state.mode !== 'manual'
        get('#agent--project-directory-help').textContent = state.mode === 'manual'
          ? '填写目标设备上已有文件夹的绝对路径，点击“选择当前文件夹”后校验并登记。'
          : '双击或按 Enter 进入文件夹，↑↓ 移动焦点，Alt+↑ 返回上一级。选择按钮会登记当前路径。'
        get('[data-filters]').hidden = !browsing
        list.hidden = !browsing; get('[data-pagination]').hidden = !browsing
        breadcrumbs.hidden = !browsing
        get('[data-home]').hidden = !browsing; get('[data-parent]').hidden = !browsing
        get('[data-jump]').hidden = !browsing
        get<HTMLButtonElement>('[data-jump]').disabled = state.submitting || state.blocked || !state.pathInput
        get<HTMLButtonElement>('[data-home]').disabled = state.submitting || state.blocked
        get<HTMLButtonElement>('[data-parent]').disabled = !state.page?.parentPath || state.submitting || state.blocked
        get('[data-native]').hidden = !state.nativeAvailable
        get<HTMLButtonElement>('[data-native]').disabled = busy || state.blocked
        get<HTMLButtonElement>('[data-select]').disabled = !state.canSelect
        get('[data-select]').textContent = state.submitting ? '正在添加…' : '选择当前文件夹'
        for (const button of dialog.querySelectorAll<HTMLButtonElement>('[data-cancel]')) button.disabled = state.submitting
        get('[data-error]').hidden = !error; get('[data-error-message]').textContent = error
        get<HTMLButtonElement>('[data-retry]').hidden = state.blocked
        get<HTMLButtonElement>('[data-retry]').disabled = busy
        const dirty = !!state.page && state.pathInput !== state.page.path
        get('[data-status]').textContent = state.submitting ? '正在目标设备登记项目…' : state.loading ? '正在读取目标设备目录…'
          : error ? (state.page ? `保留上次浏览位置：${state.page.path}` : '')
          : state.mode === 'manual' ? '确认后将在上述目标设备校验并登记该路径。'
          : dirty ? '路径已编辑，按 Enter 或点击“前往”读取后再选择。'
          : state.page?.entries.length === 0 ? (state.page.nextPage !== null ? '这一页没有匹配的子目录，可以继续下一页。' : state.page.page > 0 ? '已读完此目录，没有更多匹配的子目录。' : state.query ? '没有匹配的子目录。' : state.showHidden ? '当前目录没有子目录。' : '当前目录没有可见子目录，可以尝试显示隐藏目录。') : state.page ? `当前位置：${state.page.path}` : ''
        list.setAttribute('aria-busy', String(state.loading)); list.setAttribute('aria-disabled', String(busy || !!error || state.blocked))
        get('[data-page]').textContent = state.page ? `第 ${state.page.page + 1} 页 · ${state.page.entries.length} 个目录` : ''
        get('[data-next]').hidden = state.page?.nextPage === null || state.page?.nextPage === undefined
        get<HTMLButtonElement>('[data-next]').disabled = busy || !!error || state.blocked
        get<HTMLButtonElement>('[data-restart]').disabled = busy || state.blocked
        if (state.page !== lastPage) {
          const hadListFocus = list.contains(document.activeElement) || focusAfterLoad
          lastPage = state.page
          breadcrumbs.replaceChildren(...(state.page?.breadcrumbs ?? []).map((part, index, all) => {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary-button'
            button.textContent = part.name; button.dataset.directoryPath = part.path
            if (index === all.length - 1) button.setAttribute('aria-current', 'location')
            button.addEventListener('click', () => { void controller.navigate(part.path) }, options)
            return button
          }))
          list.replaceChildren(...(state.page?.entries ?? []).map(entry => {
            const item = document.createElement('li'), button = document.createElement('button')
            button.type = 'button'; button.dataset.directoryPath = entry.path; button.dataset.unavailable = String(!!entry.reason)
            button.disabled = !!entry.reason
            button.className = 'project-directory-entry'; button.tabIndex = -1
            const name = document.createElement('span'), detail = document.createElement('small')
            name.textContent = entry.name; detail.textContent = entry.reason ? (messages[entry.reason] ?? '此目录暂不可用') : entry.kind === 'symlink' ? '符号链接' : '文件夹'
            button.append(name, detail)
            button.addEventListener('focus', () => { rowFocus = entry.path; for (const row of rows()) row.tabIndex = row === button ? 0 : -1 }, options)
            button.addEventListener('dblclick', () => { if (!button.disabled) void controller.navigate(entry.path) }, options)
            button.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void controller.navigate(entry.path) } }, options)
            item.append(button); return item
          }))
          const focus = rows().find(row => row.dataset.directoryPath === rowFocus) ?? rows()[0]
          if (focus) focus.tabIndex = 0
          if (hadListFocus) { (focus ?? list).focus({ preventScroll: true }); focusAfterLoad = false }
        }
        if (busy && list.contains(document.activeElement) && document.activeElement !== list) { focusAfterLoad = true; list.focus({ preventScroll: true }) }
        for (const button of list.querySelectorAll<HTMLButtonElement>('button')) button.disabled = busy || !!error || state.blocked || button.dataset.unavailable === 'true'
        if (!busy && !error) {
          const values = rows(), focus = values.find(row => row.dataset.directoryPath === rowFocus) ?? values[0]
          for (const button of values) button.tabIndex = button === focus ? 0 : -1
          if (focusAfterLoad && document.activeElement === list) { (focus ?? list).focus({ preventScroll: true }); focusAfterLoad = false }
        }
        for (const button of breadcrumbs.querySelectorAll<HTMLButtonElement>('button')) button.disabled = state.submitting || state.blocked
      }
      get<HTMLFormElement>('[data-path-form]').addEventListener('submit', event => { event.preventDefault(); if (controller.snapshot().mode === 'browse' && path.value) void controller.navigate(path.value) }, options)
      path.addEventListener('input', () => controller.setPath(path.value), options)
      filter.addEventListener('input', () => controller.filter(filter.value, hidden.checked), options)
      hidden.addEventListener('change', () => controller.filter(filter.value, hidden.checked), options)
      get('[data-home]').addEventListener('click', () => { void controller.navigate() }, options)
      get('[data-parent]').addEventListener('click', () => { const parent = controller.snapshot().page?.parentPath; if (parent) void controller.navigate(parent) }, options)
      get('[data-retry]').addEventListener('click', () => { void controller.retry() }, options)
      get('[data-next]').addEventListener('click', () => { void controller.next() }, options)
      get('[data-restart]').addEventListener('click', () => { void controller.restart() }, options)
      get('[data-native]').addEventListener('click', () => { void controller.pickNative() }, options)
      get('[data-select]').addEventListener('click', () => { void controller.submit() }, options)
      for (const button of dialog.querySelectorAll('[data-cancel]')) button.addEventListener('click', close, options)
      dialog.addEventListener('cancel', event => { event.preventDefault(); if (!controller.snapshot().submitting) close() }, options)
      dialog.addEventListener('close', close, options)
      dialog.addEventListener('keydown', event => {
        if (event.altKey && event.key === 'ArrowUp') {
          event.preventDefault(); const parent = controller.snapshot().page?.parentPath; if (parent) void controller.navigate(parent)
        }
        if (!list.contains(event.target as Node) || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault(); const values = rows(), index = values.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? values.length - 1 : event.key === 'ArrowDown' ? Math.min(values.length - 1, index + 1) : Math.max(0, index - 1)
        values[next]?.focus()
      }, options)
      active = { close }; render(); dialog.showModal(); path.focus(); void controller.initialize()
    },
    dispose() { disposed = true; active?.close() },
  }
}

// Test-only browser entry implementing the production mount contract.
export async function mount(container, context) {
  container.innerHTML = `<section class="test-application"><h2>Notes</h2><label>Draft <input></label><button data-save>保存</button><button data-route>下一页</button><button data-background>后台导航</button><button data-hold>延迟退出</button><output></output><p data-state></p><div class="test-scroll" tabindex="0">${'<p>Scroll position is local to this application.</p>'.repeat(35)}</div></section>`
  const input = container.querySelector('input'), output = container.querySelector('output'), state = container.querySelector('[data-state]')
  input.id = context.domId('draft'); container.querySelector('label').htmlFor = input.id
  let saved = '', held = false, timer
  const writes = new Set()
  const response = await fetch(`${context.apiBase}/value`, { signal: context.signal }); input.value = saved = (await response.json()).value
  const routeChanged = () => { output.textContent = context.route.read() || 'home' }
  const unsubscribe = context.route.subscribe(routeChanged); routeChanged()
  container.querySelector('[data-save]').onclick = () => {
    const value = input.value
    const write = fetch(`${context.apiBase}/value`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value }) })
      .then(response => { if (!response.ok) throw new Error('save failed'); saved = value })
      .finally(() => writes.delete(write))
    writes.add(write)
  }
  container.querySelector('[data-route]').onclick = () => context.route.navigate(`page-${Date.now()}`)
  container.querySelector('[data-background]').onclick = () => { timer = setTimeout(() => context.route.navigate('background'), 2000) }
  container.querySelector('[data-hold]').onclick = () => { held = !held; state.textContent = held ? '退出将等待' : '' }
  return {
    setActive(active, reason) { state.dataset.active = String(active); state.dataset.reason = reason },
    canClose: () => input.value === saved,
    async dispose() { unsubscribe(); clearTimeout(timer); await Promise.allSettled([...writes]); if (held) await new Promise(resolve => setTimeout(resolve, 500)); container.replaceChildren() },
  }
}

export function mount(container, context) {
  container.testContext = context
  container.dataset.apiBase = context.apiBase ?? 'none'
  const content = document.createElement('p')
  content.textContent = 'Mounted application'
  container.append(content)
  return {
    setActive(active) { container.dataset.active = String(active) },
    canClose: () => container.dataset.blockClose !== 'true',
    dispose() {
      if (container.dataset.failDispose === 'true') throw new Error('Local interface cleanup failed')
      container.dataset.disposed = 'true'
    },
  }
}

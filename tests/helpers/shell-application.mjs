export function mount(container, context) {
  container.dataset.mounts = String(Number(container.dataset.mounts ?? 0) + 1)
  container.testContext = context
  container.dataset.apiBase = context.apiBase ?? 'none'
  const content = document.createElement('p')
  content.textContent = 'Mounted application'
  container.append(content)
  return {
    setActive(active) { container.dataset.activations = String(Number(container.dataset.activations ?? 0) + 1); container.dataset.active = String(active) },
    canClose() { container.dataset.closeChecks = String(Number(container.dataset.closeChecks ?? 0) + 1); return container.dataset.blockClose !== 'true' },
    dispose() {
      if (container.dataset.failDispose === 'true') throw new Error('Local interface cleanup failed')
      container.dataset.disposed = 'true'
    },
  }
}

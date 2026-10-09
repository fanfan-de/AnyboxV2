export function mount(container) {
  const content = document.createElement('p')
  content.textContent = 'Mounted application'
  container.append(content)
  return {
    setActive(active) { container.dataset.active = String(active) },
    canClose: () => true,
    dispose() {
      if (container.dataset.failDispose === 'true') throw new Error('Local interface cleanup failed')
      container.dataset.disposed = 'true'
    },
  }
}

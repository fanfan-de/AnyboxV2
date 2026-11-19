import { createAgentLogo } from './agent-logo.js'
import { agentLogoPresets } from './agent-logo-presets.js'

const maximumBytes = 32 * 1024
const utf8 = new TextEncoder()

export function setupAgentLogoEditor(container: HTMLFieldSetElement, changed: () => void) {
  const get = <T extends HTMLElement>(selector: string) => container.querySelector<T>(selector)!
  const input = get<HTMLTextAreaElement>('[data-agent-logo-shader]')
  const play = get<HTMLButtonElement>('[data-agent-logo-play]')
  const clear = get<HTMLButtonElement>('[data-agent-logo-clear]')
  const status = get<HTMLElement>('[data-agent-logo-status]')
  const gallery = get<HTMLElement>('[data-agent-logo-presets]')
  const preview = createAgentLogo(get('[data-agent-logo-preview]'), { size: 76 })
  const small = createAgentLogo(get('[data-agent-logo-small-preview]'), { size: 24 })
  const controller = new AbortController()
  const options = { signal: controller.signal }
  let savedSource: string | null = null, savedInput = ''
  // Textarea normalizes CRLF. Preserve the exact saved source until the user edits it.
  const read = () => input.value === savedInput ? savedSource : input.value.trim() ? input.value : null
  let name = '', renderedName: string | undefined, renderedSource: string | null | undefined
  let error = '', available = false, timer: number | undefined

  const presets = agentLogoPresets.map(preset => {
    const button = document.createElement('button'), icon = document.createElement('span'), label = document.createElement('span')
    button.type = 'button'
    button.className = 'secondary-button agent-logo-preset'
    button.dataset.agentLogoPreset = preset.id
    label.textContent = `载入${preset.name}`
    button.append(icon, label)
    gallery.append(button)
    const logo = createAgentLogo(icon, { size: 34 })
    button.addEventListener('click', () => {
      input.value = preset.source
      update()
      changed()
    }, options)
    return { preset, logo }
  })
  let presetsDrawn = false

  function renderStatus() {
    const source = read()
    play.disabled = !source || Boolean(error) || !available || timer !== undefined
    clear.disabled = !input.value
    input.setAttribute('aria-invalid', String(timer === undefined && Boolean(error)))
    status.dataset.error = String(timer === undefined && Boolean(error))
    status.textContent = timer !== undefined ? '正在检查 Shader…' : error || (source && !available ? '此浏览器无法预览 WebGL，头像会显示为名称首字。' : '')
    status.hidden = !status.textContent
  }

  function draw(source: string | null) {
    renderedName = name
    renderedSource = source
    error = source && utf8.encode(source).byteLength > maximumBytes ? 'Shader 源码不能超过 32 KiB。'
      : source && (!/\bvec3\s+paint\s*\(/u.test(source) || source.includes('\0')) ? '请输入包含 vec3 paint(vec2 uv, float t, float edge) 的 GLSL。' : ''
    const avatar = { name, ...(source && !error ? { logoShader: source } : {}) }
    preview.set(avatar)
    small.set(avatar)
    if (!error) error = preview.error() ?? ''
    available = Boolean(source && !error && preview.available())
  }

  function update() {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const source = read()
    if (source !== renderedSource || name !== renderedName) draw(source)
    renderStatus()
  }

  input.addEventListener('input', () => {
    preview.pause()
    if (timer !== undefined) clearTimeout(timer)
    timer = window.setTimeout(() => { update(); changed() }, 180)
    renderStatus()
    changed()
  }, options)
  play.addEventListener('click', () => {
    update()
    preview.play()
  }, options)
  clear.addEventListener('click', () => {
    input.value = ''
    update()
    changed()
  }, options)

  return {
    read,
    valid: () => timer === undefined && !error,
    set(source: string | null | undefined) {
      savedSource = source ?? null
      input.value = savedSource ?? ''
      savedInput = input.value
      update()
    },
    render(agentName: string, disabled: boolean, visible: boolean) {
      name = agentName
      container.disabled = disabled
      if (visible && !presetsDrawn) {
        presetsDrawn = true
        for (const { preset, logo } of presets) logo.set({ name: preset.name, logoShader: preset.source })
      }
      if (timer === undefined) update()
    },
    pause: () => preview.pause(),
    dispose() {
      if (timer !== undefined) clearTimeout(timer)
      controller.abort()
      preview.dispose()
      small.dispose()
      for (const { logo } of presets) logo.dispose()
    },
  }
}

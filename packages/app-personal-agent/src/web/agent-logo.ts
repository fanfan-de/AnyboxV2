const surfaceSize = 192
const programLimit = 16
const duration = 5_000

const vertexSource = `#version 300 es
out vec2 uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

function fragmentSource(source: string): string {
  return `#version 300 es
precision highp float;
in vec2 uv;
out vec4 outputColor;
uniform float u_seed;
uniform float u_density;
uniform float u_time;
uniform vec3 u_base;
uniform vec3 u_light;
#line 1
${source}
#line 10000
void main() {
  float radius = length(uv * 2.0 - 1.0);
  float alpha = 1.0 - smoothstep(1.0 - fwidth(radius), 1.0, radius);
  if (alpha <= 0.0) { outputColor = vec4(0.0); return; }
  vec3 color = clamp(paint(uv, u_time, smoothstep(0.78, 1.0, radius)), 0.0, 1.0);
  outputColor = vec4(color, alpha);
}`
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('无法创建 Shader。')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader
  const message = gl.getShaderInfoLog(shader)?.trim() || 'Shader 编译失败。'
  gl.deleteShader(shader)
  throw new Error(message.slice(0, 1_200))
}

const uniforms = ['u_seed', 'u_density', 'u_time', 'u_base', 'u_light'] as const
interface CompiledLogo {
  readonly program: WebGLProgram
  readonly uniforms: Record<typeof uniforms[number], WebGLUniformLocation | null>
}

function link(gl: WebGL2RenderingContext, source: string): CompiledLogo {
  if (!/\bvec3\s+paint\s*\(/u.test(source)) throw new Error('请输入包含 vec3 paint(vec2 uv, float t, float edge) 的 GLSL。')
  const program = gl.createProgram()
  if (!program) throw new Error('无法创建 Shader 程序。')
  let vertex: WebGLShader | undefined, fragment: WebGLShader | undefined
  try {
    vertex = compile(gl, gl.VERTEX_SHADER, vertexSource)
    fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource(source))
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program)?.trim().slice(0, 1_200) || 'Shader 链接失败。')
    return { program, uniforms: Object.fromEntries(uniforms.map(name => [name, gl.getUniformLocation(program, name)])) as CompiledLogo['uniforms'] }
  } catch (error) {
    gl.deleteProgram(program)
    throw error
  } finally {
    if (vertex) gl.deleteShader(vertex)
    if (fragment) gl.deleteShader(fragment)
  }
}

function createRenderer(document: Document) {
  const surface = document.createElement('canvas')
  surface.width = surface.height = surfaceSize
  let gl: WebGL2RenderingContext | null = null
  try { gl = surface.getContext('webgl2', { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: false }) }
  catch { /* A blocked GPU environment uses the text avatar. */ }
  const context = gl
  const programs = new Map<string, CompiledLogo | Error>()
  const consumers = new Set<() => void>()
  const lost = (event: Event) => { event.preventDefault(); programs.clear() }
  const restored = () => { for (const repaint of consumers) repaint() }
  surface.addEventListener('webglcontextlost', lost)
  surface.addEventListener('webglcontextrestored', restored)

  return {
    consumers,
    available: () => context !== null && !context.isContextLost(),
    draw(target: CanvasRenderingContext2D, source: string, seconds: number): boolean {
      if (!context || context.isContextLost()) return false
      let entry = programs.get(source)
      if (entry) programs.delete(source)
      else {
        try { entry = link(context, source) }
        catch (error) { entry = error instanceof Error ? error : new Error('Shader 编译失败。') }
      }
      programs.set(source, entry)
      if (programs.size > programLimit) {
        const oldest = programs.keys().next().value!
        const discarded = programs.get(oldest)!
        programs.delete(oldest)
        if (!(discarded instanceof Error)) context.deleteProgram(discarded.program)
      }
      if (context.isContextLost()) return false
      if (entry instanceof Error) throw entry

      const { width, height } = target.canvas
      context.viewport(0, surfaceSize - height, width, height)
      context.useProgram(entry.program)
      context.uniform1f(entry.uniforms.u_seed, 0.42)
      context.uniform1f(entry.uniforms.u_density, 0.65)
      context.uniform1f(entry.uniforms.u_time, seconds)
      context.uniform3f(entry.uniforms.u_base, 0.27, 0.30, 0.56)
      context.uniform3f(entry.uniforms.u_light, 0.85, 0.75, 0.96)
      context.drawArrays(context.TRIANGLES, 0, 3)
      if (context.isContextLost()) return false
      target.clearRect(0, 0, width, height)
      target.drawImage(surface, 0, 0, width, height, 0, 0, width, height)
      return true
    },
    dispose() {
      surface.removeEventListener('webglcontextlost', lost)
      surface.removeEventListener('webglcontextrestored', restored)
      if (context && !context.isContextLost()) {
        for (const entry of programs.values()) if (!(entry instanceof Error)) context.deleteProgram(entry.program)
        context.getExtension('WEBGL_lose_context')?.loseContext()
      }
      programs.clear()
    },
  }
}

type Renderer = ReturnType<typeof createRenderer>
const renderers = new WeakMap<Document, Renderer>()

/** A text fallback is present until a frame is drawn. Compact avatars render a single still. */
export function createAgentLogo(host: HTMLElement, options: { size?: number } = {}) {
  const document = host.ownerDocument, window = document.defaultView
  const size = options.size ?? 32
  const pixels = Math.max(1, Math.min(surfaceSize, Math.round(size * (window?.devicePixelRatio ?? 1))))
  const element = document.createElement('span'), initial = document.createElement('span'), canvas = document.createElement('canvas')
  element.className = 'agent-logo'
  element.setAttribute('aria-hidden', 'true')
  element.style.setProperty('--agent-logo-size', `${size}px`)
  initial.className = 'agent-logo__initial'
  initial.textContent = 'A'
  canvas.className = 'agent-logo__canvas'
  canvas.width = canvas.height = pixels
  canvas.hidden = true
  element.append(initial, canvas)
  host.append(element)

  let renderer: Renderer | undefined, target: CanvasRenderingContext2D | null | undefined
  let source: string | undefined, message: string | undefined, frame: number | undefined
  let disposed = false

  function acquire(): Renderer {
    if (!renderer) {
      renderer = renderers.get(document) ?? createRenderer(document)
      renderers.set(document, renderer)
      renderer.consumers.add(repaint)
    }
    return renderer
  }

  function draw(seconds: number): boolean {
    message = undefined
    let drawn = false
    if (source) {
      target ??= canvas.getContext('2d')
      if (target) {
        try { drawn = acquire().draw(target, source, seconds) }
        catch (error) { message = error instanceof Error ? error.message : 'Shader 绘制失败。' }
      }
    }
    canvas.hidden = !drawn
    initial.hidden = drawn
    return drawn
  }

  function pause() {
    if (frame !== undefined) window?.cancelAnimationFrame(frame)
    frame = undefined
  }

  function repaint() { pause(); draw(0) }

  return {
    set({ name, logoShader }: { readonly name: string; readonly logoShader?: string | null }) {
      if (disposed) return
      initial.textContent = Array.from(name.trim())[0]?.toLocaleUpperCase() || 'A'
      const next = logoShader?.trim() ? logoShader : undefined
      if (source !== next) { source = next; repaint() }
    },
    available: () => !disposed && acquire().available(),
    error: () => message,
    play() {
      if (!window || !source || disposed) return false
      pause()
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return draw(1.25)
      if (!draw(0)) return false
      const start = window.performance.now()
      let last = start
      const tick = (now: number) => {
        frame = undefined
        const elapsed = now - start
        if ((elapsed >= duration || now - last >= 1_000 / 30) && !draw(Math.min(duration, elapsed) / 1_000)) return
        if (now - last >= 1_000 / 30) last = now
        if (elapsed < duration) frame = window.requestAnimationFrame(tick)
      }
      frame = window.requestAnimationFrame(tick)
      return true
    },
    pause,
    dispose() {
      if (disposed) return
      disposed = true
      pause()
      element.remove()
      renderer?.consumers.delete(repaint)
      if (renderer?.consumers.size === 0) {
        renderer.dispose()
        renderers.delete(document)
      }
      renderer = undefined
    },
  }
}

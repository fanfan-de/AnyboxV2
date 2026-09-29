import type { ProtocolViewSnapshot } from './types.js'
import { decodeProtocolView, reduceProtocolView, mountProtocolTurn, type MountedProtocolTurn } from './view.js'

export type { MountedProtocolTurn } from './view.js'

/** A protocol owns the browser input/view boundary; the shared Session owns requests and layout. */
export interface ProtocolWebModule {
  readonly protocolId: string
  readonly imageInput: boolean
  encodeInput(text: string, imageCount?: number): string
  decode(value: unknown): ProtocolViewSnapshot | undefined
  reduce(current: ProtocolViewSnapshot | undefined, next: ProtocolViewSnapshot): ProtocolViewSnapshot | undefined
  mount(initial: ProtocolViewSnapshot): MountedProtocolTurn
}

/** Text is sent unchanged. Prompt/template expansion belongs exclusively to the server. */
function encodeTextInput(text: string, imageCount = 0): string {
  if (typeof text !== 'string' || (!text.trim() && !imageCount)) throw new TypeError('请输入消息或添加图片。')
  return text
}

function bindTextProtocol(protocolId: string, name: string): ProtocolWebModule {
  const imageInput = protocolId === 'chat-completions' || protocolId === 'deepseek-chat-completions'
  const decode = (value: unknown): ProtocolViewSnapshot | undefined => {
    const snapshot = decodeProtocolView(value)
    return snapshot?.protocolId === protocolId ? snapshot : undefined
  }
  const reduce = (current: ProtocolViewSnapshot | undefined, next: ProtocolViewSnapshot): ProtocolViewSnapshot | undefined => {
    if (next.protocolId !== protocolId || (current && current.protocolId !== protocolId)) return current
    return reduceProtocolView(current, next)
  }
  return Object.freeze({ protocolId, imageInput, encodeInput(text: string, imageCount = 0) {
    if (imageCount && !imageInput) throw new TypeError('此协议暂不支持图片输入。')
    return encodeTextInput(text, imageCount)
  }, decode, reduce,
    mount(initial: ProtocolViewSnapshot) {
      const snapshot = decode(initial)
      if (!snapshot) throw new TypeError('此协议的视图不兼容。')
      return mountProtocolTurn(snapshot, { name, reduce })
    },
  })
}

export const responsesWebModule = bindTextProtocol('responses', 'Responses')
export const chatWebModule = bindTextProtocol('chat-completions', 'Chat Completions')
export const deepSeekWebModule = bindTextProtocol('deepseek-chat-completions', 'DeepSeek')
export const anthropicWebModule = bindTextProtocol('anthropic-messages', 'Anthropic')
export const geminiWebModule = bindTextProtocol('gemini-interactions', 'Gemini')

const modules = new Map([responsesWebModule, chatWebModule, deepSeekWebModule, anthropicWebModule, geminiWebModule]
  .map(module => [module.protocolId, module]))

export function getProtocolWebModule(protocolId: unknown): ProtocolWebModule | undefined {
  return typeof protocolId === 'string' ? modules.get(protocolId) : undefined
}

/** SSE has only an untrusted envelope until the selected module decodes its payload. */
export function decodeProtocolWebView(value: unknown): ProtocolViewSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return getProtocolWebModule((value as Record<string, unknown>).protocolId)?.decode(value)
}

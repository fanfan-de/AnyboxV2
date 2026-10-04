import type { ProtocolViewSnapshot } from '../../core/view/types.js'
import { decodeProtocolView, reduceProtocolView, mountProtocolTurn, type MountedProtocolTurn, type ProtocolTurnOptions, type NativeBlockContext, type MountedNativeBlock } from './view.js'
import type { ProtocolViewBlock, ProtocolViewExchange } from '../../core/view/types.js'
import { mountResponsesBlock, responsesStateText } from './responses.js'
import { mountAnthropicBlock, anthropicStateText } from './anthropic.js'
import { mountChatBlock, chatStateText } from './chat.js'
import { mountGeminiBlock, geminiStateText } from './gemini.js'

export type { MountedProtocolTurn } from './view.js'

/** A protocol owns the browser input/view boundary; the shared Session owns requests and layout. */
export interface ProtocolWebModule {
  readonly protocolId: string
  readonly imageInput: boolean
  encodeInput(text: string, imageCount?: number, fileCount?: number): string
  decode(value: unknown): ProtocolViewSnapshot | undefined
  reduce(current: ProtocolViewSnapshot | undefined, next: ProtocolViewSnapshot): ProtocolViewSnapshot | undefined
  mount(initial: ProtocolViewSnapshot, options?: ProtocolTurnOptions): MountedProtocolTurn
}

/** Text is sent unchanged. Prompt/template expansion belongs exclusively to the server. */
function encodeTextInput(text: string, imageCount = 0, fileCount = 0): string {
  if (typeof text !== 'string' || (!text.trim() && !imageCount && !fileCount)) throw new TypeError('请输入消息、添加图片或引用项目文件。')
  return text
}

function bindProtocol(protocolId: string, name: string,
  mountBlock: (block: ProtocolViewBlock, context: NativeBlockContext) => MountedNativeBlock,
  stateText: (exchange: ProtocolViewExchange, presentation?: NativeBlockContext['presentation']) => string): ProtocolWebModule {
  const imageInput = true
  const decode = (value: unknown): ProtocolViewSnapshot | undefined => {
    const snapshot = decodeProtocolView(value)
    return snapshot?.protocolId === protocolId ? snapshot : undefined
  }
  const reduce = (current: ProtocolViewSnapshot | undefined, next: ProtocolViewSnapshot): ProtocolViewSnapshot | undefined => {
    if (next.protocolId !== protocolId || (current && current.protocolId !== protocolId)) return current
    return reduceProtocolView(current, next)
  }
  return Object.freeze({ protocolId, imageInput, encodeInput(text: string, imageCount = 0, fileCount = 0) {
    return encodeTextInput(text, imageCount, fileCount)
  }, decode, reduce,
    mount(initial: ProtocolViewSnapshot, options?: ProtocolTurnOptions) {
      const snapshot = decode(initial)
      if (!snapshot) throw new TypeError('此协议的视图不兼容。')
      return mountProtocolTurn(snapshot, { name, reduce, mountBlock, stateText }, options)
    },
  })
}

export const responsesWebModule = bindProtocol('responses', 'Responses', mountResponsesBlock, responsesStateText)
export const chatWebModule = bindProtocol('chat-completions', 'Chat Completions', mountChatBlock, chatStateText)
export const anthropicWebModule = bindProtocol('anthropic-messages', 'Anthropic', mountAnthropicBlock, anthropicStateText)
export const geminiWebModule = bindProtocol('gemini-interactions', 'Gemini', mountGeminiBlock, geminiStateText)

const modules = new Map([responsesWebModule, chatWebModule, anthropicWebModule, geminiWebModule]
  .map(module => [module.protocolId, module]))

export function getProtocolWebModule(protocolId: unknown): ProtocolWebModule | undefined {
  return typeof protocolId === 'string' ? modules.get(protocolId) : undefined
}

/** SSE has only an untrusted envelope until the selected module decodes its payload. */
export function decodeProtocolWebView(value: unknown): ProtocolViewSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return getProtocolWebModule((value as Record<string, unknown>).protocolId)?.decode(value)
}

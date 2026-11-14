import type { ToolCall, ToolImageRef } from '@anybox/tool-api'
export const toolImagesServiceKey = 'tools.images'
export interface ToolImagesPort {
  importImage(input: { readonly scopeId: string; readonly bytes: AsyncIterable<Uint8Array> }, signal?: AbortSignal): ToolCall<ToolImageRef>
}
export type { ToolImageRef } from '@anybox/tool-api'
export function isToolImageError(value: unknown): value is Error & { readonly code: string } {
  return value instanceof Error && 'code' in value && typeof value.code === 'string' && value.code.startsWith('asset-')
}

import { createHash } from 'node:crypto'
import type { ProtocolCitation, ProtocolSource, ProtocolSummaryPart, ProtocolViewBlock } from '../view/types.js'
export type ObjectValue = Readonly<Record<string, unknown>>
export const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}
export const array = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : []
export const string = (value: unknown): string => typeof value === 'string' ? value : ''
export const identity = (value: string): string => value.length <= 256 ? value : 'display-' + createHash('sha256').update(value).digest('hex')
export const position = (value: unknown): number => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0
export const token = (value: unknown): string | undefined => typeof value === 'string' ? (/^[a-zA-Z0-9_.:-]{1,128}$/u.test(value) ? value : 'unknown') : undefined
export const optionalToken = (key: string, value: unknown): Record<string, string> => token(value) === undefined ? {} : { [key]: token(value)! }
export const argumentsText = (value: unknown): string => typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value)
export const safeUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length > 8192) return undefined
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined } catch { return undefined }
}
export function citations(value: unknown, text: string): readonly ProtocolCitation[] {
  return array(value).slice(0, 128).flatMap(raw => {
    const item = object(raw), url = safeUrl(item.url ?? item.uri ?? object(item.source).url)
    if (!url) return []
    const start = item.start_index ?? item.startIndex, end = item.end_index ?? item.endIndex
    // Absent positions attach a source at the end; never invent a cited range.
    const from = Number.isSafeInteger(start) && Number(start) >= 0 ? Number(start) : text.length
    const to = Number.isSafeInteger(end) && Number(end) >= from ? Number(end) : from
    if (to > text.length) return []
    return [{ start: from, end: to, url, ...(typeof item.title === 'string' ? { title: item.title.slice(0, 512) } : {}) }]
  })
}
export function sources(value: unknown): readonly ProtocolSource[] {
  return array(value).slice(0, 128).flatMap(raw => {
    const item = object(raw), url = safeUrl(item.url ?? item.uri)
    return url ? [{ url, ...(typeof item.title === 'string' ? { title: item.title.slice(0, 512) } : {}) }] : []
  })
}
export function summary(value: unknown, id: string): readonly ProtocolSummaryPart[] {
  return array(value).flatMap((raw, at) => {
    const part = object(raw)
    return typeof part.text === 'string' ? [{ id: id + ':summary-' + at, text: part.text }] : []
  })
}
export function orderedParts<T extends { readonly id: string }>(parts: readonly T[]): readonly T[] {
  return [...parts].sort((left, right) => Number(left.id.slice(left.id.lastIndexOf('-') + 1)) - Number(right.id.slice(right.id.lastIndexOf('-') + 1)))
}
export function replaceBlock(previous: readonly ProtocolViewBlock[], block: ProtocolViewBlock): readonly ProtocolViewBlock[] {
  const at = previous.findIndex(item => item.id === block.id)
  const result = at < 0 ? [...previous, block] : previous.map((item, index) => index === at ? block : item)
  const order = (id: string): number => {
    const root = /^(?:item|block|step)-(\d+)$/u.exec(id)
    if (root) return Number(root[1])
    const choice = /^choice-(\d+):(reasoning|content-\d+|refusal|tool-\d+)$/u.exec(id)
    if (!choice) return -1
    const suffix = choice[2]!, index = Number(suffix.split('-')[1] ?? 0)
    return Number(choice[1]) * 1_000_000 + (suffix === 'reasoning' ? 0 : suffix.startsWith('content') ? 100_000 + index : suffix === 'refusal' ? 200_000 : 300_000 + index)
  }
  return result.sort((left, right) => order(left.id) - order(right.id))
}
export function unsupported(id: string, text = 'Unsupported native content'): ProtocolViewBlock { return { id, type: 'harness.unsupported', text } }

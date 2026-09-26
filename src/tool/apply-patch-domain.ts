import { patchRejection } from './apply-patch-types.js'
import type { PatchChunk, PatchOperation } from './apply-patch-types.js'

const beginMarker = '*** Begin Patch'
const endMarker = '*** End Patch'
const eofMarker = '*** End of File'

function rejectSyntax(message: string, line: number, path?: string): never {
  throw patchRejection('invalid-patch', message, path, line)
}

function chunkValue(anchor: string | undefined, oldLines: string[], newLines: string[], eof: boolean): PatchChunk {
  return Object.freeze({ ...(anchor === undefined ? {} : { anchor }),
    oldLines: Object.freeze(oldLines), newLines: Object.freeze(newLines), eof })
}

/** Parse only the patch language; path ownership and filesystem checks belong to the tool owner. */
export function parsePatch(patch: string): readonly PatchOperation[] {
  if (typeof patch !== 'string' || patch.includes('\0') ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(patch)) {
    rejectSyntax('Patch must be Unicode text without NUL characters.', 1)
  }
  const normalized = patch.replace(/\r\n/g, '\n')
  if (normalized.includes('\r')) rejectSyntax('Patch contains an unsupported line ending.', 1)
  const lines = normalized.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines[0] !== beginMarker) rejectSyntax('Patch must start with *** Begin Patch.', 1)
  if (lines.at(-1) !== endMarker) rejectSyntax('Patch must end with *** End Patch.', lines.length)
  const operations: PatchOperation[] = []
  let index = 1
  const boundary = () => index >= lines.length - 1 || lines[index].startsWith('*** ')
  while (index < lines.length - 1) {
    const headerLine = index + 1
    const header = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(lines[index])
    if (!header || !header[2].trim()) rejectSyntax('Expected an Add, Delete, or Update File header.', headerLine)
    const [, kind, path] = header
    index++
    if (kind === 'Add') {
      const content: string[] = []
      while (!boundary()) {
        if (!lines[index].startsWith('+')) rejectSyntax('Added file lines must start with +.', index + 1, path)
        content.push(lines[index].slice(1))
        index++
      }
      operations.push(Object.freeze({ kind: 'add', path,
        content: content.length ? `${content.join('\n')}\n` : '' }))
      continue
    }
    if (kind === 'Delete') {
      operations.push(Object.freeze({ kind: 'delete', path }))
      continue
    }
    let moveTo: string | undefined
    if (lines[index]?.startsWith('*** Move to: ')) {
      moveTo = lines[index].slice('*** Move to: '.length)
      if (!moveTo.trim()) rejectSyntax('Move destination must not be empty.', index + 1, path)
      index++
    }
    const chunks: PatchChunk[] = []
    while (!boundary()) {
      let anchor: string | undefined
      const chunkLine = index + 1
      if (lines[index] === '@@') index++
      else if (lines[index].startsWith('@@ ')) {
        if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(lines[index])) {
          rejectSyntax('Unified diff hunk headers are not supported.', index + 1, path)
        }
        anchor = lines[index].slice(3)
        if (!anchor.length) rejectSyntax('An anchor must contain an exact line.', index + 1, path)
        index++
      } else if (chunks.length || ![' ', '+', '-'].includes(lines[index][0])) {
        rejectSyntax('Expected a hunk header or a prefixed patch line.', index + 1, path)
      }
      const oldLines: string[] = [], newLines: string[] = []
      while (!boundary() && !lines[index].startsWith('@@')) {
        const line = lines[index]
        const prefix = line[0]
        if (prefix !== ' ' && prefix !== '+' && prefix !== '-') {
          rejectSyntax('Hunk lines must start with a space, +, or -.', index + 1, path)
        }
        if (prefix !== '+') oldLines.push(line.slice(1))
        if (prefix !== '-') newLines.push(line.slice(1))
        index++
      }
      if (!oldLines.length && !newLines.length) rejectSyntax('A hunk must contain at least one line.', chunkLine, path)
      const eof = lines[index] === eofMarker
      if (eof) index++
      chunks.push(chunkValue(anchor, oldLines, newLines, eof))
      if (eof && !boundary()) rejectSyntax('End of File must terminate the final hunk for this file.', index + 1, path)
    }
    if (!chunks.length && moveTo === undefined) rejectSyntax('An update must contain a hunk or a move destination.', headerLine, path)
    operations.push(Object.freeze({ kind: 'update', path, ...(moveTo === undefined ? {} : { moveTo }),
      chunks: Object.freeze(chunks) }))
  }
  if (!operations.length) rejectSyntax('Patch must contain at least one file operation.', 2)
  return Object.freeze(operations)
}

interface TextLines {
  readonly bom: string
  readonly eol: '\n' | '\r\n'
  readonly trailingNewline: boolean
  readonly lines: readonly string[]
}

function readText(bytes: Buffer): TextLines {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw patchRejection('invalid-utf8', 'File must contain valid UTF-8 text.', undefined, 1)
  }
  if (text.includes('\0')) throw patchRejection('binary-file', 'Files containing NUL characters cannot be patched.', undefined, 1)
  const withoutCrLf = text.replace(/\r\n/g, '')
  if (withoutCrLf.includes('\r')) {
    throw patchRejection('unsupported-line-ending', 'File contains a bare CR line ending.', undefined, 1)
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  if (eol === '\r\n' && withoutCrLf.includes('\n')) {
    throw patchRejection('mixed-line-endings', 'File mixes LF and CRLF line endings.', undefined, 1)
  }
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : ''
  if (bom) text = text.slice(1)
  const trailingNewline = text.endsWith('\n')
  const lines = text ? text.split(eol) : []
  if (trailingNewline) lines.pop()
  return { bom, eol, trailingNewline, lines }
}

/** Reject text that cannot be changed without guessing its encoding or line ending convention. */
export function validatePatchText(bytes: Buffer): void {
  readText(bytes)
}

/** Stop at two matches: that is enough to reject ambiguity without retaining every position. */
function matchingPositions(lines: readonly string[], pattern: readonly string[], from: number, eof: boolean): readonly number[] {
  if (eof) {
    const start = lines.length - pattern.length
    return start >= from && pattern.every((value, offset) => lines[start + offset] === value) ? [start] : []
  }
  const fallback = new Array<number>(pattern.length).fill(0)
  for (let index = 1, prefix = 0; index < pattern.length; index++) {
    while (prefix > 0 && pattern[index] !== pattern[prefix]) prefix = fallback[prefix - 1]
    if (pattern[index] === pattern[prefix]) prefix++
    fallback[index] = prefix
  }
  const matches: number[] = []
  for (let index = from, prefix = 0; index < lines.length; index++) {
    while (prefix > 0 && lines[index] !== pattern[prefix]) prefix = fallback[prefix - 1]
    if (lines[index] === pattern[prefix]) prefix++
    if (prefix === pattern.length) {
      matches.push(index - pattern.length + 1)
      if (matches.length === 2) break
      prefix = fallback[prefix - 1]
    }
  }
  return matches
}

/** Match all hunks against original lines, in order, so earlier edits cannot change later matching. */
export function applyPatchText(bytes: Buffer, chunks: readonly PatchChunk[]): Buffer {
  const original = readText(bytes)
  const lines = original.lines
  const output: string[] = []
  let cursor = 0
  for (const chunk of chunks) {
    let searchFrom = cursor
    if (chunk.anchor !== undefined) {
      const anchors: number[] = []
      for (let line = cursor; line < lines.length; line++) {
        if (lines[line] === chunk.anchor) anchors.push(line)
        if (anchors.length === 2) break
      }
      if (anchors.length !== 1) {
        throw patchRejection(anchors.length ? 'ambiguous-anchor' : 'anchor-not-found',
          anchors.length ? 'Hunk anchor matches more than one remaining line.' : 'Hunk anchor was not found after the previous hunk.',
          undefined, cursor + 1)
      }
      searchFrom = anchors[0] + 1
    }
    let start: number
    if (!chunk.oldLines.length) {
      if (chunk.anchor !== undefined) start = searchFrom
      else if (chunk.eof) start = lines.length
      else if (!lines.length) start = 0
      else throw patchRejection('ambiguous-insertion', 'Insertion requires an empty file, an EOF marker, or a unique anchor.', undefined, cursor + 1)
      if (chunk.eof && start !== lines.length) {
        throw patchRejection('eof-mismatch', 'An EOF insertion must follow the last line.', undefined, start + 1)
      }
    } else {
      const matches = matchingPositions(lines, chunk.oldLines, searchFrom, chunk.eof)
      if (matches.length !== 1) {
        throw patchRejection(matches.length ? 'ambiguous-context' : 'context-not-found',
          matches.length ? 'Hunk context matches more than one remaining position.' : 'Hunk context was not found after the previous hunk.',
          undefined, searchFrom + 1)
      }
      start = matches[0]
    }
    for (let line = cursor; line < start; line++) output.push(lines[line])
    for (const line of chunk.newLines) output.push(line)
    cursor = start + chunk.oldLines.length
  }
  for (let line = cursor; line < lines.length; line++) output.push(lines[line])
  const trailingNewline = output.length > 0 && (original.trailingNewline || !lines.length)
  return Buffer.from(`${original.bom}${output.join(original.eol)}${trailingNewline ? original.eol : ''}`, 'utf8')
}

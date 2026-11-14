// @ts-check
import { validateToolArguments } from '@anybox/tool-api'

/** @typedef {{readonly id: string, readonly title: string, readonly content: string}} Note */
/** @typedef {import('@anybox/tool-api').JsonValue} JsonValue */

/** @type {import('@anybox/tool-api').ToolDescriptor[]} */
const definitions = [
  { toolId: 'notes.search', version: '1', definition: {
    name: 'notes_search', description: 'Search the notes available in this environment by title or content.',
    parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 200 } },
      required: ['query'], additionalProperties: false },
  } },
  { toolId: 'notes.read', version: '1', definition: {
    name: 'notes_read', description: 'Read a complete note using an ID returned by notes_search.',
    parameters: { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 128 } },
      required: ['id'], additionalProperties: false },
  } },
]
const tools = Object.freeze(definitions)

/** @template T @param {T} value @returns {import('@anybox/tool-api').ToolCall<T>} */
const completed = value => ({ result: Promise.resolve(value), done: Promise.resolve(), cancel() {} })

/** @param {'invalid-request' | 'cancelled' | 'outcome-unknown'} category */
const failure = category => Object.assign(new Error(`notes environment ${category}`), { category })

/**
 * A standalone read-only capability provider. Documents are a private immutable
 * snapshot; tool calls never accept filesystem paths or access Agent state.
 * @param {readonly Note[]} documents
 * @returns {import('@anybox/tool-api').ToolEnvironment}
 */
export function createNotesEnvironment(documents) {
  if (!Array.isArray(documents) || documents.length > 100) throw new TypeError('invalid notes')
  /** @type {Map<string, Note>} */
  const notes = new Map()
  for (const document of documents) {
    if (!document || typeof document.id !== 'string' || !/^[a-z0-9-]{1,128}$/.test(document.id) ||
      typeof document.title !== 'string' || !document.title.trim() || document.title.length > 200 ||
      typeof document.content !== 'string' || document.content.length > 65536 || notes.has(document.id)) throw new TypeError('invalid note')
    notes.set(document.id, Object.freeze({ id: document.id, title: document.title, content: document.content }))
  }
  return {
    environmentId: 'notes', version: '1', tools,
    // No recovery flag: recomputing a read is not original-operation lookup.
    openScope(context) {
      let closed = false
      return {
        execute(request) {
          if (closed || context.signal.aborted) throw failure('cancelled')
          if (request.resuming) throw failure('outcome-unknown')
          const descriptor = tools.find(tool => tool.toolId === request.toolId && tool.version === request.version)
          if (!descriptor) throw failure('invalid-request')
          const args = validateToolArguments(descriptor.definition, request.arguments)
          /** @type {JsonValue} */
          let result
          if (request.toolId === 'notes.search') {
            const query = String(args.query).trim().toLocaleLowerCase()
            if (!query) throw failure('invalid-request')
            result = { notes: [...notes.values()].filter(note => `${note.title}\n${note.content}`.toLocaleLowerCase().includes(query))
              .map(note => ({ id: note.id, title: note.title })), totalDocuments: notes.size }
          } else {
            const note = notes.get(String(args.id))
            result = note ? { ...note } : { error: { code: 'note-not-found' } }
          }
          // This snapshot query completes synchronously and owns no I/O handles.
          return completed({ result })
        },
        hasResources: () => false,
        async cancel() { closed = true },
        close() { closed = true; return completed({ closed: true }) },
      }
    },
  }
}

import type { JsonValue } from '@anybox/models'
import { isDeepStrictEqual } from 'node:util'
import type { ToolDefinition } from './definition.js'
import { bashToolDefinition } from './bash-component.js'
import { applyPatchToolDefinition } from './apply-patch-component.js'

export type LibraryToolName =
  | 'codex_exec_command' | 'codex_write_stdin' | 'codex_apply_patch' | 'codex_view_image' | 'codex_update_plan'
  | 'claude_code_Bash' | 'claude_code_Read' | 'claude_code_Write' | 'claude_code_Edit' | 'claude_code_Glob' | 'claude_code_Grep' | 'claude_code_TodoWrite'
  | 'deepseek_harness_bash' | 'deepseek_harness_read' | 'deepseek_harness_read_image' | 'deepseek_harness_write' | 'deepseek_harness_edit' | 'deepseek_harness_glob' | 'deepseek_harness_grep' | 'deepseek_harness_todo_write'

export interface ToolCatalogEntry {
  readonly toolId: string
  readonly version: string
  readonly name: string
  readonly category: 'command' | 'files' | 'search' | 'image' | 'plan'
  readonly source: Readonly<{ harnessId: string; name: string; referenceUrl: string; referenceVersion?: string }>
  readonly definition: ToolDefinition
  readonly dependencies: readonly string[]
  readonly selectable: boolean
  readonly scope: string
  readonly adaptation: string
}
export interface ToolSelectionSnapshot {
  readonly schemaVersion: 1
  readonly tools: readonly Readonly<{ toolId: string; version: string; definition: ToolDefinition }>[]
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
const str = (description?: string): JsonValue => ({ type: 'string', ...(description ? { description } : {}) })
const bool: JsonValue = { type: 'boolean' }
const integer = (minimum = 0, maximum = 2_147_483_647): JsonValue => ({ type: 'integer', minimum, maximum })
const enumeration = (...values: string[]): JsonValue => ({ type: 'string', enum: values })
const object = (properties: Record<string, JsonValue>, required: readonly string[] = []): Record<string, JsonValue> => ({ type: 'object', properties, required: [...required], additionalProperties: false })
const todos = (activeForm: boolean): JsonValue => ({ type: 'array', maxItems: 100, items: object({ content: str(), status: enumeration('pending', 'in_progress', 'completed'), ...(activeForm ? { activeForm: str() } : {}) }, activeForm ? ['content', 'status', 'activeForm'] : ['content', 'status']) })
const sources = freeze({
  codex: { harnessId: 'codex', name: 'Codex', referenceUrl: 'https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide', referenceVersion: 'documentation snapshot 2026-10-04' },
  claude: { harnessId: 'claude-code', name: 'Claude Code', referenceUrl: 'https://platform.claude.com/docs/en/agent-sdk/typescript', referenceVersion: '0.3.289' },
  deepseek: { harnessId: 'deepseek-harness', name: 'DeepSeek Harness', referenceUrl: 'https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/tool-catalog.md', referenceVersion: '5badb15009ae1756c3afe0ae0cef1faafc290ccc' },
  legacy: { harnessId: 'anybox', name: 'Anybox legacy', referenceUrl: 'https://github.com/fanfan-de/AnyboxV2', referenceVersion: 'known-tools-v1' },
})
function entry(toolId: string, name: LibraryToolName, category: ToolCatalogEntry['category'], source: ToolCatalogEntry['source'], description: string, parameters: Record<string, JsonValue>, dependencies: readonly string[] = []): ToolCatalogEntry {
  return freeze({ toolId, version: '1.0.0', name: toolId.slice(toolId.indexOf('.') + 1), category, source, definition: { name, description, parameters }, dependencies, selectable: true,
    scope: category === 'command' ? 'Run-owned Unix pipe execution; no PTY or independent background jobs.' : category === 'image' ? 'Static JPEG, PNG and WebP images only.' : category === 'plan' ? 'Run-owned full replacement plan or todo state.' : 'Project-relative paths are a base, not a filesystem sandbox; UTF-8 text and declared static image reads only.',
    adaptation: 'Source-specific arguments and names are preserved under a fixed model-call prefix; Anybox owns execution, cancellation and bounded results.' + (name === 'codex_apply_patch' ? ' Freeform patch input is represented by the patch JSON field.' : '') })
}
const fileRead = object({ file_path: str(), offset: integer(1), limit: integer(1, 10_000) }, ['file_path'])
const fileWrite = object({ file_path: str(), content: str() }, ['file_path', 'content'])
const fileEdit = object({ file_path: str(), old_string: str(), new_string: str(), replace_all: bool }, ['file_path', 'old_string', 'new_string'])
const fileGlob = object({ pattern: str(), path: str() }, ['pattern'])
const catalog: readonly ToolCatalogEntry[] = freeze([
  entry('codex.exec_command', 'codex_exec_command', 'command', sources.codex, 'Run a command in the project or specified working directory using pipes. Returns a session_id if still running; continue it with codex_write_stdin. PTY and independent background jobs are unsupported.', object({ cmd: str(), workdir: str(), shell: str(), login: bool, tty: { type: 'boolean', enum: [false] }, yield_time_ms: integer(0, 30_000), max_output_tokens: integer(1, 32_768) }, ['cmd']), ['codex.write_stdin']),
  entry('codex.write_stdin', 'codex_write_stdin', 'command', sources.codex, 'Write characters to a process session belonging to this Run, or poll its incremental output. Empty chars observes without writing.', object({ session_id: integer(1, Number.MAX_SAFE_INTEGER), chars: str(), yield_time_ms: integer(0, 30_000), max_output_tokens: integer(1, 32_768) }, ['session_id']), ['codex.exec_command']),
  entry('codex.apply_patch', 'codex_apply_patch', 'files', sources.codex, `${applyPatchToolDefinition.description} Supply the complete patch as patch.`, object({ patch: str() }, ['patch'])),
  entry('codex.view_image', 'codex_view_image', 'image', sources.codex, 'Read a local static JPEG, PNG or WebP image. Its immutable bytes are supplied to models with image input support. PDF and animated images are unsupported.', object({ path: str(), detail: enumeration('high', 'original') }, ['path'])),
  entry('codex.update_plan', 'codex_update_plan', 'plan', sources.codex, 'Replace the current Run plan. At most one step may be in_progress.', object({ explanation: str(), plan: { type: 'array', maxItems: 100, items: object({ step: str(), status: enumeration('pending', 'in_progress', 'completed') }, ['step', 'status']) } }, ['plan'])),
  entry('claude-code.Bash', 'claude_code_Bash', 'command', sources.claude, 'Run a foreground Bash command in the current project. Returns output after the process exits. Background execution is unsupported.', object({ command: str(), timeout: integer(1, 600_000), description: str(), run_in_background: { type: 'boolean', enum: [false] } }, ['command'])),
  entry('claude-code.Read', 'claude_code_Read', 'files', sources.claude, 'Read an ordinary UTF-8 text file using one-based offset and optional line limit, or a static JPEG, PNG or WebP image. Does not follow symbolic links. PDF and notebooks are unsupported.', fileRead),
  entry('claude-code.Write', 'claude_code_Write', 'files', sources.claude, 'Write an ordinary UTF-8 text file, replacing existing content through the shared serialized text writer.', fileWrite),
  entry('claude-code.Edit', 'claude_code_Edit', 'files', sources.claude, 'Replace an exact old_string in an ordinary UTF-8 text file. Match must be unique unless replace_all is true.', fileEdit),
  entry('claude-code.Glob', 'claude_code_Glob', 'search', sources.claude, 'Find files matching a glob beneath path or the project. Does not follow symbolic links.', fileGlob),
  entry('claude-code.Grep', 'claude_code_Grep', 'search', sources.claude, 'Search UTF-8 file content with a regular expression. Default output_mode is files_with_matches; results and context are bounded.', object({ pattern: str(), path: str(), glob: str(), output_mode: enumeration('content', 'files_with_matches', 'count'), '-A': integer(0, 100), '-B': integer(0, 100), '-C': integer(0, 100), context: integer(0, 100), '-n': bool, '-i': bool, '-o': bool, type: str(), head_limit: integer(0, 1_000), offset: integer(0), multiline: bool }, ['pattern'])),
  entry('claude-code.TodoWrite', 'claude_code_TodoWrite', 'plan', sources.claude, 'Replace this Run todo list, preserving content, status and activeForm. At most one item may be in_progress.', object({ todos: todos(true) }, ['todos'])),
  entry('deepseek-harness.bash', 'deepseek_harness_bash', 'command', sources.deepseek, 'Run a foreground Bash command in workdir or the project with a description. Background execution is unsupported.', object({ description: str(), command: str(), timeoutMs: integer(1, 600_000), workdir: str(), run_in_background: { type: 'boolean', enum: [false] } }, ['description', 'command'])),
  entry('deepseek-harness.read', 'deepseek_harness_read', 'files', sources.deepseek, 'Read an ordinary UTF-8 text file with one-based offset and optional line limit. PDF, notebooks and symbolic links are unsupported.', fileRead),
  entry('deepseek-harness.read_image', 'deepseek_harness_read_image', 'image', sources.deepseek, 'Read a local static JPEG, PNG or WebP image for a model with image input support.', object({ file_path: str() }, ['file_path'])),
  entry('deepseek-harness.write', 'deepseek_harness_write', 'files', sources.deepseek, 'Write complete UTF-8 text content to a file through the shared serialized text writer.', fileWrite),
  entry('deepseek-harness.edit', 'deepseek_harness_edit', 'files', sources.deepseek, 'Replace an exact old_string with new_string, requiring a unique match unless replace_all is true.', fileEdit),
  entry('deepseek-harness.glob', 'deepseek_harness_glob', 'search', sources.deepseek, 'Find files matching pattern beneath path or the project without following symbolic links.', fileGlob),
  entry('deepseek-harness.grep', 'deepseek_harness_grep', 'search', sources.deepseek, 'Search UTF-8 file content by regular expression with an optional single positive include glob.', object({ pattern: str(), path: str(), include: str() }, ['pattern'])),
  entry('deepseek-harness.todo_write', 'deepseek_harness_todo_write', 'plan', sources.deepseek, 'Replace this Run todo list with content and status. At most one item may be in_progress.', object({ todos: todos(false) }, ['todos'])),
  { toolId: 'anybox.bash', version: 'known-tools-v1', name: 'bash', category: 'command', source: sources.legacy, definition: bashToolDefinition, dependencies: [], selectable: true, scope: 'Foreground Bash in the selected project.', adaptation: 'Existing known-tools-v1 contract retained exactly.' },
  { toolId: 'anybox.apply_patch', version: 'known-tools-v1', name: 'apply_patch', category: 'files', source: sources.legacy, definition: applyPatchToolDefinition, dependencies: [], selectable: true, scope: 'Ordinary UTF-8 text patches through the shared writer.', adaptation: 'Existing known-tools-v1 contract retained exactly.' },
])
export const defaultToolIds: readonly string[] = freeze(['codex.exec_command', 'codex.write_stdin', 'codex.apply_patch', 'codex.view_image', 'codex.update_plan', 'claude-code.Read', 'claude-code.Write', 'claude-code.Edit', 'claude-code.Glob', 'claude-code.Grep'])
export function listTools(): readonly ToolCatalogEntry[] { return catalog }
export function getToolById(toolId: string): ToolCatalogEntry | undefined { return catalog.find(tool => tool.toolId === toolId) }
export function getToolByName(name: string): ToolCatalogEntry | undefined { return catalog.find(tool => tool.definition.name === name) }
function snapshot(entries: readonly ToolCatalogEntry[]): ToolSelectionSnapshot {
  return freeze({ schemaVersion: 1, tools: entries.map(({ toolId, version, definition }) => ({ toolId, version, definition })) })
}
export const legacyToolSelection: ToolSelectionSnapshot = snapshot(catalog.filter(tool => ['anybox.bash', 'anybox.apply_patch'].includes(tool.toolId)))

/** Resolve the chosen catalog subset without silently changing the selected IDs. */
export function createToolSelection(toolIds: readonly string[] = defaultToolIds): ToolSelectionSnapshot {
  if (!Array.isArray(toolIds) || toolIds.some(id => typeof id !== 'string')) throw new TypeError('invalid tool selection')
  const chosen = new Set<string>()
  for (const id of toolIds) {
    const tool = getToolById(id)
    if (!tool?.selectable) throw new TypeError('unknown or retired tool')
    chosen.add(id)
  }
  if (catalog.some(tool => chosen.has(tool.toolId) && tool.dependencies.some(id => !chosen.has(id)))) throw new TypeError('missing tool dependency')
  return snapshot(catalog.filter(tool => chosen.has(tool.toolId)))
}
export function validateToolSelection(value: unknown): ToolSelectionSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid tool selection')
  const candidate = value as ToolSelectionSnapshot
  if (Object.keys(candidate).some(key => !['schemaVersion', 'tools'].includes(key)) || candidate.schemaVersion !== 1 || !Array.isArray(candidate.tools)) throw new TypeError('invalid tool selection')
  const ids = new Set<string>(), names = new Set<string>()
  const entries = candidate.tools.map(item => {
    if (!item || typeof item !== 'object' || Object.keys(item).some(key => !['toolId', 'version', 'definition'].includes(key))) throw new TypeError('invalid tool selection')
    const tool = getToolById(item.toolId)
    if (!tool || item.version !== tool.version || !isDeepStrictEqual(item.definition, tool.definition) || ids.has(item.toolId) || names.has(item.definition.name)) throw new TypeError('invalid tool selection')
    ids.add(item.toolId); names.add(item.definition.name)
    return tool
  })
  if (entries.some(tool => tool.dependencies.some(id => !ids.has(id)))) throw new TypeError('invalid tool selection dependencies')
  return snapshot(entries)
}

function validateSchema(value: unknown, schema: Record<string, JsonValue>): void {
  if (schema.enum && (!Array.isArray(schema.enum) || !schema.enum.includes(value as JsonValue))) throw new TypeError('invalid tool arguments')
  if (schema.type === 'string') { if (typeof value !== 'string' || value.includes('\0')) throw new TypeError('invalid tool arguments'); return }
  if (schema.type === 'boolean') { if (typeof value !== 'boolean') throw new TypeError('invalid tool arguments'); return }
  if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < Number(schema.minimum) || value > Number(schema.maximum)) throw new TypeError('invalid tool arguments')
    return
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value) || schema.maxItems !== undefined && value.length > Number(schema.maxItems)) throw new TypeError('invalid tool arguments')
    for (const item of value) validateSchema(item, schema.items as Record<string, JsonValue>)
    return
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid tool arguments')
    const properties = schema.properties as Record<string, Record<string, JsonValue>>, candidate = value as Record<string, unknown>
    if ((schema.required as string[]).some(key => !Object.hasOwn(candidate, key)) || Object.keys(candidate).some(key => !Object.hasOwn(properties, key))) throw new TypeError('invalid tool arguments')
    for (const [key, child] of Object.entries(candidate)) validateSchema(child, properties[key])
    return
  }
  throw new TypeError('invalid tool schema')
}
export function validateLibraryArguments(name: unknown, value: unknown): Readonly<Record<string, JsonValue>> {
  if (typeof name !== 'string') throw new TypeError('unknown library tool')
  const tool = getToolByName(name)
  if (!tool?.selectable || name === 'bash' || name === 'apply_patch') throw new TypeError('unknown library tool')
  validateSchema(value, tool.definition.parameters as Record<string, JsonValue>)
  const args = value as Record<string, JsonValue>
  for (const key of ['cmd', 'command', 'file_path', 'path', 'pattern', 'workdir', 'shell']) if (typeof args[key] === 'string' && !args[key].trim()) throw new TypeError('invalid tool arguments')
  if (typeof args.old_string === 'string' && !args.old_string.length) throw new TypeError('invalid edit match')
  if (name === 'deepseek_harness_grep' && typeof args.include === 'string' && (!args.include.length || args.include.startsWith('!') || args.include.includes(','))) throw new TypeError('invalid include glob')
  const plan = args.plan ?? args.todos
  if (Array.isArray(plan) && (plan.filter(item => item && typeof item === 'object' && !Array.isArray(item) && item.status === 'in_progress').length > 1 || plan.some(item => item && typeof item === 'object' && !Array.isArray(item) && ['content', 'step', 'activeForm'].some(key => typeof item[key] === 'string' && !String(item[key]).trim())))) throw new TypeError('invalid tool plan')
  return freeze(structuredClone(args))
}

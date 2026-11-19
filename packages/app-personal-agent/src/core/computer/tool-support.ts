import { createHash } from 'node:crypto'
import { listTools } from '@anybox/computer-tools/contracts'

export type ComputerToolExecutor = 'bash' | 'processes' | 'files' | 'apply-patch'

/** Shared by worker dispatch and its read-only implementation report. */
const executors: Readonly<Record<string, ComputerToolExecutor>> = Object.freeze({
  bash: 'bash',
  apply_patch: 'apply-patch',
  codex_exec_command: 'processes',
  codex_write_stdin: 'processes',
  codex_apply_patch: 'apply-patch',
  codex_view_image: 'files',
  claude_code_Bash: 'processes',
  claude_code_Read: 'files',
  claude_code_Write: 'files',
  claude_code_Edit: 'files',
  claude_code_Glob: 'files',
  claude_code_Grep: 'files',
  deepseek_harness_bash: 'processes',
  deepseek_harness_read: 'files',
  deepseek_harness_read_image: 'files',
  deepseek_harness_write: 'files',
  deepseek_harness_edit: 'files',
  deepseek_harness_glob: 'files',
  deepseek_harness_grep: 'files',
})

export function computerToolExecutor(name: string): ComputerToolExecutor | undefined {
  return Object.hasOwn(executors, name) ? executors[name] : undefined
}

export interface ComputerToolContract {
  readonly toolId: string
  readonly version: string
  readonly definitionHash: string
  readonly executor: ComputerToolExecutor
}

const constraints = Object.freeze({
  terminal: 'pipes' as const,
  independentBackgroundJobs: false as const,
  filesystemSandbox: false as const,
  textEncoding: 'utf-8' as const,
  imageMediaTypes: Object.freeze(['image/jpeg', 'image/png', 'image/webp'] as const),
})

/** Reports contract implementation, not permissions, installed dependencies or readiness. */
export interface ComputerToolManifest {
  readonly schemaVersion: 1
  readonly revision: string
  readonly tools: readonly ComputerToolContract[]
  readonly constraints: typeof constraints
}

export const computerToolManifestLimits = Object.freeze({ maxTools: 256, maxBytes: 16_384 })

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const contracts = new Map(listTools().flatMap(tool => {
  const executor = computerToolExecutor(tool.definition.name)
  return executor ? [[tool.toolId, Object.freeze({ toolId: tool.toolId, version: tool.version,
    definitionHash: hash(tool.definition), executor })] as const] : []
}))

/** A tool set has a stable revision regardless of caller or object key order. */
export function createComputerToolManifest(toolIds: readonly string[] = [...contracts.keys()]): ComputerToolManifest {
  if (!Array.isArray(toolIds) || toolIds.length > computerToolManifestLimits.maxTools || new Set(toolIds).size !== toolIds.length) {
    throw new TypeError('invalid Computer tool set')
  }
  const tools = Object.freeze(toolIds.map(toolId => {
    const tool = contracts.get(toolId)
    if (!tool) throw new TypeError('unsupported Computer tool')
    return tool
  }).sort((left, right) => left.toolId < right.toolId ? -1 : left.toolId > right.toolId ? 1 : 0))
  const content = { schemaVersion: 1 as const, tools, constraints }
  return Object.freeze({ schemaVersion: 1, revision: hash(content), tools, constraints })
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : undefined
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

/** Accept only known immutable contracts; foreign schemas and implementation code never cross this boundary. */
export function parseComputerToolManifest(value: unknown): ComputerToolManifest | undefined {
  try {
    const input = record(value)
    if (!input || !exactKeys(input, ['schemaVersion', 'revision', 'tools', 'constraints']) || input.schemaVersion !== 1 ||
      typeof input.revision !== 'string' || !/^[0-9a-f]{64}$/.test(input.revision) || !Array.isArray(input.tools) ||
      input.tools.length > computerToolManifestLimits.maxTools) return undefined
    const reportedConstraints = record(input.constraints)
    const imageMediaTypes = reportedConstraints?.imageMediaTypes
    if (!reportedConstraints || !exactKeys(reportedConstraints, Object.keys(constraints)) ||
      reportedConstraints.terminal !== constraints.terminal || reportedConstraints.independentBackgroundJobs !== false ||
      reportedConstraints.filesystemSandbox !== false || reportedConstraints.textEncoding !== constraints.textEncoding ||
      !Array.isArray(imageMediaTypes) || imageMediaTypes.length !== constraints.imageMediaTypes.length ||
      !constraints.imageMediaTypes.every((mediaType, index) => imageMediaTypes[index] === mediaType)) return undefined
    const ids: string[] = []
    for (const candidate of input.tools) {
      const tool = record(candidate)
      if (!tool || !exactKeys(tool, ['toolId', 'version', 'definitionHash', 'executor']) || typeof tool.toolId !== 'string') return undefined
      const trusted = contracts.get(tool.toolId)
      if (!trusted || tool.version !== trusted.version || tool.definitionHash !== trusted.definitionHash || tool.executor !== trusted.executor) return undefined
      ids.push(tool.toolId)
    }
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > computerToolManifestLimits.maxBytes) return undefined
    const manifest = createComputerToolManifest(ids)
    return input.revision === manifest.revision ? manifest : undefined
  } catch { return undefined }
}

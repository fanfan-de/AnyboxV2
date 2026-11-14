/** JSON values crossing a tool boundary; independent of any model or runtime. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }

export interface ToolDefinition {
  readonly name: string
  readonly description?: string
  readonly parameters: Readonly<Record<string, JsonValue>>
}

/** Stable capability identity and the exact declaration offered to a caller. */
export interface ToolDescriptor {
  readonly toolId: string
  readonly version: string
  readonly definition: ToolDefinition
}

/** A result can precede actual resource exit. Cancellation only requests exit. */
export interface ToolCall<Result> {
  readonly result: Promise<Result>
  cancel(reason: string): void
  readonly done: Promise<void>
}

export type OwnedCall<Result> = ToolCall<Result>

export interface ToolRequest {
  readonly id: string
  readonly name: string
  readonly arguments: Readonly<Record<string, JsonValue>>
}

/** Immutable image metadata; byte storage and retention belong to the caller. */
export interface ToolImageRef {
  readonly assetId: string
  readonly sha256: string
  readonly mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
  readonly byteLength: number
  readonly width: number
  readonly height: number
  readonly expiresAt?: string
}

/** Accepted JSON Schema keywords. Unknown keywords are rejected before registration. */
const schemaKeywords = new Set(['$schema', 'title', 'description', 'default', 'examples', 'deprecated', 'type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minProperties', 'maxProperties', 'allOf', 'anyOf', 'oneOf', 'not'])
type JsonSchema = boolean | Readonly<Record<string, JsonValue>>
const valueTypes = new Set(['null', 'boolean', 'number', 'integer', 'string', 'array', 'object'])
function validateJson(value: unknown, rejectNul = false, depth = 0, ancestors = new Set<object>()): asserts value is JsonValue {
  if (depth > 64) throw new TypeError('tool JSON nesting exceeds 64 levels')
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value === 'string' && (!rejectNul || !value.includes('\0'))) return
  if (!value || typeof value !== 'object' || ancestors.has(value)) throw new TypeError('invalid tool JSON')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) throw new TypeError('invalid tool JSON array')
      for (const item of value) validateJson(item, rejectNul, depth + 1, ancestors)
      return
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null || Object.getOwnPropertySymbols(value).length) throw new TypeError('invalid tool JSON object')
    for (const [key, child] of Object.entries(value)) {
      if (rejectNul && key.includes('\0')) throw new TypeError('invalid tool JSON')
      validateJson(child, rejectNul, depth + 1, ancestors)
    }
  } finally { ancestors.delete(value) }
}
function object(value: unknown): value is Record<string, JsonValue> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function equal(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((value, index) => equal(value, b[index]))
  if (!object(a) || !object(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal(a[key], b[key]))
}
function assertSchema(value: unknown, depth = 0): asserts value is JsonSchema {
  if (depth > 64) throw new TypeError('tool schema nesting exceeds 64 levels')
  if (typeof value === 'boolean') return
  if (!object(value)) throw new TypeError('invalid tool schema')
  for (const key of Object.keys(value)) if (!schemaKeywords.has(key)) throw new TypeError(`unsupported tool schema keyword: ${key}`)
  if (value.type !== undefined) {
    const types = Array.isArray(value.type) ? value.type : [value.type]
    if (!types.length || types.some(type => typeof type !== 'string' || !valueTypes.has(type)) || new Set(types).size !== types.length) throw new TypeError('invalid tool schema type')
  }
  for (const key of ['title', 'description', '$schema', 'pattern']) if (value[key] !== undefined && typeof value[key] !== 'string') throw new TypeError('invalid tool schema annotation')
  if (typeof value.pattern === 'string') { try { new RegExp(value.pattern, 'u') } catch { throw new TypeError('invalid tool schema pattern') } }
  for (const key of ['deprecated', 'uniqueItems']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new TypeError('invalid tool schema flag')
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']) if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || Number(value[key]) < 0)) throw new TypeError('invalid tool schema limit')
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) if (value[key] !== undefined && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || key === 'multipleOf' && Number(value[key]) <= 0)) throw new TypeError('invalid tool schema numeric constraint')
  if (value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.length)) throw new TypeError('invalid tool schema enum')
  if (value.examples !== undefined && !Array.isArray(value.examples)) throw new TypeError('invalid tool schema examples')
  if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some(key => typeof key !== 'string') || new Set(value.required).size !== value.required.length)) throw new TypeError('invalid tool schema required')
  if (value.properties !== undefined) {
    if (!object(value.properties)) throw new TypeError('invalid tool schema properties')
    for (const schema of Object.values(value.properties)) assertSchema(schema, depth + 1)
  }
  for (const key of ['items', 'additionalProperties', 'not']) if (value[key] !== undefined) assertSchema(value[key], depth + 1)
  for (const key of ['anyOf', 'allOf', 'oneOf']) if (value[key] !== undefined) {
    if (!Array.isArray(value[key]) || !value[key].length) throw new TypeError('invalid tool schema composition')
    for (const schema of value[key]) assertSchema(schema, depth + 1)
  }
}
function matchesType(value: JsonValue, type: JsonValue): boolean {
  if (type === 'null') return value === null
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return object(value)
  if (type === 'integer') return typeof value === 'number' && Number.isSafeInteger(value)
  return typeof value === type
}
function matchesSchema(value: JsonValue, schema: JsonSchema): boolean {
  if (typeof schema === 'boolean') return schema
  if (schema.type !== undefined && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(type => matchesType(value, type))) return false
  if (Array.isArray(schema.enum) && !schema.enum.some(item => equal(item, value))) return false
  if (Object.hasOwn(schema, 'const') && !equal(value, schema.const)) return false
  for (const [key, predicate] of [
    ['allOf', (values: boolean[]) => values.every(Boolean)],
    ['anyOf', (values: boolean[]) => values.some(Boolean)],
    ['oneOf', (values: boolean[]) => values.filter(Boolean).length === 1],
  ] as const) if (Array.isArray(schema[key]) && !predicate(schema[key].map(child => matchesSchema(value, child as JsonSchema)))) return false
  if (schema.not !== undefined && matchesSchema(value, schema.not as JsonSchema)) return false
  if (typeof value === 'string') {
    const length = [...value].length
    if (typeof schema.minLength === 'number' && length < schema.minLength || typeof schema.maxLength === 'number' && length > schema.maxLength || typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) return false
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum || typeof schema.maximum === 'number' && value > schema.maximum || typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum || typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) return false
    if (typeof schema.multipleOf === 'number') { const quotient = value / schema.multipleOf; if (Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * Math.max(1, Math.abs(quotient)) * 4) return false }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems || typeof schema.maxItems === 'number' && value.length > schema.maxItems || schema.uniqueItems === true && value.some((item, index) => value.slice(0, index).some(other => equal(item, other)))) return false
    if (schema.items !== undefined && !value.every(item => matchesSchema(item, schema.items as JsonSchema))) return false
  }
  if (object(value)) {
    const keys = Object.keys(value), properties = object(schema.properties) ? schema.properties : {}
    if (typeof schema.minProperties === 'number' && keys.length < schema.minProperties || typeof schema.maxProperties === 'number' && keys.length > schema.maxProperties || Array.isArray(schema.required) && schema.required.some(key => !Object.hasOwn(value, String(key)))) return false
    for (const key of keys) {
      if (Object.hasOwn(properties, key)) { if (!matchesSchema(value[key], properties[key] as JsonSchema)) return false }
      else if (schema.additionalProperties !== undefined && !matchesSchema(value[key], schema.additionalProperties as JsonSchema)) return false
    }
  }
  return true
}
export function validateToolDefinition(value: unknown): ToolDefinition {
  if (!object(value) || typeof value.name !== 'string' || !value.name.trim() || value.name.includes('\0') || value.description !== undefined && typeof value.description !== 'string' || !object(value.parameters)) throw new TypeError('invalid tool definition')
  validateJson(value.parameters)
  assertSchema(value.parameters)
  return value as unknown as ToolDefinition
}
export function validateToolArguments(definition: ToolDefinition, value: unknown): Readonly<Record<string, JsonValue>> {
  validateToolDefinition(definition)
  validateJson(value, true)
  if (!object(value) || !matchesSchema(value, definition.parameters)) throw new TypeError('invalid tool arguments')
  return value
}
export function validateToolDescriptor(value: unknown): ToolDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid tool descriptor')
  const candidate = value as ToolDescriptor
  if (typeof candidate.toolId !== 'string' || !candidate.toolId.trim() || candidate.toolId.includes('\0') || typeof candidate.version !== 'string' || !candidate.version.trim() || candidate.version.includes('\0')) throw new TypeError('invalid tool descriptor')
  validateToolDefinition(candidate.definition)
  return candidate
}
export function validateToolDescriptors(values: unknown): readonly ToolDescriptor[] {
  if (!Array.isArray(values)) throw new TypeError('invalid tool descriptors')
  const ids = new Set<string>(), names = new Set<string>()
  return values.map(value => {
    const descriptor = validateToolDescriptor(value)
    if (ids.has(descriptor.toolId) || names.has(descriptor.definition.name)) throw new TypeError('duplicate tool descriptor')
    ids.add(descriptor.toolId); names.add(descriptor.definition.name)
    return descriptor
  })
}
export type * from './environment.js'

import type { AssistantPart, ContentPart, JsonValue, ToolDefinition, ToolSchema } from '@anybox/agent-contracts'
import { fault } from '../shared/errors.js'
import { revision, string } from '../shared/utils.js'

export function json(value: unknown, depth = 0, seen = new Set<object>()): asserts value is JsonValue {
  if (depth > 32) throw fault('INVALID_ARGUMENT', 'JSON nesting exceeds limit')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object' || seen.has(value)) throw fault('INVALID_ARGUMENT', 'value must be finite acyclic JSON')
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw fault('INVALID_ARGUMENT', 'value must contain plain JSON objects')
  }
  seen.add(value)
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) json(value[i], depth + 1, seen)
  } else {
    for (const child of Object.values(value)) json(child, depth + 1, seen)
  }
  seen.delete(value)
}
export function contentBytes(parts: readonly ContentPart[]): number {
  return parts.reduce((sum, part) => sum + Buffer.byteLength(part.type === 'text' ? part.text : JSON.stringify(part)), 0)
}
export function assistantParts(value: unknown): readonly AssistantPart[] {
  if (!Array.isArray(value) || !value.length) throw fault('MODEL_FAILED', 'model content must be non-empty')
  return value.map(part => {
    if (part?.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text }
    if (part?.type === 'tool-call') {
      string(part.toolCallId, 'toolCallId'); string(part.toolId, 'toolId'); json(part.input)
      return { type: 'tool-call', toolCallId: part.toolCallId, toolId: part.toolId, input: structuredClone(part.input) }
    }
    throw fault('MODEL_FAILED', 'unsupported model content')
  })
}

export function validateSchema(value: ToolSchema, depth = 0): void {
  if (!value || typeof value !== 'object' || depth > 16) throw fault('INVALID_ARGUMENT', 'invalid tool schema')
  const allowed: Record<string, string[]> = {
    string: ['type', 'enum'], number: ['type'], integer: ['type'], boolean: ['type'], null: ['type'],
    array: ['type', 'items'], object: ['type', 'properties', 'required', 'additionalProperties'],
  }
  if (!Object.hasOwn(allowed, value.type) || Object.keys(value).some(key => !allowed[value.type].includes(key))) {
    throw fault('INVALID_ARGUMENT', 'unsupported tool schema keyword')
  }
  if (value.type === 'string' && value.enum !== undefined && (!Array.isArray(value.enum) || !value.enum.length || value.enum.some(x => typeof x !== 'string'))) {
    throw fault('INVALID_ARGUMENT', 'invalid string enum')
  }
  if (value.type === 'array') validateSchema(value.items, depth + 1)
  if (value.type === 'object') {
    if (!value.properties || Array.isArray(value.properties) || typeof value.properties !== 'object'
      || (value.additionalProperties !== undefined && value.additionalProperties !== false)) throw fault('INVALID_ARGUMENT', 'invalid object schema')
    for (const child of Object.values(value.properties)) validateSchema(child, depth + 1)
    if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some(key => typeof key !== 'string' || !Object.hasOwn(value.properties, key)))) {
      throw fault('INVALID_ARGUMENT', 'invalid required property')
    }
  }
}
export function matches(schema: ToolSchema, value: JsonValue): boolean {
  switch (schema.type) {
    case 'null': return value === null
    case 'boolean': return typeof value === 'boolean'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value)
    case 'string': return typeof value === 'string' && (!schema.enum || schema.enum.includes(value))
    case 'array': return Array.isArray(value) && value.every(item => matches(schema.items, item))
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false
      const object = value as Record<string, JsonValue>
      return (schema.required ?? []).every(key => Object.hasOwn(object, key))
        && Object.entries(object).every(([key, item]) => Object.hasOwn(schema.properties, key) && matches(schema.properties[key], item))
    }
  }
}
export function toolDefinitions(value: readonly ToolDefinition[]): readonly ToolDefinition[] {
  if (!Array.isArray(value) || value.length > 128) throw fault('INVALID_ARGUMENT', 'tool catalog exceeds limit')
  const ids = new Set<string>()
  return value.map(tool => {
    string(tool?.id, 'tool.id'); revision(tool.revision)
    if (ids.has(tool.id)) throw fault('INVALID_ARGUMENT', 'duplicate tool definition')
    ids.add(tool.id)
    if (typeof tool.description !== 'string') throw fault('INVALID_ARGUMENT', 'tool description must be text')
    json(tool.inputSchema); validateSchema(tool.inputSchema)
    if (Buffer.byteLength(JSON.stringify(tool)) > 32 * 1024) throw fault('LIMIT_EXCEEDED', 'tool definition exceeds size limit')
    return { id: tool.id, revision: tool.revision, description: tool.description, inputSchema: structuredClone(tool.inputSchema) }
  })
}

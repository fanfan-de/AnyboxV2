import type { JsonValue, Revision } from './identity.js'
import type { KernelError } from './errors.js'

/** Deliberately bounded schema vocabulary; not the full JSON Schema standard. */
export type ToolSchema =
  | { readonly type: 'string'; readonly enum?: readonly string[] }
  | { readonly type: 'number' | 'integer' | 'boolean' | 'null' }
  | { readonly type: 'array'; readonly items: ToolSchema }
  | { readonly type: 'object'; readonly properties: Readonly<Record<string, ToolSchema>>;
      readonly required?: readonly string[]; readonly additionalProperties?: false }
export interface ToolRef { readonly id: string; readonly revision: Revision }
export interface ToolDefinition extends ToolRef {
  readonly description: string
  readonly inputSchema: ToolSchema
}
export type ToolOutcome =
  | { readonly status: 'succeeded'; readonly output: JsonValue }
  | { readonly status: 'failed' | 'uncertain'; readonly error: KernelError }
  | { readonly status: 'cancelled' }

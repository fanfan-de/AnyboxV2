import type { JsonValue } from '@anybox/models'
/** Host tool contract; concrete protocol bindings encode their own native declarations. */
export interface ToolDefinition {
  readonly name: string
  readonly description?: string
  readonly parameters: Readonly<Record<string, JsonValue>>
}

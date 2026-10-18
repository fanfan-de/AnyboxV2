import { parseClaudeAgentConfig } from './config.js'
import type { ClaudeAgentConfig } from './config.js'

export interface ClaudeAgentServerConfig extends ClaudeAgentConfig {
  readonly port: number
  readonly host: string
  readonly name: string
  /** Existing shared business file; standalone and Anybox-managed processes cannot own it simultaneously. */
  readonly databasePath: string
}
type Environment = Readonly<Record<string, string | undefined>>
function value(env: Environment, name: string): string | undefined {
  const input = env[name]
  if (input === undefined) return undefined
  if (!input.trim() || input.includes('\0')) throw new TypeError(`${name} must not be empty or contain NUL`)
  return input.trim()
}
/** Application-owned listener configuration; existing business data and Claude environment keep their original locations. */
export function parseClaudeAgentServerConfig(env: Environment): ClaudeAgentServerConfig {
  const portName = env.ANYBOX_CLAUDE_AGENT_PORT !== undefined ? 'ANYBOX_CLAUDE_AGENT_PORT' : env.ANYBOX_HARNESS_PORT !== undefined ? 'ANYBOX_HARNESS_PORT' : 'ANYBOX_WEB_PORT'
  const raw = value(env, portName), port = raw === undefined ? 0 : Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError(`${portName} must be a TCP port`)
  return Object.freeze({ ...parseClaudeAgentConfig(env), port,
    host: value(env, 'ANYBOX_CLAUDE_AGENT_BIND') ?? value(env, 'ANYBOX_HARNESS_BIND') ?? '127.0.0.1',
    name: value(env, 'ANYBOX_CLAUDE_AGENT_NAME') ?? 'Claude Agent',
    databasePath: value(env, 'ANYBOX_HARNESS_DATABASE') ?? './data/harness.sqlite',
  })
}

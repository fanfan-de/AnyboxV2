export interface ClaudeAgentConfig {
  /** Explicit `claude` executable path; PATH resolution is skipped when present. */
  readonly executableOverride?: string
}
type Environment = Readonly<Record<string, string | undefined>>
/** Validated before any resource is installed. Only the executable location is configurable; authentication and settings stay in the Claude environment. */
export function parseClaudeAgentConfig(env: Environment): ClaudeAgentConfig {
  const value = env.ANYBOX_CLAUDE_AGENT_BINARY
  if (value === undefined) return Object.freeze({})
  if (!value.trim() || value.includes('\0')) throw new TypeError('ANYBOX_CLAUDE_AGENT_BINARY must not be empty or contain NUL')
  return Object.freeze({ executableOverride: value.trim() })
}

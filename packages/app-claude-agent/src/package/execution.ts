import { claudeAgentServerApplication } from '../registration.js'
import type { ClaudeAgentConfig } from '../config.js'

/** Preparation does not inspect Claude settings or locate its executable. */
export function createRegistration(_context?: unknown, config: ClaudeAgentConfig = {}) {
  return claudeAgentServerApplication(config)
}

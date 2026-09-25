/** The minimal service contract Run and AgentLoop depend on. Exactly one LLM API component provides it on the root. */
import type { OwnedCall } from '../contracts.js'

export const llmServiceKey = 'llm'

export interface LLMMessage {
  readonly role: 'system' | 'developer' | 'user' | 'assistant'
  readonly content: string
}

/** Run-visible metadata for one accepted profile choice. It carries no parameters or credentials. */
export interface LLMSnapshot {
  readonly profileId: string
  readonly configVersion: string
}

/** An in-memory call plan. The providing component privately binds it to its own profile. */
export interface LLMPlan {
  readonly snapshot: LLMSnapshot
}

export interface LLMPort {
  /** Fixes the profile for a Run at admission. Throws LLMFailure when the profile is unknown. */
  prepare(profileId: string): LLMPlan
  /** Starts one text completion. A synchronous throw means no resource was acquired. */
  call(input: { readonly plan: LLMPlan; readonly messages: readonly LLMMessage[] }): OwnedCall<string>
}

export type LLMFailureCategory =
  | 'model-unavailable' | 'dependency-unavailable' | 'unsupported-request' | 'timeout'
  | 'provider-failure' | 'invalid-response' | 'cleanup-failure'
  | 'credential-missing' | 'credential-unavailable'

/** Failures carry a fixed category and message; provider details never cross into Run state. */
export class LLMFailure extends Error {
  constructor(readonly category: LLMFailureCategory) {
    super({
      'model-unavailable': 'model is unavailable',
      'dependency-unavailable': 'model dependency is unavailable',
      'unsupported-request': 'request is not supported by the model API',
      timeout: 'model call timed out',
      'provider-failure': 'model provider failed',
      'invalid-response': 'model response is invalid',
      'cleanup-failure': 'model call cleanup failed',
      'credential-missing': 'model API key is not configured',
      'credential-unavailable': 'model API key could not be read',
    }[category])
    this.name = 'LLMFailure'
  }
}

export function normalizeLLMFailure(error: unknown, fallback: LLMFailureCategory = 'provider-failure'): LLMFailure {
  return error instanceof LLMFailure ? error : new LLMFailure(fallback)
}

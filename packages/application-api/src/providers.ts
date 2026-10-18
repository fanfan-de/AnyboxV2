import type { Component } from '@nya/core'

export interface ApplicationCapabilityProviderContext {
  /** Cancels accepted initialization or final release; provider setup must join actual exit. */
  readonly signal: AbortSignal
}

/** A trusted, lazily activated platform provider; application business stays in its application. */
export interface ApplicationCapabilityProvider {
  readonly id: string
  readonly version: string
  readonly services: readonly string[]
  readonly supported?: boolean
  create(context: ApplicationCapabilityProviderContext): Component<any, any>
  /** Already owned by the host itself; application release must not dispose it. */
  readonly resident?: boolean
}

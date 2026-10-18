import type { Component, Context } from '@nya/core'
import { createApplicationRuntime } from '@anybox/application-api/nya'
import type { ApplicationInstallation } from '@anybox/application-api/nya'
import type { ClaudeAgentConfig } from './config.js'
import { createClaudeAgentStoreComponent } from './core/store/component.js'
import { createClaudeAgentSdkComponent } from './core/sdk/adapter.js'
import type { ClaudeAgentSdkOptions } from './core/sdk/adapter.js'
import { claudeAgentRunAdmissionServiceKey, createClaudeAgentRunsComponent } from './core/runs/component.js'
import type { ClaudeAgentRunAdmissionPort, ClaudeAgentRunsOptions } from './core/runs/component.js'
import { createClaudeAgentHttpComponent } from './http/component.js'

export interface ClaudeAgentServerOptions {
  readonly sdk?: Partial<ClaudeAgentSdkOptions>
  readonly runs?: ClaudeAgentRunsOptions
  /** Replacement adapter providing `claude-agent.sdk`, also useful to embed another SDK transport. */
  readonly sdkComponent?: Component.Object<void>
}

/** Installs the same business services in an existing application root, without host management services. */
export function installClaudeAgentBusiness(root: Context, installation: ApplicationInstallation, config: ClaudeAgentConfig, options: ClaudeAgentServerOptions = {}): void {
  if (root.root !== root) throw new TypeError('application root Context required')
  for (const component of [createClaudeAgentStoreComponent(), options.sdkComponent ?? createClaudeAgentSdkComponent({ executableOverride: config.executableOverride, ...options.sdk }),
    createClaudeAgentRunsComponent(options.runs), createClaudeAgentHttpComponent(root)]) installation.install(component)
}

/** Owns the business installation; its caller supplies the existing SQLite provider and owns the root. */
export function createClaudeAgentRuntime(root: Context, config: ClaudeAgentConfig, options: ClaudeAgentServerOptions = {}) {
  return createApplicationRuntime(root, installation => installClaudeAgentBusiness(root, installation, config, options),
    () => root.get<ClaudeAgentRunAdmissionPort>(claudeAgentRunAdmissionServiceKey)?.closeAdmission())
}

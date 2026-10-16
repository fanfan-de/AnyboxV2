import type { Component, Context } from '@nya/core'
import { failure } from '../../../host/http-utils.js'
import { claudeAgentHttpServiceKey } from '../definition.js'
import { claudeAgentRunChangedEvent, claudeAgentRunEventEvent, claudeAgentRunsServiceKey } from '../core/runs/component.js'
import type { ClaudeAgentRunsPort } from '../core/runs/component.js'
import { claudeAgentSdkServiceKey } from '../core/sdk/port.js'
import type { ClaudeAgentSdkPort } from '../core/sdk/port.js'
import { createClaudeAgentHttpHandler } from './handler.js'
import type { ClaudeAgentHttpHandler } from './handler.js'

/**
 * Owns Claude Agent HTTP operations and SSE subscriptions; Anybox owns the listener. Each request captures the current
 * runs and adapter services from the root before its first asynchronous step, so restarts never receive old requests.
 */
export function createClaudeAgentHttpComponent(root: Context): Component.Object<void> {
  if (root.root !== root) throw new TypeError('application root Context required')
  return { name: 'claude-agent-http', apply(ctx) {
    let handler: ClaudeAgentHttpHandler | undefined
    ctx.effect(() => async () => { await handler?.close() }, 'stop and join Claude Agent HTTP requests')
    handler = createClaudeAgentHttpHandler(() => {
      const runs = root.get<ClaudeAgentRunsPort>(claudeAgentRunsServiceKey), sdk = root.get<ClaudeAgentSdkPort>(claudeAgentSdkServiceKey)
      if (!runs || !sdk) throw failure(503, 'service-unavailable')
      return { runs, sdk }
    })
    ctx.on(claudeAgentRunChangedEvent, change => handler?.notifyChange(change))
    ctx.on(claudeAgentRunEventEvent, frame => handler?.notifyEvent(frame))
    ctx.provide(claudeAgentHttpServiceKey, handler)
  } }
}

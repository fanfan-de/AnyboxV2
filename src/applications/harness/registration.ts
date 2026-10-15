import type { ApplicationRegistration } from '../../host/applications/registration.js'
import { createHarnessServerRuntime } from './server-runtime.js'
import type { HarnessServerRuntimeOptions } from './server-runtime.js'
import type { HarnessServerConfig } from './server-config.js'
import { harnessServerHttpServiceKey } from './http/harness-http.js'
import { harnessDefinition } from './definition.js'
export { harnessDefinition } from './definition.js'
export const harnessServerHttp = Object.freeze({ service: harnessServerHttpServiceKey,
  capabilities: Object.freeze(['projects.path', 'images', 'project-files', 'sse', 'units']),
  legacyRoutes: ['models', 'prompts', 'tools', 'agents', 'projects', 'sessions', 'runs', 'changes'].map(path => ({ prefix: `/api/v1/${path}`, stripPrefix: '/api/v1' })),
  /** Remote units authenticate with their own credential; device tokens are never accepted here. */
  selfAuthenticated: Object.freeze(['/units/unit']) })
export function harnessServerApplication(config: HarnessServerConfig, options: HarnessServerRuntimeOptions = {}): ApplicationRegistration {
  return { definition: harnessDefinition, createRuntime: root => createHarnessServerRuntime(root, config, options), http: harnessServerHttp }
}

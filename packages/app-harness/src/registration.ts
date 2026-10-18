import { productActivityServiceKey } from '@anybox/application-api/contracts'
import type { ProductActivityPort } from '@anybox/application-api/contracts'
import { hostAccessServiceKey } from '@anybox/application-api/node'
import type { HostAccessPort } from '@anybox/application-api/node'
import type { ApplicationRegistration } from '@anybox/application-api/nya'
import { createHarnessServerRuntime } from './server-runtime.js'
import type { HarnessServerRuntimeOptions } from './server-runtime.js'
import type { HarnessServerConfig } from './server-config.js'
import { harnessServerHttpServiceKey } from './http/harness-http.js'
import { harnessDefinition } from './definition.js'
import { directoryPickerCapabilityId, directoryPickerServiceKey } from '@anybox/directory-picker'
import type { DirectoryPickerPort } from '@anybox/directory-picker'
export { harnessDefinition } from './definition.js'
export const harnessServerHttp = Object.freeze({ service: harnessServerHttpServiceKey,
  capabilities: Object.freeze(['projects.path', 'images', 'project-files', 'sse', 'units']),
  legacyRoutes: ['models', 'prompts', 'tools', 'agents', 'projects', 'sessions', 'runs', 'changes'].map(path => ({ prefix: `/api/v1/${path}`, stripPrefix: '/api/v1' })),
  /** Remote units authenticate with their own credential; device tokens are never accepted here. */
  selfAuthenticated: Object.freeze(['/units/unit']) })
export function harnessServerApplication(config: HarnessServerConfig, options: HarnessServerRuntimeOptions = {}): ApplicationRegistration {
  return { capabilityRequirements: { required: { 'storage.sqlite': '^1.0.0' }, optional: { 'system.directory-picker': '^1.0.0' } }, definition: harnessDefinition, createRuntime: (root, context) => createHarnessServerRuntime(root, config, options, {
    registerStopGuard: guard => root.get<ProductActivityPort>(productActivityServiceKey)!.registerGuard('agent', guard),
    http: { inject: [productActivityServiceKey, ...(options.authenticated === false ? [] : [hostAccessServiceKey]),
      ...(context?.capabilities[directoryPickerCapabilityId] ? [directoryPickerServiceKey] : [])], resolve: deps => {
      const access = deps[hostAccessServiceKey] as HostAccessPort | undefined
      return { activity: deps[productActivityServiceKey] as ProductActivityPort,
        directoryPicker: context?.capabilities[directoryPickerCapabilityId] ? deps[directoryPickerServiceKey] as DirectoryPickerPort : null,
        instanceId: () => access?.instance.instanceId ?? null,
        ...(access ? { onRevoked: (listener: (id: string) => void | Promise<void>) => access.onRevoked(listener) } : {}) }
    } },
  }), http: harnessServerHttp }
}

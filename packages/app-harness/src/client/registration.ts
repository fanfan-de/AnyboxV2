import type { ApplicationRegistration } from '@anybox/application-api/nya'
import { harnessDefinition } from '../definition.js'
import { harnessAssets } from '../assets.js'
import { createHarnessClientRuntime } from './runtime.js'
import type { HarnessClientRuntimeOptions } from './runtime.js'
import { clientGatewayServiceKey } from './gateway.js'

export const harnessClientHttp = Object.freeze({ service: clientGatewayServiceKey, legacyRoutes: [
  { prefix: '/api/client/v1/connections', stripPrefix: '/api/client/v1' },
  { prefix: '/api/client/v1/local', stripPrefix: '/api/client/v1' },
  { prefix: '/api/connections', stripPrefix: '/api' },
] })
export function harnessClientApplication(options: HarnessClientRuntimeOptions = {}): ApplicationRegistration {
  return { capabilityRequirements: { required: { 'storage.sqlite': '^1.0.0' }, optional: { 'system.directory-picker': '^1.0.0' } }, definition: { ...harnessDefinition, web: { entry: '/applications/harness/web/harness-app.js', styles: ['/apps/agent/style.css'], legacyRoutes: ['#/harness/', '#/products/agent', '#/projects/'] } },
    createRuntime: (root, context) => createHarnessClientRuntime(root, options, context), http: harnessClientHttp, assets: harnessAssets }
}

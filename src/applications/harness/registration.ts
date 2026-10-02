import type { ApplicationRegistration } from '../../host/applications/registration.js'
import type { ProductDefinition } from '../../host/applications/contracts.js'
import { createHarnessClientRuntime } from './client/runtime.js'
import type { HarnessClientRuntimeOptions } from './client/runtime.js'
import { createHarnessRuntime } from './runtime.js'
import type { HarnessRuntimeOptions } from './runtime.js'
import type { WebStartupConfig } from './startup-config.js'
import { clientGatewayServiceKey } from './client/gateway.js'
import { harnessHttpServiceKey } from './http/harness-http.js'
import { harnessAssets } from './assets.js'
export const harnessDefinition: ProductDefinition = Object.freeze({ id: 'agent', name: 'Harness', icon: 'agent',
  description: '使用本地或远程 Agent，管理项目、会话、模型与 Prompt。' })
export const harnessExecutionHttp = Object.freeze({ service: harnessHttpServiceKey,
  capabilities: Object.freeze(['projects.path', 'images', 'project-files', 'sse']),
  legacyRoutes: ['models', 'prompts', 'agents', 'projects', 'sessions', 'runs', 'changes'].map(path => ({ prefix: `/api/v1/${path}`, stripPrefix: '/api/v1' })) })
export const harnessClientHttp = Object.freeze({ service: clientGatewayServiceKey, legacyRoutes: [
  { prefix: '/api/client/v1/connections', stripPrefix: '/api/client/v1' },
  { prefix: '/api/client/v1/local', stripPrefix: '/api/client/v1' },
  { prefix: '/api/connections', stripPrefix: '/api' },
] })
export function harnessClientApplication(options: HarnessClientRuntimeOptions = {}): ApplicationRegistration {
  return { definition: { ...harnessDefinition, web: { entry: '/applications/harness/web/harness-app.js', styles: ['/apps/agent/style.css'], legacyRoutes: ['#/harness/', '#/products/agent', '#/projects/'] } },
    createRuntime: root => createHarnessClientRuntime(root, options), http: harnessClientHttp, assets: harnessAssets }
}
export function harnessExecutionApplication(config: WebStartupConfig, options: HarnessRuntimeOptions = {}): ApplicationRegistration {
  return { definition: harnessDefinition, createRuntime: root => createHarnessRuntime(root, config, options), http: harnessExecutionHttp }
}

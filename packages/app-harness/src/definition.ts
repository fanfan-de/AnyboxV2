import type { ProductDefinition } from '@anybox/application-api/contracts'

/** Shared metadata must not load either runtime. */
export const harnessDefinition: ProductDefinition = Object.freeze({ id: 'agent', name: 'Anybox Harness', icon: 'agent',
  description: '使用本地或远程 Agent，管理项目、会话、模型与 Prompt。' })

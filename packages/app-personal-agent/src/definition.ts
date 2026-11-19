import type { ProductDefinition } from '@anybox/application-api/contracts'

export const personalAgentId = 'personal-agent'
export const personalAgentDefinition: ProductDefinition = Object.freeze({ id: personalAgentId, name: 'Personal Agent', icon: 'sparkles',
  description: '使用本地或远程 Agent，管理项目、会话、模型与 Prompt。' })

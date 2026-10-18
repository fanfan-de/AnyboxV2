import type { ProductDefinition } from '@anybox/application-api/contracts'

/** Stable application identity shared by the execution and client registrations; no Node paths or runtime handles. */
export const claudeAgentId = 'claude-agent'
export const claudeAgentDefinition: ProductDefinition = Object.freeze({ id: claudeAgentId, name: 'Claude Agent', icon: 'claude',
  description: '在已登录 Claude 的执行设备上运行 Agent 任务，复用那台设备的设置、hooks、插件与会话历史。Powered by Claude.' })
/** Nya service names. The execution adapter and the client gateway each provide one of them. */
export const claudeAgentHttpServiceKey = 'claude-agent.http'
export const claudeAgentGatewayServiceKey = 'claude-agent.gateway'
export const claudeAgentServerHttp = Object.freeze({ service: claudeAgentHttpServiceKey, capabilities: Object.freeze(['claude-agent.v1', 'sse']) })
export const claudeAgentClientHttp = Object.freeze({ service: claudeAgentGatewayServiceKey })

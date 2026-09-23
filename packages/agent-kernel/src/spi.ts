/** 兼容入口；实现接口由独立包维护，协调器构造选项仍属于实现包。 */
export type * from '@anybox/agent-contracts/spi'
export type { CoordinatorFactories } from './components/harness/coordinator.js'

import type { Component } from '@nya/core'
import type { Owned, ToolService } from '@anybox/agent-contracts/spi'
import { createLocalTools } from './local.js'

export function createToolComponent(factory: () => Owned<ToolService> = () => createLocalTools([])): Component.Object {
  return { name: 'tools', apply(ctx) {
    const owned = factory()
    ctx.effect(() => () => owned.close(), 'tool service')
    ctx.provide('agent.tools', owned.service)
  } }
}

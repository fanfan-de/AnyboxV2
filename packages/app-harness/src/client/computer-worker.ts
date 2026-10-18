import type { Component } from '@nya/core'
import { connectLocalComputerWorker } from '../core/computer/worker-client.js'
import type { ComputerWorkerOptions, LocalComputerWorkerStatus } from '../core/computer/worker-port.js'

export const clientComputerServiceKey = 'client.computer'
export type ClientComputerPort = Pick<ReturnType<typeof connectLocalComputerWorker>, 'status' | 'start' | 'control'>
export type { LocalComputerWorkerStatus }

/** Owns only loopback observations. Client startup and disposal never start/stop the independent worker. */
export function createClientComputerComponent(options: ComputerWorkerOptions): Component.Object {
  return { name: 'client-computer', apply(ctx) {
    const observer = connectLocalComputerWorker({ requestTimeoutMs: 120_000, ...options, autoStart: false })
    ctx.effect(() => () => observer.closeObserver(), 'cancel and join local Computer management observations')
    ctx.provide(clientComputerServiceKey, observer)
  } }
}

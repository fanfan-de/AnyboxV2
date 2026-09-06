/** 只通过 Nya 公开入口装配应用；进程信号和退出期限由宿主负责。 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, FiberState } from '@nya/core'
import type { Fiber } from '@nya/core'
import { Loader } from '@nya/loader'
import { Include } from '@nya/include'
import type { IncludeReport } from '@nya/include'
import { Hmr } from '@nya/hmr'
import type { HmrReport } from '@nya/hmr'
import { ConsoleLogger } from '@nya/logger-console'
import { Timer } from '@nya/timer'
import { ApplicationClosedError, ApplicationNotReadyError } from './types.js'
import type { Application, ApplicationOptions } from './types.js'

export { ApplicationClosedError, ApplicationNotReadyError } from './types.js'
export type { Application, ApplicationOptions } from './types.js'

function requireActive(fiber: Fiber): void {
  if (fiber.state === FiberState.FAILED) throw fiber.error
  if (fiber.state !== FiberState.ACTIVE) {
    throw new Error(`required component ${fiber.name} is ${fiber.state}`, { cause: fiber.inspect() })
  }
}

function throwErrors(errors: readonly unknown[], message: string): never {
  const unique = errors.filter((error, index) => errors.findIndex(other => Object.is(other, error)) === index)
  if (unique.length === 1) throw unique[0]
  throw new AggregateError(unique, message)
}

function requireConfiguration(report: IncludeReport): void {
  if (report.status === 'partial') {
    throwErrors([
      ...report.failures.map(failure => failure.error),
      ...report.entries.filter(entry => entry.state === 'failed').map(entry => entry.error),
    ], 'application configuration applied partially')
  }
}

export function createApplication(options: ApplicationOptions): Application {
  if (!options || typeof options.configPath !== 'string' || !options.configPath) {
    throw new TypeError('configPath must be a non-empty string')
  }
  const configPath = resolve(options.configPath)
  const loggerOptions = options.logger === false ? false : { level: 'info' as const, ...options.logger }
  const development = options.development && {
    ...options.development,
    entries: options.development.entries && [...options.development.entries],
  }
  const context = new Context()
  let state: 'new' | 'starting' | 'running' | 'closing' | 'closed' = 'new'
  let startup: Promise<void> | undefined
  let shutdown: Promise<void> | undefined
  let controls: Promise<unknown> = Promise.resolve()
  let firstFailure: { error: unknown } | undefined
  let resolveFailure!: (error: unknown) => void
  const failure = new Promise<unknown>(resolve => { resolveFailure = resolve })
  let requestRestart!: (report: HmrReport) => void
  const restartRequested = new Promise<HmrReport>(resolve => { requestRestart = resolve })

  const reportFailure = (error: unknown) => {
    if (firstFailure) return
    firstFailure = { error }
    resolveFailure(error)
  }
  // 最早登记，确保能观察后续所有组件的启动、运行和清理失败。
  context.effect(() => context.registry.subscribe(event => {
    if (event.type === 'state' && event.fiber.state === FiberState.FAILED) reportFailure(event.fiber.error)
  }), 'application lifecycle failures')

  const assertOpen = () => {
    if (state === 'closing' || state === 'closed') throw new ApplicationClosedError()
  }
  const assertRunning = () => {
    assertOpen()
    if (state !== 'running') throw new ApplicationNotReadyError(context.fiber.inspect())
  }
  const control = <T>(operation: () => Promise<T>): Promise<T> => {
    try { assertRunning() } catch (error) { return Promise.reject(error) }
    const task = controls.catch(() => {}).then(async () => {
      assertRunning()
      const result = await operation()
      assertRunning()
      return result
    })
    controls = task
    void task.catch(() => {})
    return task
  }

  const close = (): Promise<void> => {
    if (shutdown) return shutdown
    state = 'closing'
    // 先缓存再调用 Core，日志观察者重入 close() 时仍得到同一个 Promise。
    shutdown = Promise.resolve().then(async () => {
      const [cleanup] = await Promise.allSettled([context.fiber.dispose(), controls])
      if (cleanup.status === 'rejected') throw cleanup.reason
    }).then(
      () => { state = 'closed' },
      (error: unknown) => { state = 'closed'; reportFailure(error); throw error },
    )
    void shutdown.catch(() => {})
    return shutdown
  }

  return {
    context,
    failure,
    restartRequested,
    start() {
      try { assertOpen() } catch (error) { return Promise.reject(error) }
      if (startup) return startup
      state = 'starting'
      startup = Promise.resolve().then(async () => {
        assertOpen()
        if (loggerOptions !== false) {
          const logger = context.installComponent(ConsoleLogger, loggerOptions)
          await logger
          assertOpen()
          requireActive(logger)
        }
        const timer = context.installComponent(Timer)
        await timer
        assertOpen()
        requireActive(timer)
        const loader = context.installComponent(Loader, { baseUrl: pathToFileURL(configPath).href })
        await loader
        assertOpen()
        requireActive(loader)
        const include = context.installComponent(Include, { id: 'anybox', path: configPath })
        await include
        assertOpen()
        requireActive(include)

        if (development) {
          const hmr = context.installComponent(Hmr, {
            baseUrl: pathToFileURL(configPath).href,
            ...development,
            include: context.include,
            onReport(report) {
              if (report.status === 'restart-required') requestRestart(report)
              development.onReport?.(report)
            },
          })
          await hmr
          assertOpen()
          requireActive(hmr)
          // 先准备 HMR 的代码 Resolver，再由 start() 读取 Include 声明。
          const report = await context.hmr.start()
          assertOpen()
          if (report.status !== 'applied' && report.status !== 'unchanged') {
            throwErrors(report.errors, `application development startup: ${report.status}`)
          }
          requireConfiguration(context.include.report()!)
        } else {
          const report = await context.include.refresh()
          assertOpen()
          requireConfiguration(report)
        }
        await context.loader.awaitIdle()
        assertOpen()
        state = 'running'
        context.logger.info('application started')
      }).catch(async (error: unknown) => {
        if (!(error instanceof ApplicationClosedError)) reportFailure(error)
        try { await close() } catch (cleanupError) {
          if (!Object.is(error, cleanupError)) throw new AggregateError([error, cleanupError], 'application startup and cleanup failed')
        }
        throw error
      })
      void startup.catch(() => {})
      return startup
    },
    previewConfig: (document, filename) => control(() => context.include.preview(document, filename)),
    saveConfig: (document, filename) => control(() => context.include.save(document, filename)),
    refreshConfig: () => control(() => context.include.refresh()),
    recover: id => control(() => context.include.recover(id)),
    close,
  }
}

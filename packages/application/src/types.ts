import type { Context } from '@nya/core'
import type { IncludeDocument, IncludeOperation, IncludeReport } from '@nya/include'
import type { ConsoleLoggerOptions } from '@nya/logger-console'

export interface ApplicationOptions {
  /** 根 JSON 声明文件；相对路径从创建应用时的 cwd 解析。 */
  readonly configPath: string
  readonly logger?: false | ConsoleLoggerOptions
}

export interface Application {
  /** 框架公共控制器、日志、事件和诊断；文件受管声明通过 Include 修改。 */
  readonly context: Context
  /** 首次启动、组件生命周期或关闭失败的原始错误；正常关闭不会完成它。 */
  readonly failure: Promise<unknown>
  start(): Promise<void>
  previewConfig(document?: IncludeDocument, filename?: string): Promise<readonly IncludeOperation[]>
  /** saved 与 status 分别表示文件保存和运行结果；partial 不等于完整应用成功。 */
  saveConfig(document: IncludeDocument, filename?: string): Promise<IncludeReport>
  refreshConfig(): Promise<IncludeReport>
  recover(loaderId: string): Promise<IncludeReport>
  close(): Promise<void>
}

export class ApplicationClosedError extends Error {
  constructor() {
    super('application is closing or closed')
    this.name = 'ApplicationClosedError'
  }
}

export class ApplicationNotReadyError extends Error {
  constructor(cause?: unknown) {
    super('application is not running', { cause })
    this.name = 'ApplicationNotReadyError'
  }
}

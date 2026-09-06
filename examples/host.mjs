/** 可执行组件宿主：终端、进程信号和退出期限留在这里。 */
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createApplication } from '@anybox/application'

const args = process.argv.slice(2)
let configPath = fileURLToPath(new URL('./application/config.json', import.meta.url))
let development = false
let once = false
const entries = []
for (let index = 0; index < args.length; index++) {
  const argument = args[index]
  if (argument === '--dev') development = true
  else if (argument === '--once') once = true
  else if ((argument === '--config' || argument === '--entry') && args[index + 1]) {
    const value = resolve(args[++index])
    if (argument === '--config') configPath = value
    else entries.push(pathToFileURL(value).href)
  } else {
    throw new Error('用法：npm start -- [--dev] [--once] [--config file.json] [--entry component.mjs]')
  }
}
// 通过 --entry 明确列出代码入口；空配置也可以只观察配置文件变化。
const application = createApplication({
  configPath,
  development: development ? {
    entries,
    watch: !once,
    onReport(report) {
      console.log(`HMR ${report.status} (${report.phase}), generation=${report.generation}, pid=${report.pid}`)
      for (const error of report.errors) console.error(error)
    },
  } : undefined,
})
let requestStop
const stopped = new Promise(resolve => { requestStop = resolve })
let closing
let terminal
let stopping = false
const onInterrupt = () => { void stop(130) }
const onTerminate = () => { void stop(143) }
const onMessage = message => { if (message === 'close') void stop() }

function stop(code = 0) {
  if (closing) return closing
  stopping = true
  process.exitCode = code
  terminal?.close()
  const deadline = setTimeout(() => {
    console.error('关闭超过 5 秒，资源清理尚未确认完成。')
    process.exit(1)
  }, 5_000)
  closing = Promise.resolve().then(() => application.close()).catch(error => {
    console.error(error)
    process.exitCode = 1
  }).finally(() => {
    clearTimeout(deadline)
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onTerminate)
    process.off('message', onMessage)
    if (process.connected) process.disconnect()
    requestStop()
  })
  return closing
}

process.on('SIGINT', onInterrupt)
process.on('SIGTERM', onTerminate)
process.on('message', onMessage)
void application.failure.then(error => {
  console.error(error)
  void stop(1)
})
void application.restartRequested.then(() => {
  console.error('开发环境需要重启；关闭完成后请重新运行命令。')
  void stop(75)
})

try {
  await application.start()
  if (!stopping) {
    if (once) await stop()
    else {
      terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true })
      application.context.effect(() => () => terminal.close(), 'host terminal')
      terminal.on('SIGINT', onInterrupt)
      terminal.on('close', () => { if (!stopping) void stop() })
      console.log('组件宿主已启动；Ctrl+C 关闭。')
      process.send?.({ type: 'ready' })
    }
  }
} catch (error) {
  if (!stopping) { console.error(error); await stop(1) }
}
await stopped

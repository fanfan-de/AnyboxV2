import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve, sep } from 'node:path'
import { createApplication } from '../dist/index.js'

export const workspace = fileURLToPath(new URL('../../../', import.meta.url))

export function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export function waitFor(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(
      result => { signal.removeEventListener('abort', abort); resolve(result) },
      error => { signal.removeEventListener('abort', abort); reject(error) },
    )
  })
}

export const valueSource = `
import { Context } from '@nya/core'
export default {
  name: 'test-value',
  apply(ctx, config) {
    if (!(ctx.root instanceof Context)) throw new Error('duplicate Core identity')
    ctx.provide('testValue', { value: config.value })
    ctx.logger.info('value ready', config)
  },
}
`

const consumerSource = `
export default {
  name: 'test-consumer',
  inject: ['testValue'],
  apply(ctx) {
    ctx.provide('testConsumer', { value: ctx.testValue.value })
  },
}
`

export async function fixture(t, options = {}, document) {
  const directory = await mkdtemp(join(workspace, '.test-application-'))
  const configPath = join(directory, 'config.json')
  const valuePath = join(directory, 'value.mjs')
  const config = document ?? {
    version: 1,
    entries: [
      { id: 'value', name: './value.mjs', config: { value: 'one' } },
      { id: 'consumer', name: './consumer.mjs' },
    ],
  }
  await writeFile(valuePath, valueSource)
  await writeFile(join(directory, 'consumer.mjs'), consumerSource)
  await writeFile(configPath, JSON.stringify(config))
  const applications = []
  t.after(async () => {
    await Promise.allSettled(applications.map(app => app.close()))
    // 临时目录由本测试创建；删除前验证绝对目标仍位于工作区且具有专用前缀。
    const absolute = resolve(directory)
    if (!absolute.startsWith(resolve(workspace) + sep + '.test-application-')) throw new Error('unexpected fixture path')
    await rm(absolute, { recursive: true, force: true, maxRetries: 3 })
  })
  const create = (overrides = {}) => {
    const app = createApplication({ configPath, logger: false, ...options, ...overrides })
    applications.push(app)
    return app
  }
  return {
    directory, configPath, valuePath, config, create,
    readConfig: async () => JSON.parse(await readFile(configPath, 'utf8')),
    writeConfig: next => writeFile(configPath, JSON.stringify(next)),
  }
}

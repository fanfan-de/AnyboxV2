import { Context } from '@nya/core'
import { createApplicationRuntime } from '@anybox/application-api/nya'
import { createLocalSqliteComponent } from '@anybox/storage-sqlite'
import { loadInstalledApplicationCatalog, loadInstalledComputerWorkerEntry, isInstalledPackageCorruption } from '../../dist/package-management/loader.js'
globalThis.__loaderPublic = { Context, createApplicationRuntime, createLocalSqliteComponent }
let loaded, runtime
const launched = []
const replies = new Map()
process.on('message', async message => {
  if (message.type === 'reply') { replies.get(message.id)?.(message.value); replies.delete(message.id); return }
  if (message.type === 'load') {
    const registry = Object.fromEntries(['claim', 'ready'].map(method => [method, async credential => {
      const id = `${method}-${credential.usageId}`
      const promise = new Promise(resolve => replies.set(id, resolve))
      process.send({ type: method, id, credential: { usageId: credential.usageId } })
      return promise
    }]))
    try {
      loaded = await (message.worker ? loadInstalledComputerWorkerEntry : loadInstalledApplicationCatalog)({ ...message.options, registry, ...(message.options.enableStartRole ? { startRole: async (identity, input) => { launched.push({ identity, ...input }) } } : {}), ...(message.options.enableChannel ? { channel: async (identity, payload, signal) => ({ identity, payload, aborted: signal.aborted }) } : {}) })
      process.send({ type: 'loaded', snapshot: loaded.snapshot, applications: loaded.applications?.map(registration => ({ definition: registration.definition, capabilityRequirements: registration.capabilityRequirements, hasRuntime: !!registration.createRuntime, hasChannel: !!registration.channel, assets: registration.assets })), values: globalThis.__loaderValues })
    } catch (error) { process.send({ type: 'failed', code: error.code, message: error.message, packageIdentity: error.packageIdentity, corruption: isInstalledPackageCorruption(error) }) }
  }
  if (message.type === 'open') {
    try { runtime = loaded.applications[0].createRuntime(new Context(), { capabilities: {} }); await runtime.open(); process.send({ type: 'opened', launched }) } catch (error) { process.send({ type: 'failed', code: error.code }) }
  }
  if (message.type === 'stop') { await runtime.stop(); process.send({ type: 'stopped' }) }
  if (message.type === 'invoke-role') {
    try { await globalThis.__loaderStart('computer-worker', { ownership: 'independent', args: ['serve', 'opaque-directory'] }); process.send({ type: 'invoked-role', launched }) } catch (error) { process.send({ type: 'failed', code: error.code }) }
  }
  if (message.type === 'invoke-channel') {
    try { process.send({ type: 'channel-result', value: await globalThis.__loaderChannel.request(message.payload, new AbortController().signal) }) } catch (error) { process.send({ type: 'failed', code: error.code }) }
  }
  if (message.type === 'ready') {
    try { process.send({ type: 'ready-result', actual: await loaded.ready() }) } catch (error) { process.send({ type: 'failed', code: error.code }) }
  }
  if (message.type === 'main') {
    try { await loaded.main(message.args); process.send({ type: 'main-result', values: globalThis.__loaderValues }) } catch (error) { process.send({ type: 'failed', code: error.code }) }
  }
  if (message.type === 'close') { await loaded?.close(); process.send({ type: 'closed' }) }
  if (message.type === 'lazy') {
    try { process.send({ type: 'lazy-result', value: await globalThis.__loaderLazy() }) } catch (error) { process.send({ type: 'failed', code: error.code }) }
  }
  if (message.type === 'exit') process.exit(0)
})
process.send({ type: 'booted' })

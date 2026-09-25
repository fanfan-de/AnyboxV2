import { AsyncEntry } from '@napi-rs/keyring'

const messages = Object.freeze({
  'store-unavailable': 'credential store is unavailable',
  'operation-failed': 'credential store operation failed',
  closed: 'credential component is closed',
  cancelled: 'credential operation was cancelled',
})

export class CredentialFailure extends Error {
  constructor(category) {
    super(messages[category])
    this.name = 'CredentialFailure'
    this.category = category
  }
}

export class UnmanagedCredentialError extends Error {
  constructor() {
    super('credential is not registered for management')
    this.name = 'UnmanagedCredentialError'
  }
}

function nonEmpty(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a non-empty string`)
  return value.trim()
}

function secret(value) {
  if (typeof value !== 'string' || !value.length || !value.trim()) {
    throw new TypeError('credential secret must be non-blank')
  }
  return value
}

/** Returns a frozen copy of the host's public catalog metadata. */
export function validateManagedCredentialDefinitions(definitions) {
  if (!Array.isArray(definitions)) throw new TypeError('managed credentials must be an array')
  const entries = definitions.map(definition => Object.freeze({
    id: nonEmpty(definition?.id, 'credential id'),
    label: nonEmpty(definition?.label, 'credential label'),
    category: nonEmpty(definition?.category, 'credential category'),
  }))
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  if (byId.size !== entries.length) throw new TypeError('managed credential ids must be unique')
  return Object.freeze(entries)
}

/** A framework-independent manager. The host chooses IDs; returned data never contains a secret. */
export function createApiKeyManager(definitions, store) {
  if (!store || typeof store.read !== 'function' || typeof store.write !== 'function' ||
      typeof store.delete !== 'function') throw new TypeError('credential store must provide read, write and delete')
  const entries = validateManagedCredentialDefinitions(definitions)
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  const requireEntry = id => {
    const entry = byId.get(id)
    if (!entry) throw new UnmanagedCredentialError()
    return entry
  }
  return Object.freeze({
    async list() {
      return Object.freeze(await Promise.all(entries.map(async entry => Object.freeze({
        ...entry,
        configured: Boolean((await store.read(entry.id))?.trim()),
      }))))
    },
    async write(id, value) {
      const entry = requireEntry(id)
      await store.write(entry.id, secret(value))
      return Object.freeze({ ...entry, configured: true })
    },
    async delete(id) {
      const entry = requireEntry(id)
      await store.delete(entry.id)
      return Object.freeze({ ...entry, configured: false })
    },
  })
}

function createOperationTracker() {
  const active = new Map()
  let accepting = true
  return {
    async run(work, signal) {
      if (!accepting) throw new CredentialFailure('closed')
      const controller = new AbortController()
      const abort = () => controller.abort(signal?.reason)
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
      const operation = (async () => {
        if (controller.signal.aborted) throw new CredentialFailure('cancelled')
        return work(controller.signal)
      })()
      active.set(controller, operation.then(() => {}, () => {}))
      try {
        const value = await operation
        if (controller.signal.aborted) throw new CredentialFailure('cancelled')
        return value
      } catch (error) {
        if (error instanceof CredentialFailure) throw error
        throw new CredentialFailure(controller.signal.aborted ? 'cancelled' : 'operation-failed')
      } finally {
        signal?.removeEventListener('abort', abort)
        active.delete(controller)
      }
    },
    async close() {
      accepting = false
      const pending = [...active]
      for (const [controller] of pending) controller.abort('credentials-disposed')
      await Promise.all(pending.map(([, exited]) => exited))
    },
  }
}

/** The OS-backed store. Operations on the same ID are serialized in admission order. */
export function createSystemKeyringStore(options) {
  const namespace = nonEmpty(options?.namespace, 'credential namespace')
  const openEntry = options?.openEntry ?? ((service, id) =>
    new AsyncEntry(service, id, { linux: { store: 'secret-service' } }))
  if (typeof openEntry !== 'function') throw new TypeError('credential entry factory must be a function')
  try { openEntry(namespace, 'startup-probe') } catch { throw new CredentialFailure('store-unavailable') }
  const operations = createOperationTracker()
  const tails = new Map()
  const ordered = (id, signal, work) => {
    const previous = tails.get(id) ?? Promise.resolve()
    let release
    const tail = new Promise(resolve => { release = resolve })
    tails.set(id, tail)
    return (async () => {
      try {
        await previous
        if (signal.aborted) throw new CredentialFailure('cancelled')
        return await work()
      } finally {
        if (tails.get(id) === tail) tails.delete(id)
        release()
      }
    })()
  }
  return Object.freeze({
    async read(id, signal) {
      const target = nonEmpty(id, 'credential id')
      const value = await operations.run(ownedSignal => ordered(target, ownedSignal,
        () => openEntry(namespace, target).getPassword(ownedSignal)), signal)
      return typeof value === 'string' ? value : undefined
    },
    async write(id, value) {
      const target = nonEmpty(id, 'credential id')
      if (typeof value !== 'string' || !value.length) throw new TypeError('credential secret must be a non-empty string')
      await operations.run(signal => ordered(target, signal,
        () => openEntry(namespace, target).setPassword(value, signal)))
    },
    async delete(id) {
      const target = nonEmpty(id, 'credential id')
      return operations.run(signal => ordered(target, signal,
        () => openEntry(namespace, target).deleteCredential(signal))).then(deleted => deleted === true)
    },
    close: () => operations.close(),
  })
}

/** A self-contained API Key service: one catalog and one OS-backed store, with no framework or project services. */
export function createApiKeyService(options) {
  const definitions = validateManagedCredentialDefinitions(options?.definitions)
  const allowed = new Set(definitions.map(entry => entry.id))
  const store = createSystemKeyringStore({ namespace: options?.namespace, openEntry: options?.openEntry })
  const manager = createApiKeyManager(definitions, store)
  return Object.freeze({
    read(id, signal) {
      if (!allowed.has(id)) throw new UnmanagedCredentialError()
      return store.read(id, signal)
    },
    list: () => manager.list(),
    write: (id, value) => manager.write(id, value),
    delete: id => manager.delete(id),
    close: () => store.close(),
  })
}

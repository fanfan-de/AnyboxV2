import type { Component } from '@nya/core'
import type { OwnedCall, RuntimeInputs } from '../contracts.js'
import { localStorageServiceKey } from '../../../../storage/port.js'
import type { LocalStoragePort, StorageMigration, StorageReader, StorageRow, StorageTransaction } from '../../../../storage/port.js'
import { computerError, computerIdentity, computerInstanceRef, computerSpecification } from './domain.js'
import type { ComputerInstance, ComputerInstanceRef, ComputerPin, ComputerResource } from './domain.js'
import { computerInstanceProviderServiceKey, computerServiceKey } from './port.js'
import type { ComputerInstanceProvider, ComputersPort } from './port.js'

const migrations: readonly StorageMigration[] = [{ version: 1, up(tx) {
  tx.execute(`CREATE TABLE harness_computers (
    computer_id TEXT PRIMARY KEY, specification_json TEXT NOT NULL,
    activation_revision INTEGER NOT NULL, current_instance_id TEXT, created_at TEXT NOT NULL
  )`)
  tx.execute(`CREATE TABLE harness_computer_instances (
    instance_id TEXT PRIMARY KEY, computer_id TEXT NOT NULL, instance_generation INTEGER NOT NULL,
    provider_id TEXT NOT NULL, provider_ref TEXT NOT NULL, platform TEXT NOT NULL, architecture TEXT NOT NULL,
    activated_at TEXT NOT NULL, status TEXT NOT NULL, UNIQUE(computer_id, instance_generation),
    FOREIGN KEY(computer_id) REFERENCES harness_computers(computer_id)
  )`)
  tx.execute(`CREATE TABLE harness_computer_pins (
    pin_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, instance_id TEXT NOT NULL, instance_generation INTEGER NOT NULL,
    created_at TEXT NOT NULL, released_at TEXT,
    FOREIGN KEY(instance_id) REFERENCES harness_computer_instances(instance_id)
  )`)
  tx.execute('CREATE INDEX harness_computer_active_pins ON harness_computer_pins(instance_id, released_at)')
} }]

function textValue(row: StorageRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw computerError('computer-unavailable')
  return value
}
function integerValue(row: StorageRow, key: string, minimum: number): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw computerError('computer-unavailable')
  return value
}
function resourceFrom(row: StorageRow): ComputerResource {
  const spec = computerSpecification(JSON.parse(textValue(row, 'specification_json')))
  return Object.freeze({ computerId: textValue(row, 'computer_id'), spec,
    activationRevision: integerValue(row, 'activation_revision', 0), createdAt: textValue(row, 'created_at') })
}
function instanceFrom(row: StorageRow): ComputerInstance {
  const status = row.status
  if (status !== 'ready' && status !== 'retired') throw computerError('computer-unavailable')
  return Object.freeze({ computerInstanceId: textValue(row, 'instance_id'), computerId: textValue(row, 'computer_id'),
    instanceGeneration: integerValue(row, 'instance_generation', 1), providerId: textValue(row, 'provider_id'),
    providerRef: textValue(row, 'provider_ref'), platform: textValue(row, 'platform'), architecture: textValue(row, 'architecture'),
    activatedAt: textValue(row, 'activated_at'), status })
}
function pinFrom(row: StorageRow): ComputerPin {
  if (row.released_at !== null && typeof row.released_at !== 'string') throw computerError('computer-unavailable')
  return Object.freeze({ pinId: textValue(row, 'pin_id'), ownerId: textValue(row, 'owner_id'),
    computerInstanceId: textValue(row, 'instance_id'), instanceGeneration: integerValue(row, 'instance_generation', 1),
    createdAt: textValue(row, 'created_at'), releasedAt: row.released_at })
}
function currentInstance(reader: StorageReader, ref: ComputerInstanceRef): ComputerInstance {
  const row = reader.get(`SELECT i.* FROM harness_computer_instances i
    JOIN harness_computers c ON c.current_instance_id = i.instance_id WHERE i.instance_id = ?`, [ref.computerInstanceId])
  if (!row || row.status !== 'ready' || row.instance_generation !== ref.instanceGeneration) throw computerError('computer-generation-mismatch')
  return instanceFrom(row)
}

interface Activation {
  result: Promise<ComputerInstance>
  providerCall?: ReturnType<ComputerInstanceProvider['activate']>
  cancelled: boolean
}

/** Durable logical identities and pins; machine activation stays outside every storage transaction. */
export function createComputersComponent(inputs: RuntimeInputs): Component.Object<void, {
  [localStorageServiceKey]: LocalStoragePort
  [computerInstanceProviderServiceKey]: ComputerInstanceProvider
}> {
  return { name: 'harness-computers', inject: [localStorageServiceKey, computerInstanceProviderServiceKey],
    async apply(ctx, _config, deps) {
      const db = deps[localStorageServiceKey], provider = deps[computerInstanceProviderServiceKey]
      await db.migrate('computers', migrations)
      let accepting = true
      const activations = new Map<string, Activation>()
      const ready = new Map<string, ComputerInstance>()
      const pending = new Set<Promise<unknown>>()
      const cleanupFailures = new Set<unknown>()
      const assertOpen = () => { if (!accepting) throw computerError('computer-unavailable') }
      const track = <T>(work: Promise<T>): Promise<T> => {
        pending.add(work)
        void work.finally(() => pending.delete(work)).catch(() => {})
        return work
      }
      ctx.effect(() => async () => {
        accepting = false
        for (const activation of activations.values()) {
          activation.cancelled = true
          try { activation.providerCall?.cancel('computer service closing') } catch (error) { cleanupFailures.add(error) }
        }
        await Promise.allSettled([...pending])
        if (cleanupFailures.size) throw computerError('computer-cleanup-failed')
      }, 'stop computer admission and join activations')

      const runActivation = async (computerId: string, activation: Activation): Promise<ComputerInstance> => {
        const initial = await db.transaction(tx => {
          if (!accepting || activation.cancelled) throw computerError('computer-cancelled')
          const row = tx.get('SELECT * FROM harness_computers WHERE computer_id = ?', [computerId])
          if (!row) throw computerError('computer-missing')
          const resource = resourceFrom(row)
          if (resource.spec.providerId !== provider.providerId) throw computerError('computer-unavailable')
          const previousRow = row.current_instance_id === null ? undefined : tx.get(
            'SELECT * FROM harness_computer_instances WHERE instance_id = ?', [row.current_instance_id])
          const previousInstance = previousRow ? instanceFrom(previousRow) : undefined
          const activationRevision = resource.activationRevision + 1
          if (!Number.isSafeInteger(activationRevision)) throw computerError('computer-unavailable')
          tx.execute('UPDATE harness_computers SET activation_revision = ? WHERE computer_id = ?', [activationRevision, computerId])
          return { resource: Object.freeze({ ...resource, activationRevision }), previousInstance }
        })
        if (!accepting || activation.cancelled) throw computerError('computer-cancelled')
        let call: ReturnType<ComputerInstanceProvider['activate']>
        try { call = provider.activate({ ...initial, activationId: inputs.newId() }) }
        catch { throw computerError('computer-unavailable') }
        activation.providerCall = call
        let output: Awaited<typeof call.result> | undefined
        let failed = false
        // Observe exit immediately: a rejected done must not hang behind a broken result.
        const result = call.result.then(value => { output = value }, () => { failed = true })
        const done = call.done.then(() => true, error => { cleanupFailures.add(error); return false })
        const first = await Promise.race([result.then(() => 'result' as const), done.then(ok => ok ? 'done' as const : 'cleanup-failed' as const)])
        if (first !== 'cleanup-failed') await result
        if (!await done) throw computerError('computer-cleanup-failed')
        if (activation.cancelled || !accepting) throw computerError('computer-cancelled')
        if (failed || !output) throw computerError('computer-unavailable')
        const providerRef = computerIdentity(output.providerRef)
        if (output.platform !== initial.resource.spec.platform || output.architecture !== initial.resource.spec.architecture) {
          throw computerError('computer-unavailable')
        }
        const instance = await db.transaction(tx => {
          if (!accepting || activation.cancelled) throw computerError('computer-cancelled')
          const current = tx.get('SELECT * FROM harness_computers WHERE computer_id = ?', [computerId])
          if (!current || current.activation_revision !== initial.resource.activationRevision) throw computerError('computer-conflict')
          const previous = initial.previousInstance
          if (previous && previous.providerId === provider.providerId && previous.providerRef === providerRef) {
            return currentInstance(tx, previous)
          }
          if (previous && tx.get('SELECT 1 FROM harness_computer_pins WHERE instance_id = ? AND released_at IS NULL',
            [previous.computerInstanceId])) throw computerError('computer-pinned')
          const latest = tx.get('SELECT MAX(instance_generation) AS generation FROM harness_computer_instances WHERE computer_id = ?', [computerId])
          const lastGeneration = latest?.generation
          const instanceGeneration = typeof lastGeneration === 'number' ? lastGeneration + 1 : 1
          if (!Number.isSafeInteger(instanceGeneration)) throw computerError('computer-unavailable')
          const next: ComputerInstance = Object.freeze({ computerInstanceId: inputs.newId(), computerId, instanceGeneration,
            providerId: provider.providerId, providerRef, platform: output!.platform, architecture: output!.architecture,
            activatedAt: inputs.now(), status: 'ready' })
          if (previous) tx.execute('UPDATE harness_computer_instances SET status = ? WHERE instance_id = ?', ['retired', previous.computerInstanceId])
          tx.execute(`INSERT INTO harness_computer_instances
            (instance_id, computer_id, instance_generation, provider_id, provider_ref, platform, architecture, activated_at, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [next.computerInstanceId, computerId, instanceGeneration,
            next.providerId, providerRef, next.platform, next.architecture, next.activatedAt, next.status])
          tx.execute('UPDATE harness_computers SET current_instance_id = ? WHERE computer_id = ?', [next.computerInstanceId, computerId])
          return next
        })
        ready.set(computerId, instance)
        return instance
      }
      const observe = (result: Promise<ComputerInstance>): OwnedCall<ComputerInstance> => {
        let cancel!: () => void
        const cancelled = new Promise<ComputerInstance>((_yes, no) => {
          cancel = () => no(computerError('computer-cancelled'))
        })
        const observation = Promise.race([result, cancelled])
        const done = observation.then(() => {}, error => {
          if (error instanceof Error && 'code' in error && error.code === 'computer-cleanup-failed') throw error
        })
        void observation.catch(() => {})
        void done.catch(() => {})
        return { result: observation, done, cancel }
      }
      const service: ComputersPort = {
        reserveIn(tx, input) {
          assertOpen()
          const computerId = computerIdentity(input.computerId), spec = computerSpecification(input.spec)
          const row = tx.get('SELECT * FROM harness_computers WHERE computer_id = ?', [computerId])
          if (row) {
            const resource = resourceFrom(row)
            if (JSON.stringify(resource.spec) !== JSON.stringify(spec)) throw computerError('computer-conflict')
            return resource
          }
          tx.execute(`INSERT INTO harness_computers (computer_id, specification_json, activation_revision, current_instance_id, created_at)
            VALUES (?, ?, 0, NULL, ?)`, [computerId, JSON.stringify(spec), inputs.now()])
          return resourceFrom(tx.get('SELECT * FROM harness_computers WHERE computer_id = ?', [computerId])!)
        },
        get(computerId) {
          assertOpen(); computerIdentity(computerId)
          return track(db.read(reader => {
            const row = reader.get('SELECT * FROM harness_computers WHERE computer_id = ?', [computerId])
            return row ? resourceFrom(row) : undefined
          }))
        },
        list() {
          assertOpen()
          return track(db.read(reader => Object.freeze(reader.all('SELECT * FROM harness_computers ORDER BY created_at, computer_id').map(resourceFrom))))
        },
        activate(computerId) {
          assertOpen(); computerIdentity(computerId)
          const confirmed = ready.get(computerId)
          if (confirmed) return observe(Promise.resolve(confirmed))
          const shared = activations.get(computerId)
          if (shared) return observe(shared.result)
          const activation: Activation = { result: undefined as unknown as Promise<ComputerInstance>, cancelled: false }
          activation.result = track(Promise.resolve().then(() => runActivation(computerId, activation)))
          activations.set(computerId, activation)
          void activation.result.finally(() => activations.delete(computerId)).catch(() => {})
          return observe(activation.result)
        },
        requireInstance(input) {
          assertOpen()
          const ref = computerInstanceRef(input)
          return track(db.read(reader => currentInstance(reader, ref)))
        },
        pinIn(tx, input) {
          assertOpen()
          const pinId = computerIdentity(input.pinId), ownerId = computerIdentity(input.ownerId), ref = computerInstanceRef(input)
          currentInstance(tx, ref)
          const prior = tx.get('SELECT * FROM harness_computer_pins WHERE pin_id = ?', [pinId])
          if (prior) {
            const pin = pinFrom(prior)
            if (pin.ownerId !== ownerId || pin.computerInstanceId !== ref.computerInstanceId ||
              pin.instanceGeneration !== ref.instanceGeneration || pin.releasedAt !== null) throw computerError('computer-conflict')
            return pin
          }
          tx.execute(`INSERT INTO harness_computer_pins (pin_id, owner_id, instance_id, instance_generation, created_at, released_at)
            VALUES (?, ?, ?, ?, ?, NULL)`, [pinId, ownerId, ref.computerInstanceId, ref.instanceGeneration, inputs.now()])
          return pinFrom(tx.get('SELECT * FROM harness_computer_pins WHERE pin_id = ?', [pinId])!)
        },
        releasePinIn(tx: StorageTransaction, pinId, ownerId) {
          assertOpen(); computerIdentity(pinId); computerIdentity(ownerId)
          const row = tx.get('SELECT * FROM harness_computer_pins WHERE pin_id = ?', [pinId])
          if (!row) return
          const pin = pinFrom(row)
          if (pin.ownerId !== ownerId) throw computerError('computer-conflict')
          if (pin.releasedAt === null) tx.execute('UPDATE harness_computer_pins SET released_at = ? WHERE pin_id = ?', [inputs.now(), pinId])
        },
        getPin(pinId) {
          assertOpen(); computerIdentity(pinId)
          return track(db.read(reader => {
            const row = reader.get('SELECT * FROM harness_computer_pins WHERE pin_id = ?', [pinId])
            return row ? pinFrom(row) : undefined
          }))
        },
      }
      ctx.provide(computerServiceKey, service)
    },
  }
}

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { defineTool } from '../dist/index.js'

const toolId = 'example.lookup'
const version = '1'
const options = execute => ({
  toolId, version, execute,
  definition: { name: 'lookup', parameters: {
    type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false,
  } },
})
const request = (overrides = {}) => ({ toolId, version, operationId: 'call', arguments: { query: 'notes' }, resuming: false, ...overrides })
const context = () => ({ scopeId: 'run', ownerEpoch: 1, signal: new AbortController().signal })

test('defineTool exposes a stable schema and validates a detached argument snapshot', async () => {
  let executions = 0
  const input = options((args, { operationId }) => {
    executions++
    assert.ok(Object.isFrozen(args))
    return { query: args.query, operationId }
  })
  assert.throws(() => defineTool({ ...input, definition: { name: 'lookup', parameters: { $ref: '#/other' } } }), /unsupported tool schema keyword/)
  const provider = defineTool({ ...input, resourceId: 'notes@1' })
  assert.equal(provider.environmentId, toolId)
  assert.equal(provider.resourceId, 'notes@1')
  assert.equal(provider.recovery, undefined)
  input.definition.parameters.properties.query.type = 'boolean'
  const scope = provider.openScope(context())
  for (const rejected of [
    scope.execute(request({ arguments: { query: 3 } })),
    scope.execute(request({ version: '2' })),
    scope.execute(request({ resuming: true })),
  ]) {
    await assert.rejects(rejected.result)
    await rejected.done
  }
  const argumentsAtCall = { query: 'notes' }
  const call = scope.execute(request({ arguments: argumentsAtCall }))
  argumentsAtCall.query = 'changed'
  assert.deepEqual(await call.result, { result: { query: 'notes', operationId: 'call' } })
  await call.done
  assert.equal(executions, 1)
  assert.equal(scope.hasResources(), false)
})

test('defineTool prevents a cancelled launch and drains accepted work even after cancellation', async () => {
  let markEntered, release, runningSignal, executions = 0
  const entered = new Promise(resolve => { markEntered = resolve })
  const work = new Promise(resolve => { release = resolve })
  const scope = defineTool(options(async (_args, { signal }) => {
    executions++
    runningSignal = signal
    markEntered()
    await work
    return 'finished'
  })).openScope(context())
  const stoppedBeforeLaunch = scope.execute(request({ operationId: 'preflight' }))
  stoppedBeforeLaunch.cancel('stop this call')
  await assert.rejects(stoppedBeforeLaunch.result, { name: 'AbortError' })
  await stoppedBeforeLaunch.done
  assert.equal(executions, 0)

  const running = scope.execute(request())
  await entered
  assert.equal(scope.hasResources(), true)
  const closing = scope.close()
  assert.equal(scope.close(), closing)
  assert.equal(runningSignal.aborted, true)
  let exited = false
  void closing.done.then(() => { exited = true })
  const rejected = scope.execute(request({ operationId: 'after-close' }))
  await assert.rejects(rejected.result, { name: 'AbortError' })
  await rejected.done
  assert.equal(exited, false)
  assert.equal(scope.hasResources(), true)
  release()
  assert.deepEqual(await running.result, { result: 'finished' })
  await running.done
  await closing.done
  assert.equal(scope.hasResources(), false)
  assert.equal(executions, 1)
})

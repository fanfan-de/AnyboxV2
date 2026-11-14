import assert from 'node:assert/strict'
import test from 'node:test'
import { createToolEnvironmentCatalog, createToolEnvironmentRegistry } from '../packages/app-harness/dist/core/tool-environments/registry.js'
import { computerToolEnvironmentCatalogEntry, computerToolEnvironmentDescriptor, createComputerToolEnvironment } from '../packages/app-harness/dist/core/tool-environments/computer.js'
import { legacyToolEnvironmentSnapshot } from '../packages/app-harness/dist/core/tool-environments/history.js'
import { parseToolEnvironmentSnapshot } from '../packages/app-harness/dist/core/tool-environments/domain.js'
import { getToolById } from '../packages/app-harness/dist/core/tool/catalog.js'

const descriptor = Object.freeze({ toolId: 'fixture.echo', version: '1.0.0', definition: {
  name: 'fixture_echo', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
} })
const request = { id: 'call', name: descriptor.definition.name, arguments: { text: 'hello' } }
const context = () => ({ runId: 'run', runOwnerEpoch: 2, signal: new AbortController().signal })
const completed = result => ({ result: Promise.resolve(result), done: Promise.resolve(), cancel() {} })
const gate = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
function provider(options = {}) {
  return { environmentId: 'fixture', version: '1.0.0', tools: [descriptor], ...options,
    openScope: options.openScope ?? (() => ({ execute: () => completed({ result: 'hello' }), hasResources: () => false, cancel: async () => {}, close: () => completed({ closed: true }) })) }
}

test('environment snapshots fix exact provider definitions and reject collisions or unsupplied tools', () => {
  const original = provider(), registry = createToolEnvironmentRegistry([original])
  const snapshot = registry.snapshot(['fixture'])
  assert.equal(Object.isFrozen(snapshot.environments[0].tools[0].definition.parameters), true)
  assert.deepEqual(registry.validate(snapshot), snapshot)
  assert.throws(() => createToolEnvironmentRegistry([provider({ version: '2.0.0' })]).validate(snapshot), /unavailable/)
  assert.throws(() => createToolEnvironmentRegistry([original, provider({ environmentId: 'other' })]).snapshot(['fixture', 'other']), /tools/)
  assert.throws(() => registry.snapshot(['missing']), /unavailable/)
  assert.throws(() => registry.snapshot(['fixture'], { fixture: ['unknown.tool'] }), TypeError)
  const history = structuredClone(snapshot)
  history.environments[0].tools[0].definition.description = 'old definition'
  assert.equal(parseToolEnvironmentSnapshot(history).environments[0].tools[0].definition.description, 'old definition')
  assert.throws(() => registry.validate(history), /unavailable/)
})

test('catalog descriptors have no execution entry and only exact complete bindings can create an executor', async () => {
  let opened = 0
  const environment = provider({ openScope() { opened++; return { execute: () => completed({ result: 'bound' }), hasResources: () => false,
    cancel: async () => {}, close: () => completed(null) } } })
  const declaration = { environmentId: environment.environmentId, version: environment.version, tools: environment.tools }
  const catalog = createToolEnvironmentCatalog([{ descriptor: declaration }])
  const snapshot = catalog.snapshot(['fixture'])
  assert.deepEqual(catalog.validate(snapshot), snapshot)
  assert.equal(typeof catalog.openRun, 'undefined')
  assert.equal('openScope' in catalog.environments[0], false)
  assert.equal(opened, 0)
  assert.throws(() => catalog.bind([]), TypeError)
  assert.throws(() => catalog.bind([declaration]), /executable tool environment/)
  assert.throws(() => catalog.bind([environment, environment]), TypeError)
  assert.throws(() => catalog.bind([provider({ environmentId: 'other' })]), TypeError)
  assert.throws(() => catalog.bind([provider({ version: '2.0.0' })]), TypeError)
  assert.throws(() => catalog.bind([provider({ tools: [] })]), TypeError)
  assert.throws(() => catalog.bind([provider({ recovery: 'observe-existing' })]), TypeError)
  const changed = { ...descriptor, definition: { ...descriptor.definition, description: 'Different execution declaration' } }
  assert.throws(() => catalog.bind([provider({ tools: [changed] })]), TypeError)
  const executor = catalog.bind([environment])
  assert.equal(opened, 0, 'binding must not open a scope or execute work')
  const run = executor.openRun(snapshot, context()), call = run.execute(request, 'bound-operation')
  assert.equal(opened, 1)
  assert.equal((await call.result).result, 'bound'); await call.done
  const close = run.close(); await close.result; await close.done
})

test('an ordinary environment named computer has generic selection, history and cleanup semantics', async () => {
  const registry = createToolEnvironmentRegistry([provider({ environmentId: 'computer' })])
  const snapshot = registry.snapshot(['computer'], { computer: [descriptor.toolId] })
  assert.deepEqual(snapshot.environments[0].tools, [descriptor])
  assert.throws(() => registry.snapshot(['computer'], { computer: ['anybox.bash'] }), TypeError)
  const retired = getToolById('codex.update_plan')
  const historicTool = { toolId: retired.toolId, version: retired.version, definition: retired.definition }
  const history = { schemaVersion: 1, environments: [{ environmentId: 'computer', version: '1.0.0', tools: [historicTool] }] }
  assert.deepEqual(parseToolEnvironmentSnapshot(history), history)
  assert.throws(() => registry.validate(history), TypeError, 'a familiar environment ID must not grant retired-tool compatibility')
  const explicit = createToolEnvironmentCatalog([{ descriptor: { environmentId: 'computer', version: '1.0.0', tools: [descriptor] }, historyTools: [historicTool] }])
  assert.deepEqual(explicit.validate(history), history)
  assert.throws(() => explicit.snapshot(['computer'], { computer: [historicTool.toolId] }), TypeError, 'history-only tools cannot enter new selections')
  const run = registry.openRun(snapshot, context()), call = run.execute(request, 'ordinary-computer-operation')
  assert.equal((await call.result).result, 'hello'); await call.done
  assert.equal('hasProcesses' in run, false)
  const close = run.close()
  assert.deepEqual(await close.result, { environments: [{ environmentId: 'computer', result: { closed: true } }] })
  await close.done
})

test('Computer selection dependencies and retired tools come only from its explicit catalog entry', () => {
  const catalog = createToolEnvironmentCatalog([computerToolEnvironmentCatalogEntry])
  assert.equal('openScope' in computerToolEnvironmentDescriptor, false)
  assert.throws(() => createComputerToolEnvironment(), /execution dependencies are required/)
  assert.throws(() => catalog.snapshot(['computer'], { computer: ['codex.exec_command'] }), /dependency/)
  assert.throws(() => catalog.snapshot(['computer'], { computer: ['codex.update_plan'] }), TypeError)
  const pair = catalog.snapshot(['computer'], { computer: ['codex.exec_command', 'codex.write_stdin'] })
  assert.deepEqual(catalog.validate(pair), pair)
  const retired = getToolById('codex.update_plan')
  const history = legacyToolEnvironmentSnapshot({ schemaVersion: 2, toolSelection: { schemaVersion: 1,
    tools: [{ toolId: retired.toolId, version: retired.version, definition: retired.definition }] } })
  assert.deepEqual(catalog.validate(history), history)
  assert.throws(() => createToolEnvironmentCatalog([{ descriptor: computerToolEnvironmentDescriptor }]).validate(history), TypeError)
})

test('registration strictly validates executable descriptors while old schema history stays readable', () => {
  let opened = 0
  for (const constraint of [{ format: 'email' }, { $ref: '#/$defs/address' }, { patternProperties: { '^x': { type: 'string' } } }]) {
    const unsupported = { ...descriptor, definition: { ...descriptor.definition, parameters: {
      type: 'object', properties: { text: { type: 'string', ...constraint } }, required: ['text'], additionalProperties: false,
    } } }
    const environment = provider({ tools: [unsupported], openScope() { opened++; assert.fail('registration must not open an execution scope') } })
    assert.throws(() => createToolEnvironmentRegistry([environment]), /unsupported tool schema keyword/)
    const old = { schemaVersion: 1, environments: [{ environmentId: environment.environmentId, version: environment.version, tools: [unsupported] }] }
    assert.deepEqual(parseToolEnvironmentSnapshot(old), old)
    assert.throws(() => createToolEnvironmentRegistry([provider()]).validate(old), /unavailable/)
  }
  assert.equal(opened, 0)
})

test('scope identity stays fixed across owner epochs and setup failure cannot certify complete cleanup', async () => {
  const opened = [], exit = gate(), setupFailure = new Error('environment setup failed')
  const fixture = provider({ openScope(input) {
    opened.push({ scopeId: input.scopeId, ownerEpoch: input.ownerEpoch })
    return { execute: () => completed({ result: null }), hasResources: () => true, cancel: async () => {},
      close: () => ({ result: Promise.resolve({ partial: 'closed-known-scope' }), done: exit.promise, cancel() {} }) }
  } })
  const otherTool = { ...descriptor, toolId: 'other.echo', definition: { ...descriptor.definition, name: 'other_echo' } }
  const registry = createToolEnvironmentRegistry([fixture, provider({ environmentId: 'other', tools: [otherTool], openScope() { throw setupFailure } })])
  const snapshot = registry.snapshot(['fixture', 'other'])
  const first = registry.openRun(snapshot, context())
  assert.throws(() => first.execute(request, 'operation'), error => error === setupFailure)
  const close = first.close()
  assert.deepEqual(await close.result, { environments: [{ environmentId: 'fixture', result: { partial: 'closed-known-scope' } }] })
  let closed = false; void close.done.catch(() => { closed = true })
  await Promise.resolve(); assert.equal(closed, false)
  exit.resolve(); await assert.rejects(close.done, error => error.category === 'cleanup-failure')
  const reopened = registry.openRun(snapshot, { ...context(), runOwnerEpoch: 3, resuming: true })
  const retryClose = reopened.close(); await retryClose.result; await assert.rejects(retryClose.done)
  assert.deepEqual(opened, [{ scopeId: 'run', ownerEpoch: 2 }, { scopeId: 'run', ownerEpoch: 3 }])
})

test('custom environments execute without Computer and keep results separate from actual exit', async () => {
  const exit = gate(), received = [], scopes = []
  const environment = provider({ openScope(input) {
    scopes.push(input)
    return { execute(input) { received.push(input); return { result: Promise.resolve({ name: 'spoofed', result: { text: input.arguments.text } }), done: exit.promise, cancel() {} } },
      hasResources: () => true, cancel: async () => {}, close: () => completed({ closed: true }) }
  } })
  const registry = createToolEnvironmentRegistry([environment]), run = registry.openRun(registry.snapshot(['fixture']), context())
  assert.deepEqual(Object.keys(scopes[0]).sort(), ['ownerEpoch', 'scopeId', 'signal'])
  assert.equal(scopes[0].scopeId, 'run')
  const call = run.execute(request, 'operation')
  assert.deepEqual(await call.result, { name: 'fixture_echo', result: { text: 'hello' } })
  let exited = false; void call.done.then(() => { exited = true })
  await Promise.resolve(); assert.equal(exited, false)
  assert.equal(run.execute(request, 'operation'), call)
  assert.equal(received.length, 1)
  assert.throws(() => run.execute({ ...request, arguments: { text: 7 } }, 'invalid'), /arguments/)
  assert.equal(received.length, 1)
  exit.resolve(); await call.done
  const close = run.close(); await close.result; await close.done
})

test('cancellation waits for accepted operation exit even when an ordinary computer provider cancellation returns early', async () => {
  const exit = gate(), events = []
  const registry = createToolEnvironmentRegistry([provider({ environmentId: 'computer', openScope: () => ({
    execute: () => ({ result: Promise.resolve({ result: 'value' }), done: exit.promise, cancel: () => events.push('call-cancel') }),
    hasResources: () => true, cancel: async () => { events.push('scope-cancel') }, close: () => completed({ closed: true }),
  }) })])
  const run = registry.openRun(registry.snapshot(['computer']), context()), call = run.execute(request, 'operation')
  await call.result
  let cancelled = false
  const cancellation = run.cancel().then(() => { cancelled = true })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(cancelled, false)
  assert.deepEqual(events, ['call-cancel', 'scope-cancel'])
  exit.resolve(); await cancellation; await call.done
  const close = run.close(); await close.result; await close.done
})

test('recovery refuses providers without original-operation lookup and never invokes their execute', async () => {
  let executions = 0
  const environment = provider({ openScope: () => ({ execute() { executions++; return completed({ result: 'value' }) }, hasResources: () => false, cancel: async () => {}, close: () => completed(null) }) })
  const registry = createToolEnvironmentRegistry([environment]), run = registry.openRun(registry.snapshot(['fixture']), { ...context(), resuming: true })
  assert.throws(() => run.execute(request, 'unknown-operation', true), error => error.category === 'outcome-unknown')
  assert.equal(executions, 0)
  const close = run.close(); await close.result; await close.done
  const observed = []
  const recoverable = createToolEnvironmentRegistry([provider({ recovery: 'observe-existing', openScope: () => ({
    execute(input) { observed.push(input); return completed({ result: 'original-result' }) }, hasResources: () => false, cancel: async () => {}, close: () => completed(null),
  }) })])
  const resumed = recoverable.openRun(recoverable.snapshot(['fixture']), context())
  const original = resumed.execute(request, 'original-operation', true)
  assert.equal((await original.result).result, 'original-result'); await original.done
  assert.equal(observed[0].operationId, 'original-operation'); assert.equal(observed[0].resuming, true)
  const closed = resumed.close(); await closed.result; await closed.done
})

test('close preserves partial Computer cleanup facts while actual exit remains a separate failure', async () => {
  const descriptor = computerToolEnvironmentDescriptor.tools.find(tool => tool.toolId === 'anybox.bash')
  const exit = gate(), catalog = createToolEnvironmentCatalog([computerToolEnvironmentCatalogEntry])
  const registry = catalog.bind([{ ...computerToolEnvironmentDescriptor, recovery: 'observe-existing', openScope: () => ({
    execute: () => completed({ result: null }), hasResources: () => true, cancel: async () => {},
    close: () => ({ result: Promise.resolve({ processes: [{ sessionId: 1, exit: 'unknown' }] }), done: exit.promise.then(() => { throw new Error('actual exit unknown') }), cancel() {} }),
  }) }])
  const run = registry.openRun(catalog.snapshot(['computer'], { computer: [descriptor.toolId] }), context()), call = run.close()
  assert.deepEqual(await call.result, { environments: [{ environmentId: 'computer', result: { processes: [{ sessionId: 1, exit: 'unknown' }] } }] })
  exit.resolve(); await assert.rejects(call.done, error => error.category === 'cleanup-failure')
})

test('closing multiple environments joins every exit and preserves available cleanup facts', async () => {
  const exit = gate(), closed = [], otherTool = { ...descriptor, toolId: 'other.echo', definition: { ...descriptor.definition, name: 'other_echo' } }
  const first = provider({ openScope: () => ({ execute: () => completed({ result: null }), hasResources: () => true, cancel: async () => {},
    close() { closed.push('fixture'); return completed({ closed: true }) } }) })
  const second = provider({ environmentId: 'other', tools: [otherTool], openScope: () => ({ execute: () => completed({ result: null }), hasResources: () => true, cancel: async () => {},
    close() { closed.push('other'); return { result: Promise.resolve({ partial: 'kept' }), done: exit.promise.then(() => { throw new Error('scope remains unknown') }), cancel() {} } } }) })
  const registry = createToolEnvironmentRegistry([first, second]), run = registry.openRun(registry.snapshot(['fixture', 'other']), context())
  const close = run.close()
  assert.deepEqual(await close.result, { environments: [{ environmentId: 'fixture', result: { closed: true } }, { environmentId: 'other', result: { partial: 'kept' } }] })
  assert.deepEqual(closed, ['fixture', 'other'])
  let done = false; void close.done.catch(() => { done = true })
  await Promise.resolve(); assert.equal(done, false)
  exit.resolve(); await assert.rejects(close.done, error => error.category === 'cleanup-failure')
})

test('an immediately failed close exit retains available facts and cannot hang on a missing result', async () => {
  const otherTool = { ...descriptor, toolId: 'other.echo', definition: { ...descriptor.definition, name: 'other_echo' } }
  const registry = createToolEnvironmentRegistry([
    provider({ openScope: () => ({ execute: () => completed({ result: null }), hasResources: () => true, cancel: async () => {}, close: () => completed({ partial: 'retained' }) }) }),
    provider({ environmentId: 'other', tools: [otherTool], openScope: () => ({ execute: () => completed({ result: null }), hasResources: () => true, cancel: async () => {},
      close: () => ({ result: new Promise(() => {}), done: Promise.reject(new Error('exit failed')), cancel() {} }),
    }) }),
  ])
  const close = registry.openRun(registry.snapshot(['fixture', 'other']), context()).close()
  assert.deepEqual(await close.result, { environments: [{ environmentId: 'fixture', result: { partial: 'retained' } }] })
  await assert.rejects(close.done, error => error.category === 'cleanup-failure')
  const missing = createToolEnvironmentRegistry([provider({ openScope: () => ({ execute: () => completed({ result: null }), hasResources: () => true, cancel: async () => {},
    close: () => ({ result: new Promise(() => {}), done: Promise.reject(new Error('no exit proof')), cancel() {} }),
  }) })])
  const unknown = missing.openRun(missing.snapshot(['fixture']), context()).close()
  await assert.rejects(unknown.result, error => error.category === 'cleanup-failure')
  await assert.rejects(unknown.done, error => error.category === 'cleanup-failure')
})

test('Computer cleanup setup failure cannot certify the old scope exited', async () => {
  const catalog = createToolEnvironmentCatalog([computerToolEnvironmentCatalogEntry])
  const adapter = createComputerToolEnvironment({ records: { getRun: async () => undefined }, operations: { hasRunResources: async () => true } })
  const close = catalog.bind([adapter]).openRun(catalog.snapshot(['computer'], { computer: ['anybox.bash'] }), context()).close()
  await assert.rejects(close.result)
  await assert.rejects(close.done, error => error.category === 'cleanup-failure')
})

test('Computer adapter fixes original unit placement and retains exact legacy plan compatibility', async () => {
  const fixed = { attachmentId: 'remote-computer', unitId: 'original-unit' }, opened = [], executed = []
  const original = { id: 'bash-call', name: 'bash', arguments: { command: 'printf hello' } }
  let computerResources = false
  const records = { getRun: async () => ({ units: { computer: fixed }, modelSnapshot: { schemaVersion: 3, capabilities: { imageInput: true } } }),
    getRunOperation: async () => ({ start: { tool: original } }) }
  const operations = { hasRunResources: async () => computerResources, openRun(input) {
    opened.push(input); computerResources = true
    return { execute(id) { executed.push(id); return completed({ name: 'bash', result: { stdout: 'hello' } }) }, hasProcesses: () => true, cancel: async () => {}, close: () => completed({ processes: [] }) }
  } }
  const catalog = createToolEnvironmentCatalog([computerToolEnvironmentCatalogEntry]), adapter = createComputerToolEnvironment({ records, operations })
  const run = catalog.bind([adapter]).openRun(catalog.snapshot(['computer'], { computer: ['anybox.bash'] }), context())
  const call = run.execute(original, 'original-operation', true)
  assert.deepEqual(await call.result, { name: 'bash', result: { stdout: 'hello' } }); await call.done
  assert.equal(opened[0].unit, fixed); assert.equal(opened[0].imageInput, true); assert.equal(opened[0].runOwnerEpoch, 2)
  assert.deepEqual(executed, ['original-operation'])
  assert.equal('hasProcesses' in run, false)
  const close = run.close(); assert.deepEqual(await close.result, { environments: [{ environmentId: 'computer', result: { processes: [] } }] }); await close.done

  const retired = getToolById('codex.update_plan'), plan = { id: 'plan', name: retired.definition.name, arguments: { plan: [{ step: 'read', status: 'completed' }] } }
  const history = legacyToolEnvironmentSnapshot({ schemaVersion: 2, toolSelection: { schemaVersion: 1, tools: [{ toolId: retired.toolId, version: retired.version, definition: retired.definition }] } })
  const planAdapter = createComputerToolEnvironment({ records: { getRunOperation: async () => ({ start: { tool: plan } }) }, operations: { hasRunResources: async () => false, openRun() { assert.fail('legacy plan must not activate Computer') } } })
  const historical = catalog.bind([planAdapter]).openRun(history, context()), planned = historical.execute(plan, 'old-plan', true)
  assert.deepEqual((await planned.result).result, { status: 'updated', plan: [{ step: 'read', status: 'completed' }] }); await planned.done
  const closed = historical.close(); await closed.result; await closed.done
})

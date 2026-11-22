import assert from 'node:assert/strict'
import test from 'node:test'
import { checkedTargetToolPreferences, createFunctionBindings, resolveRunAccess, targetKey } from '../dist/bindings.js'
import { createToolEnvironmentCatalog, createToolRegistry, parseToolEnvironmentSnapshot } from '../dist/catalog.js'
import { managedModelTools } from '../dist/run-policy.js'

const manifest = { environmentId: 'targeted', version: '1', tools: [] }
const makeTarget = (selectionId, epoch = 1) => ({
  selectionId,
  targetId: `${selectionId}@${epoch}`,
  tools: [{ toolId: `${selectionId}.search`, version: '1', definition: {
    name: `${selectionId}_search`, parameters: { type: 'object', additionalProperties: false },
  } }],
})
const first = makeTarget('first'), second = makeTarget('second')
const prefs = Object.fromEntries([first, second].map(target =>
  [targetKey(manifest.environmentId, target.selectionId), target.tools.map(tool => tool.toolId)]))

test('tool registrations share a catalog and exact target bindings without acquiring runtime dependencies for descriptions', async () => {
  const local = { environmentId: 'local', version: '1', tools: [],
    openScope() { assert.fail('an unselected provider must not open a scope') } }
  const reader = { transaction: true }
  const selected = { ...first, name: 'First connection' }
  const catalogReads = [], scopes = []
  const directory = currentReader => {
    catalogReads.push(currentReader)
    return [selected]
  }
  const provider = {
    ...manifest, targets: directory,
    openTargetScope(targetId) {
      scopes.push(targetId)
      return {
        execute: () => ({ result: Promise.resolve({ result: targetId }), done: Promise.resolve(), cancel() {} }),
        hasResources: () => false,
        async cancel() {},
        close: () => ({ result: Promise.resolve(null), done: Promise.resolve(), cancel() {} }),
      }
    },
  }
  const registry = createToolRegistry('generation', tools => {
    tools.register(local)
    tools.register({
      kind: 'targeted', catalog: { descriptor: manifest }, inject: ['directory'],
      targets: (deps, currentReader) => deps.directory(currentReader),
      runtime: { inject: ['provider', 'directory'], bind: deps => deps.provider },
    })
  })
  assert.deepEqual(registry.inject, ['directory'])
  assert.deepEqual(registry.runtime.inject, ['provider', 'directory'])
  assert.deepEqual([...registry.trustedConfigurationEnvironmentIds], ['local'])
  const { catalog, bindings } = registry.describe({ directory })
  assert.equal(catalog.isTargeted(manifest.environmentId), true)
  assert.equal(catalog.isTargeted(local.environmentId), false)
  const snapshot = catalog.snapshot([manifest.environmentId], undefined, prefs, reader)
  const name = first.tools[0].definition.name
  assert.deepEqual(bindings.routes(snapshot.environments, [name], undefined, reader).map(route => route.tool.targetId), [first.targetId])
  assert.equal(catalog.targets(manifest.environmentId, reader)[0].name, 'First connection')
  assert.deepEqual(catalogReads, [reader, reader, reader])
  assert.deepEqual(scopes, [])
  const run = registry.runtime.bind({ directory, provider }).openRun(snapshot,
    { runId: 'run', runOwnerEpoch: 1, signal: new AbortController().signal, lazyScopes: true })
  const target = { environmentId: manifest.environmentId, targetId: first.targetId }
  assert.equal(run.openTarget(target), true)
  const operation = run.execute({ id: 'operation', name, arguments: {} }, 'operation', false, target)
  assert.equal((await operation.result).result, first.targetId)
  await operation.done
  await run.close().done
  assert.deepEqual(scopes, [first.targetId])
})

test('tool registrars reject duplicate identities and close when composition finishes', () => {
  const provider = { environmentId: 'local', version: '1', tools: [], openScope() {} }
  assert.throws(() => createToolRegistry('generation', tools => {
    tools.register(provider)
    tools.register(provider)
  }), /duplicate tool environment/)
  let retained
  createToolRegistry('generation', tools => { retained = tools })
  assert.throws(() => retained.register(provider), /configuration is closed/)
  assert.throws(() => createToolRegistry('generation', async tools => {
    await Promise.resolve()
    tools.register(provider)
  }), /registration must be synchronous/)
})

test('targeted selections and scopes route identical capabilities to exact targets', async () => {
  const observed = []
  const provider = {
    ...manifest,
    targets: () => [first, second],
    openTargetScope(targetId, { scopeId }) {
      return {
        execute(request) {
          observed.push([scopeId, targetId, request.toolId, request.operationId])
          return { result: Promise.resolve({ result: targetId }), done: Promise.resolve(), cancel() {} }
        },
        hasResources: () => false,
        async cancel() {},
        close: () => ({ result: Promise.resolve({ closed: true }), done: Promise.resolve(), cancel() {} }),
      }
    },
  }
  const catalog = createToolEnvironmentCatalog([{ descriptor: manifest, targets: provider.targets }])
  assert.deepEqual(checkedTargetToolPreferences(prefs, catalog), prefs)
  assert.throws(() => checkedTargetToolPreferences({ [targetKey(manifest.environmentId, first.selectionId)]: [second.tools[0].toolId] }, catalog))
  assert.deepEqual(catalog.snapshot([manifest.environmentId]).environments[0].tools, [])

  const snapshot = catalog.snapshot([manifest.environmentId], undefined, prefs)
  assert.equal(snapshot.schemaVersion, 2)
  assert.deepEqual(parseToolEnvironmentSnapshot(JSON.parse(JSON.stringify(snapshot))), snapshot)
  assert.throws(() => parseToolEnvironmentSnapshot({ ...snapshot, schemaVersion: 1 }))
  const registry = catalog.bind([], [provider])
  const run = registry.openRun(snapshot, { runId: 'run', runOwnerEpoch: 1, signal: new AbortController().signal })
  for (const target of [first, second]) {
    const { toolId, definition } = target.tools[0]
    const operationId = `op-${toolId}`
    const result = run.execute({ id: operationId, name: definition.name, arguments: {} }, operationId)
    assert.equal((await result.result).result, target.targetId)
    await result.done
  }
  assert.deepEqual(observed, [first, second].map(target => ['run', target.targetId, target.tools[0].toolId, `op-${target.tools[0].toolId}`]))
  const closure = run.close()
  assert.deepEqual((await closure.result).environments.map(scope => scope.targetId), [first.targetId, second.targetId])
  await closure.done
})

test('target generations are pinned in Run access and fresh snapshots ignore removed selections', () => {
  let targets = [first, second]
  const catalog = createToolEnvironmentCatalog([{ descriptor: manifest, targets: () => targets }])
  const bindings = createFunctionBindings(catalog.environments, 'generation', catalog.targets)
  const snapshot = catalog.snapshot([manifest.environmentId], undefined, prefs)
  const names = snapshot.environments[0].tools.map(tool => tool.definition.name)
  const grants = { agentId: 'agent', revision: 1, grants: [{ tool: bindings.available()[0], generation: 1 }] }
  const access = resolveRunAccess(grants, bindings.routes(snapshot.environments, names))
  assert.deepEqual(access.functions.map(route => route.name), [first.tools[0].definition.name])
  bindings.assertCurrentTargetedAccess(snapshot.environments, access)

  const updated = makeTarget('first', 2)
  targets = [updated]
  assert.throws(() => catalog.validate(snapshot), /snapshot unavailable/)
  assert.throws(() => bindings.assertCurrentTargetedAccess(snapshot.environments, access), /environment-target-unavailable/)
  const fresh = catalog.snapshot([manifest.environmentId], undefined, prefs)
  assert.deepEqual(fresh.environments[0].tools.map(tool => tool.targetId), [updated.targetId])
  assert.deepEqual(resolveRunAccess(grants, bindings.routes(fresh.environments, [names[0]])).functions, [])
})

test('context-bound tool targets come from the app and only requested routes require validation', () => {
  const descriptor = { environmentId: 'workspace', version: '1', tools: [first.tools[0], second.tools[0]] }
  const catalog = createToolEnvironmentCatalog([{ descriptor }])
  const bindings = createFunctionBindings(catalog.environments, 'generation', catalog.targets, [descriptor.environmentId])
  const inventory = new Map([[descriptor.environmentId, [
    { targetId: 'one', allowedToolIds: [first.tools[0].toolId] },
    { targetId: 'two', allowedToolIds: [second.tools[0].toolId] },
  ]]])
  assert.deepEqual(bindings.available(), [])
  assert.deepEqual(bindings.available(inventory).map(tool => [tool.targetId, tool.toolId]),
    [['one', first.tools[0].toolId], ['two', second.tools[0].toolId]])

  const name = first.tools[0].definition.name
  const retained = catalog.snapshot([descriptor.environmentId]).environments
  const stale = { environmentId: 'disconnected', version: '1', tools: [second.tools[0]] }
  assert.throws(() => bindings.routes(retained, [name]), /environment-target-unavailable/)
  const [route] = bindings.routes([...retained, stale], [name], new Map([[descriptor.environmentId, 'one']]))
  assert.deepEqual(route.tool, bindings.available(inventory)[0])
})

test('failed pre-send validation retires the model admission without entering the transport', async () => {
  const checkError = new Error('target changed')
  let entered = false
  const manager = { async runModel(_agent, _grants, _operation, start, signal) {
    const work = start(signal)
    await work.done
    return work.result
  } }
  const policy = managedModelTools(manager, 'run', { agentId: 'agent', functions: [] }, { tools: [] }, () => { throw checkError })
  await assert.rejects(policy.runSend('exchange', () => { entered = true }, new AbortController().signal), error => error === checkError)
  assert.equal(entered, false)
})

test('mixed v2 recovery closes intact scopes without claiming an unavailable target exited', async () => {
  let targets = [first, second]
  const closed = []
  const cleanupScope = id => ({
    execute: () => assert.fail('uncertain Run must not execute'), hasResources: () => true, async cancel() {},
    close() {
      closed.push(id)
      return { result: Promise.resolve({ closed: true }), done: Promise.resolve(), cancel() {} }
    },
  })
  const legacy = { environmentId: 'legacy', version: '1', tools: [], openScope: () => cleanupScope('legacy') }
  const targeted = { ...manifest, targets: () => targets, openTargetScope: cleanupScope }
  const catalog = createToolEnvironmentCatalog([{ descriptor: legacy }, { descriptor: manifest, targets: targeted.targets }])
  const snapshot = catalog.snapshot(['legacy', manifest.environmentId], undefined, prefs)
  const registry = catalog.bind([legacy], [targeted])
  targets = [second]
  const context = { runId: 'run', runOwnerEpoch: 2, signal: new AbortController().signal }
  assert.throws(() => registry.openRun(snapshot, context), /snapshot unavailable/)
  const run = registry.openRun(snapshot, { ...context, resuming: true })
  assert.throws(() => run.execute({ id: 'call', name: second.tools[0].definition.name, arguments: {} }, 'op'), /environment unavailable/)
  const cleanup = run.close()
  assert.deepEqual(await cleanup.result, { environments: [
    { environmentId: 'legacy', result: { closed: true } },
    { environmentId: manifest.environmentId, targetId: second.targetId, result: { closed: true } },
  ] })
  await assert.rejects(cleanup.done, /cleanup-failure/)
  assert.deepEqual(closed, ['legacy', second.targetId])
})

test('lazy scoped targets report their own call exit and never open declared but unused targets', async () => {
  const unused = makeTarget('unused')
  const targets = [first, second, unused]
  const opened = [], exited = []
  const provider = {
    ...manifest,
    targets: () => targets,
    openTargetScope(id) {
      opened.push(id)
      return {
        execute() {
          return { result: Promise.resolve({ result: id }), done: id === first.targetId
            ? Promise.reject(new Error('exit unknown')) : Promise.resolve(), cancel() {} }
        },
        hasResources: () => true,
        async cancel() {},
        close: () => ({ result: Promise.resolve({ closed: true }), done: Promise.resolve(), cancel() {} }),
      }
    },
  }
  const catalog = createToolEnvironmentCatalog([{ descriptor: manifest, targets: provider.targets }])
  const snapshot = catalog.snapshot([manifest.environmentId], undefined, Object.fromEntries(targets.map(target =>
    [targetKey(manifest.environmentId, target.selectionId), target.tools.map(tool => tool.toolId)])))
  const run = catalog.bind([], [provider]).openRun(snapshot, {
    runId: 'mixed', runOwnerEpoch: 1, signal: new AbortController().signal, lazyScopes: true,
  })
  assert.deepEqual(opened, [])
  const identity = target => ({ environmentId: manifest.environmentId, targetId: target.targetId })
  const request = target => ({ id: target.targetId, name: target.tools[0].definition.name, arguments: {} })
  const failed = run.execute(request(first), 'first', false, identity(first))
  await assert.rejects(failed.done, /exit unknown/)
  await run.execute(request(second), 'second', false, identity(second)).done
  const cleanup = run.close((target, proven) => { exited.push([target.targetId, proven]) })
  assert.deepEqual((await cleanup.result).environments.map(scope => scope.targetId), [first.targetId, second.targetId])
  await assert.rejects(cleanup.done, /cleanup-failure/)
  assert.deepEqual(opened, [first.targetId, second.targetId])
  assert.deepEqual(exited.sort(), [[first.targetId, false], [second.targetId, true]])
})

test('scope restoration can close an original target after discovery changed without replaying a tool', async () => {
  let targets = [first, second]
  const restored = [], exits = []
  const provider = {
    ...manifest,
    targets: () => targets,
    openTargetScope: () => assert.fail('must not create replacement work'),
    restoreTargetScope(id) {
      restored.push(id)
      return {
        execute: () => assert.fail('must not replay a tool'),
        hasResources: () => true,
        async cancel() {},
        close: () => ({ result: Promise.resolve({ closed: true }), done: Promise.resolve(), cancel() {} }),
      }
    },
  }
  const catalog = createToolEnvironmentCatalog([{ descriptor: manifest, targets: provider.targets }])
  const snapshot = catalog.snapshot([manifest.environmentId], undefined, prefs)
  targets = [makeTarget('first', 2)]
  const run = catalog.bind([], [provider]).openRun(snapshot, {
    runId: 'restored', runOwnerEpoch: 2, signal: new AbortController().signal, resuming: true, lazyScopes: true,
  })
  const target = { environmentId: manifest.environmentId, targetId: first.targetId }
  assert.equal(run.openTarget(target), false, 'changed discovery is rejected before opening a provider')
  assert.throws(() => run.restoreTarget({ ...target, targetId: targets[0].targetId }), /unavailable/)
  run.restoreTarget(target)
  assert.throws(() => run.execute({ id: 'call', name: first.tools[0].definition.name, arguments: {} }, 'original', true, target), /outcome-unknown/)
  await run.close((identity, proven) => { exits.push([identity, proven]) }).done
  assert.deepEqual(restored, [first.targetId])
  assert.deepEqual(exits, [[target, true]])
})

test('a contextual provider dispatches and restores the same tool ID in distinct pinned scopes', async () => {
  const source = { toolId: 'shell.read', version: '1', definition: { name: 'read', parameters: { type: 'object', additionalProperties: false } } }
  const descriptor = { environmentId: 'shell', version: '1', recovery: 'observe-existing', tools: [source] }
  const ids = ['work-a', 'work-b'], targets = ['grant-a', 'grant-b'], names = ['main__read', 'workspace2__read']
  const opened = []
  function scope(kind, target) {
    opened.push([kind, target])
    return {
      execute(request) {
        assert.equal(request.toolId, source.toolId)
        return { result: Promise.resolve({ result: target }), done: Promise.resolve(), cancel() {} }
      },
      hasResources: () => true,
      async cancel() {},
      close: () => ({ result: Promise.resolve({ target }), done: Promise.resolve(), cancel() {} }),
    }
  }
  const provider = { ...descriptor, openScope() { assert.fail('an aliased call must resolve its exact workspace') },
    openBoundScope: target => scope('open', target), restoreBoundScope: target => scope('restore', target) }
  const registry = createToolRegistry('boot', tools => tools.register({ kind: 'static', contextualTarget: true,
    catalog: { descriptor }, runtime: { bind: () => provider } }))
  const aliases = names.map((name, index) => ({ ...source, originalName: source.definition.name,
    targetId: targets[index], workspaceBindingId: ids[index], definition: { ...source.definition, name } }))
  const snapshot = { schemaVersion: 3, environments: [{ environmentId: 'shell', version: '1', tools: aliases }] }
  const { catalog, bindings } = registry.describe({})
  assert.deepEqual(catalog.validate(snapshot), snapshot)
  assert.throws(() => parseToolEnvironmentSnapshot({ ...snapshot, schemaVersion: 2 }))
  const pinned = new Map(ids.map((id, index) => [targetKey('shell', id), targets[index]]))
  const routes = bindings.routes(snapshot.environments, names, pinned)
  const offered = bindings.available(new Map([['shell', targets.map(targetId => ({ targetId }))]]))
  assert.deepEqual(routes.map(route => route.tool), offered, 'grant digests use the unaliased contract')
  const swapped = new Map(pinned).set(targetKey('shell', ids[0]), targets[1])
  assert.throws(() => bindings.routes(snapshot.environments, names, swapped), { code: 'environment-target-unavailable' })
  const duplicate = structuredClone(snapshot)
  duplicate.environments[0].tools[1].definition.name = names[0]
  assert.throws(() => catalog.validate(duplicate))
  const altered = structuredClone(snapshot)
  altered.environments[0].tools[0].originalName = 'write'
  assert.throws(() => catalog.validate(altered))
  const bound = registry.runtime.bind({})
  for (const resuming of [false, true]) {
    const run = bound.openRun(snapshot, { runId: 'r', runOwnerEpoch: resuming ? 2 : 1, lazyScopes: true,
      signal: new AbortController().signal, resuming })
    for (const [index, route] of routes.entries()) {
      if (resuming) {
        assert.throws(() => run.execute({ name: route.name, arguments: {} }, 'op-' + index, true, route.tool),
          { category: 'outcome-unknown' })
        run.restoreTarget(route.tool)
      }
      assert.throws(() => run.execute({ name: names[1-index], arguments: {} }, 'wrong-target', resuming, route.tool))
      const call = run.execute({ name: route.name, arguments: {} }, 'op-' + index, resuming, route.tool)
      assert.deepEqual(await call.result, { name: route.name, result: targets[index] })
      await call.done
    }
    const exits = []
    const closed = run.close((target, proven) => exits.push([target.targetId, proven]))
    assert.deepEqual((await closed.result).environments.map(entry => entry.targetId), targets)
    await closed.done
    assert.deepEqual(exits, targets.map(target => [target, true]))
  }
  assert.deepEqual(opened, [['open', targets[0]], ['open', targets[1]], ['restore', targets[0]], ['restore', targets[1]]])
})

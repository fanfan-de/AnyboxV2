import { randomUUID } from 'node:crypto'
import type { Component } from '@nya/core'
import { localStorageServiceKey } from '@anybox/storage-sqlite/port'
import type { LocalStoragePort, StorageReader } from '@anybox/storage-sqlite/port'
import { validateToolArguments } from '@anybox/tool-api'
import type { JsonValue, ToolCall, ToolDescriptor, ToolEnvironmentDescriptor, ToolEnvironmentRequest, ToolEnvironmentResult, ToolEnvironmentScope,
  ToolEnvironmentScopeContext } from '@anybox/tool-api'
import { processRuntimeAvailable } from '@anybox/computer-tools/platform/process-runtime'
import { connectionInput, mcpEnvironmentId, mcpEnvironmentVersion, mcpError, normalizeResult, normalizeTools, resourceKey, targetId } from './contracts.js'
import type { McpConnectionView, McpStdioConnection, McpTool } from './contracts.js'
import { createMcpHttpClient } from './http.js'
import { createMcpStdioClient } from './stdio.js'
import type { McpClient } from './protocol.js'
import { connectionFromRow, migrations, unknownKey, unknownOperations } from './storage.js'
import type { McpConnection } from './storage.js'

export { mcpEnvironmentId, mcpEnvironmentVersion }
export type { McpConnectionInput, McpConnectionStatus, McpConnectionView } from './contracts.js'

export interface McpEnvironmentPort {
  readonly environmentId: typeof mcpEnvironmentId
  readonly version: typeof mcpEnvironmentVersion
  targets(reader?: StorageReader): readonly { readonly targetId: string; readonly selectionId: string; readonly name: string; readonly tools: readonly ToolDescriptor[] }[]
  openTargetScope(targetId: string, context: ToolEnvironmentScopeContext): ToolEnvironmentScope
  stdioSupported(): boolean
  connections(): readonly McpConnectionView[]
  createConnection(input: unknown): Promise<McpConnectionView>
  refreshConnection(id: string): Promise<McpConnectionView>
  disableConnection(id: string): Promise<McpConnectionView>
}

const mcpToolEnvironmentDescriptor: ToolEnvironmentDescriptor = Object.freeze({
  environmentId: mcpEnvironmentId, version: mcpEnvironmentVersion, tools: Object.freeze([]),
})

export function createMcpToolRegistration(serviceKey: string) {
  const provider = (deps: Readonly<Record<string, unknown>>) => deps[serviceKey] as McpEnvironmentPort
  return {
    kind: 'targeted',
    catalog: { descriptor: mcpToolEnvironmentDescriptor },
    inject: [serviceKey],
    targets: (deps: Readonly<Record<string, unknown>>, reader?: StorageReader) => provider(deps).targets(reader),
    runtime: { bind: provider },
  } as const
}

export interface McpEnvironmentOptions {
  readonly serviceKey: string
  readonly timeoutMs?: number
  readonly fetch?: typeof fetch
}

interface ActiveCall {
  readonly connectionId: string
  readonly toolId: string
  readonly version: string
  readonly controller: AbortController
  readonly done: Promise<void>
}

interface RemoteSession {
  readonly connectionId: string
  readonly client: McpClient
  readonly calls: Set<ActiveCall>
  retired: boolean
  closing?: Promise<void>
}

interface LocalSession {
  readonly launchId: string
  readonly connectionId: string
  readonly resourceKey: string
  readonly client: McpClient
  closing?: Promise<void>
}

const owners = new WeakSet<LocalStoragePort>()

function codeOf(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'mcp-timeout'
  return error instanceof Error && error.name === 'McpEnvironmentError' && 'code' in error && typeof error.code === 'string' ? error.code : 'mcp-unavailable'
}

function cancellation() { return mcpError('mcp-cancelled', 409, 'cancelled') }
function unknownExit() { return mcpError('mcp-exit-unknown', 503, 'cleanup-failure') }

function joinCalls(calls: Iterable<ActiveCall>): Promise<void> {
  return Promise.allSettled([...calls].map(call => call.done)).then(exits => {
    if (exits.some(exit => exit.status === 'rejected')) throw unknownExit()
  })
}

async function openMcpEnvironment(db: LocalStoragePort, options: McpEnvironmentOptions): Promise<McpEnvironmentPort & { close(): Promise<void> }> {
  const timeout = options.timeoutMs ?? 30_000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) throw new TypeError('invalid MCP timeout')
  const fetchRequest = options.fetch ?? globalThis.fetch
  const stdioAvailable = processRuntimeAvailable()
  if (owners.has(db)) throw mcpError('mcp-storage-owned', 409)
  owners.add(db)
  const { records, uncertain, uncertainProcesses } = await (async () => {
    await db.migrate('mcp-environment', migrations)
    return db.transaction(tx => {
      tx.execute("UPDATE mcp_operations SET state='unknown' WHERE state='sent'")
      tx.execute("UPDATE mcp_stdio_processes SET state='unknown' WHERE state='owned'")
      return { records: tx.all('SELECT * FROM mcp_connections ORDER BY rowid').map(connectionFromRow), uncertain: unknownOperations(tx),
        uncertainProcesses: new Set(tx.all("SELECT DISTINCT resource_key FROM mcp_stdio_processes WHERE state='unknown'").map(row => String(row.resource_key))) }
    })
  })().catch(error => { owners.delete(db); throw error })
  const connections = new Map(records.map(row => [row.id, row]))
  const live = new Map<string, RemoteSession>()
  const remotes = new Set<RemoteSession>()
  const localReady = new Set<string>()
  const locals = new Set<LocalSession>()
  const calls = new Set<ActiveCall>()
  const controls = new Set<Promise<unknown>>()
  const refreshes = new Map<string, { controller: AbortController; done: Promise<McpConnectionView> }>()
  const writes = new Set<string>()
  const closingSignal = new AbortController()
  let closing: Promise<void> | undefined

  const requireOpen = () => { if (closingSignal.signal.aborted) throw mcpError('mcp-unavailable', 503) }
  const get = (id: string) => {
    const connection = connections.get(id)
    if (!connection) throw mcpError('mcp-connection-not-found', 404)
    return connection
  }
  const ready = (connection: McpConnection) => connection.transport === 'http' ? live.has(connection.id) : localReady.has(connection.id)
  const project = (connection: McpConnection): McpConnectionView => {
    const processUnknown = uncertainProcesses.has(connection.resourceKey)
    const toolCount = processUnknown ? 0 : connection.tools.filter(tool => !uncertain.has(unknownKey(connection.resourceKey, tool.nativeName))).length
    const error = processUnknown || toolCount < connection.tools.length ? 'mcp-exit-unknown' : connection.error
    const config = connection.transport === 'http' ? { transport: connection.transport, endpoint: connection.endpoint } :
      { transport: connection.transport, command: connection.command, args: connection.args, cwd: connection.cwd }
    const status = processUnknown && connection.status !== 'disabled' ? 'unavailable' :
      connection.status === 'ready' && !ready(connection) ? 'unverified' : connection.status
    return Object.freeze({ ...config, id: connection.id, targetId: targetId(connection.id), name: connection.name, status,
      toolCount, ...(error ? { error } : {}) })
  }
  const track = <T>(work: () => Promise<T>) => {
    requireOpen()
    const task = Promise.resolve().then(work)
    controls.add(task)
    void task.finally(() => controls.delete(task)).catch(() => {})
    return task
  }
  const forgetLocal = async (launchId: string) => {
    await db.transaction(tx => {
      const { changes } = tx.execute("DELETE FROM mcp_stdio_processes WHERE launch_id=? AND state='owned'", [launchId])
      if (!changes) throw unknownExit()
    })
  }
  const markLocalUnknown = async (launchId: string, key: string) => {
    uncertainProcesses.add(key)
    try { await db.transaction(tx => tx.execute("UPDATE mcp_stdio_processes SET state='unknown' WHERE launch_id=?", [launchId])) }
    catch { /* The durable owned row still blocks restart without exit evidence. */ }
    throw unknownExit()
  }
  const startLocal = async (connection: McpStdioConnection & { id: string; resourceKey: string }, check: () => void) => {
    const launchId = randomUUID(), key = connection.resourceKey
    await db.transaction(tx => {
      check()
      if (uncertainProcesses.has(key) || tx.get("SELECT 1 FROM mcp_stdio_processes WHERE resource_key=? AND state='unknown'", [key])) throw unknownExit()
      tx.execute("INSERT INTO mcp_stdio_processes VALUES (?,?,'owned')", [launchId, key])
    })
    try {
      check()
      if (uncertainProcesses.has(key)) throw unknownExit()
      const local: LocalSession = { launchId, connectionId: connection.id, resourceKey: key, client: createMcpStdioClient(connection, timeout) }
      locals.add(local)
      return local
    } catch (error) {
      await forgetLocal(launchId).catch(() => markLocalUnknown(launchId, key))
      throw error
    }
  }
  const stopLocal = (local: LocalSession) => local.closing ??= (async () => {
    await local.client.close()
    await forgetLocal(local.launchId)
    locals.delete(local)
  })().catch(() => markLocalUnknown(local.launchId, local.resourceKey))
  const discoverTools = async (connection: McpConnection, client: McpClient, signal: AbortSignal) => {
    const tools = normalizeTools(connection, await client.discover(signal))
    if (Buffer.byteLength(JSON.stringify(tools), 'utf8') > 1_048_576) throw mcpError('mcp-catalog-too-large', 502)
    return tools
  }
  const retire = (remote: RemoteSession) => {
    remote.retired = true
    if (!remote.calls.size) {
      remote.closing ??= remote.client.close().finally(() => remotes.delete(remote))
      return remote.closing
    }
  }
  const drop = (id: string) => {
    localReady.delete(id)
    const remote = live.get(id)
    live.delete(id)
    if (remote) return retire(remote)
  }
  const cancelCalls = (id: string, keep: (call: ActiveCall) => boolean = () => false) => {
    const affected = [...calls].filter(call => call.connectionId === id && !keep(call))
    for (const call of affected) call.controller.abort(cancellation())
    return affected
  }

  const targets: McpEnvironmentPort['targets'] = reader => {
    if (closingSignal.signal.aborted) return []
    const eligible = reader ? new Map(reader.all("SELECT id,revision FROM mcp_connections WHERE status='ready'")
      .map(row => [String(row.id), Number(row.revision)])) : undefined
    const storedUnknown = reader && unknownOperations(reader)
    return [...connections.values()].flatMap(connection => {
      if (connection.status !== 'ready' || writes.has(connection.id) || !ready(connection) || uncertainProcesses.has(connection.resourceKey) ||
        eligible && eligible.get(connection.id) !== connection.revision) return []
      const tools = connection.tools.flatMap(({ nativeName, ...descriptor }) => {
        const key = unknownKey(connection.resourceKey, nativeName)
        return uncertain.has(key) || storedUnknown?.has(key) ? [] : [Object.freeze(descriptor)]
      })
      return [Object.freeze({ targetId: targetId(connection.id), selectionId: connection.id, name: connection.name, tools: Object.freeze(tools) })]
    })
  }

  const createConnection: McpEnvironmentPort['createConnection'] = input => track(async () => {
    const details = connectionInput(input)
    if (details.transport === 'stdio' && !stdioAvailable) throw mcpError('mcp-stdio-unavailable', 503)
    const id = randomUUID(), key = resourceKey(details)
    const stdio = details.transport === 'stdio' ? JSON.stringify({ command: details.command, args: details.args, cwd: details.cwd }) : null
    await db.transaction(tx => {
      requireOpen()
      if (tx.get("SELECT 1 FROM mcp_connections WHERE endpoint=? AND status<>'disabled'", [key])) {
        throw mcpError(details.transport === 'http' ? 'mcp-endpoint-already-connected' : 'mcp-stdio-already-connected', 409)
      }
      if (Number(tx.get("SELECT COUNT(*) AS count FROM mcp_connections WHERE status<>'disabled'")?.count) >= 32) {
        throw mcpError('mcp-connection-limit', 409)
      }
      tx.execute("INSERT INTO mcp_connections(id,name,endpoint,revision,status,tools_json,error,stdio_json) VALUES (?,?,?,0,'unverified','[]',NULL,?)",
        [id, details.name, key, stdio])
    })
    const connection: McpConnection = Object.freeze({ ...details, id, resourceKey: key, revision: 0, status: 'unverified', tools: Object.freeze([]) })
    connections.set(id, connection)
    return project(connection)
  })

  const refreshConnection: McpEnvironmentPort['refreshConnection'] = async id => {
    requireOpen()
    const previous = get(id)
    if (previous.status === 'disabled' || writes.has(id) || refreshes.has(id)) throw mcpError('mcp-connection-unavailable', 409)
    const controller = new AbortController()
    const done = track(async () => {
      const current = live.get(id)
      const client = previous.transport === 'http' ? current?.client ?? createMcpHttpClient(previous.endpoint, fetchRequest, timeout) : undefined
      let installed = current !== undefined
      try {
        const signal = AbortSignal.any([closingSignal.signal, controller.signal])
        const check = () => {
          signal.throwIfAborted()
          if (writes.has(id) || get(id).revision !== previous.revision) throw mcpError('mcp-connection-unavailable', 409)
        }
        let tools: readonly McpTool[]
        let error: string | undefined
        try {
          if (previous.transport === 'stdio') {
            if (!stdioAvailable) throw mcpError('mcp-stdio-unavailable', 503)
            const local = await startLocal(previous, check)
            try { tools = await discoverTools(previous, local.client, signal) }
            finally { await stopLocal(local) }
          } else tools = await discoverTools(previous, client!, signal)
        } catch (cause) {
          signal.throwIfAborted()
          tools = previous.tools
          error = codeOf(cause)
        }
        check()
        writes.add(id)
        try {
          const updated: McpConnection = Object.freeze({ ...previous, revision: previous.revision + 1,
            status: error ? 'unavailable' : 'ready', tools, error })
          await db.transaction(tx => {
            signal.throwIfAborted()
            const { changes } = tx.execute(`UPDATE mcp_connections SET revision=?,status=?,tools_json=?,error=?
              WHERE id=? AND revision=? AND status<>'disabled'`,
            [updated.revision, updated.status, JSON.stringify(tools), error ?? null, id, previous.revision])
            if (!changes) throw mcpError('mcp-connection-conflict', 409)
          })
          connections.set(id, updated)
          if (error) drop(id)
          else if (previous.transport === 'stdio') localReady.add(id)
          else if (client && !current) {
            const remote: RemoteSession = { connectionId: id, client, calls: new Set(), retired: false }
            remotes.add(remote)
            live.set(id, remote)
            installed = true
          }
          const versions = new Map(tools.map(tool => [tool.toolId, tool.version]))
          cancelCalls(id, call => error === undefined && versions.get(call.toolId) === call.version)
          return project(updated)
        } catch (cause) {
          // An observed catalog change cannot leave the previous declarations live after a failed commit.
          drop(id)
          cancelCalls(id)
          throw cause
        } finally { writes.delete(id) }
      } finally { if (client && !installed) await client.close() }
    })
    refreshes.set(id, { controller, done })
    try { return await done } finally { refreshes.delete(id) }
  }

  const disableConnection: McpEnvironmentPort['disableConnection'] = async id => {
    requireOpen()
    const connection = get(id)
    if (writes.has(id)) throw mcpError('mcp-connection-conflict', 409)
    if (connection.status === 'disabled') {
      await Promise.all([...locals].filter(local => local.connectionId === id).map(stopLocal))
      return project(connection)
    }
    writes.add(id)
    const refresh = refreshes.get(id)
    refresh?.controller.abort(cancellation())
    try {
      return await track(async () => {
        const disabled: McpConnection = Object.freeze({ ...connection, revision: connection.revision + 1, status: 'disabled', error: undefined })
        await db.transaction(tx => {
          const { changes } = tx.execute("UPDATE mcp_connections SET revision=?,status='disabled',error=NULL WHERE id=? AND revision=?",
            [disabled.revision, id, connection.revision])
          if (!changes) throw mcpError('mcp-connection-conflict', 409)
        })
        connections.set(id, disabled)
        const exits = cancelCalls(id)
        const idle = drop(id)
        const localExits = [...locals].filter(local => local.connectionId === id).map(stopLocal)
        await Promise.allSettled([...exits.map(call => call.done), ...(refresh ? [refresh.done] : []), ...localExits])
        await idle
        await Promise.all(localExits)
        await Promise.all([...remotes].filter(remote => remote.connectionId === id).map(remote => retire(remote)))
        return project(disabled)
      })
    } catch (cause) {
      drop(id)
      cancelCalls(id)
      await Promise.allSettled([...locals].filter(local => local.connectionId === id).map(stopLocal))
      throw cause
    } finally { writes.delete(id) }
  }

  const openTargetScope: McpEnvironmentPort['openTargetScope'] = (selectedTarget, context) => {
    const id = selectedTarget.endsWith('@1') ? selectedTarget.slice(0, -2) : ''
    const accepted = new Set<ActiveCall>()
    let localSession: LocalSession | undefined
    let localOpening: Promise<{ session: LocalSession; tools: readonly McpTool[] }> | undefined
    let stopped = false
    let unknown = false
    let closingScope: ToolCall<JsonValue> | undefined
    const cancel = async () => {
      stopped = true
      for (const call of accepted) call.controller.abort(cancellation())
      const exits = await Promise.allSettled([joinCalls(accepted), localSession && stopLocal(localSession)])
      if (unknown || exits.some(exit => exit.status === 'rejected')) throw unknownExit()
    }
    const prepareLocal = (connection: McpStdioConnection & McpConnection, signal: AbortSignal, check: () => void) =>
      localOpening ??= (async () => {
        const session = localSession = await startLocal(connection, check)
        try { return { session, tools: await discoverTools(connection, session.client, signal) } }
        catch (error) { await stopLocal(session); throw error }
      })()
    const execute = (request: ToolEnvironmentRequest): ToolCall<ToolEnvironmentResult> => {
      const controller = new AbortController()
      const signal = AbortSignal.any([context.signal, controller.signal, closingSignal.signal])
      const reqId = randomUUID()
      let remote: RemoteSession | undefined
      let exitFailure: unknown
      const requireTool = () => {
        signal.throwIfAborted()
        if (stopped) throw cancellation()
        if (request.resuming) throw mcpError('mcp-original-operation-unavailable', 409, 'outcome-unknown')
        const connection = get(id)
        const tool = connection.tools.find(tool => tool.toolId === request.toolId && tool.version === request.version)
        if (connection.status !== 'ready' || writes.has(id) || !ready(connection) || !tool) throw mcpError('mcp-tool-unavailable', 409)
        if (uncertainProcesses.has(connection.resourceKey)) throw unknownExit()
        const key = unknownKey(connection.resourceKey, tool.nativeName)
        if (uncertain.has(key)) throw mcpError('mcp-previous-operation-unknown', 409)
        return { connection, tool, key }
      }
      const result = Promise.resolve().then(async () => {
        const selected = requireTool()
        if (Buffer.byteLength(JSON.stringify(request.arguments), 'utf8') > 131_072) throw mcpError('mcp-invalid-arguments', 400, 'invalid-request')
        let args: Readonly<Record<string, JsonValue>>
        try { args = validateToolArguments(selected.tool.definition, request.arguments) }
        catch { throw mcpError('mcp-invalid-arguments', 400, 'invalid-request') }
        const processTarget = selected.connection.transport === 'stdio' ? await prepareLocal(selected.connection, signal, requireTool) : undefined
        if (processTarget && (processTarget.session.closing || !processTarget.tools.some(tool =>
          tool.toolId === selected.tool.toolId && tool.version === selected.tool.version))) {
          await stopLocal(processTarget.session)
          throw mcpError('mcp-tool-unavailable', 409)
        }
        await db.transaction(tx => {
          const current = requireTool()
          const row = tx.get("SELECT revision FROM mcp_connections WHERE id=? AND status='ready'", [id])
          if (current.connection.revision !== Number(row?.revision) || current.tool.nativeName !== selected.tool.nativeName) {
            throw mcpError('mcp-tool-unavailable', 409)
          }
          if (tx.get("SELECT 1 FROM mcp_operations WHERE endpoint=? AND native_name=? AND state='unknown' LIMIT 1", [selected.connection.resourceKey, selected.tool.nativeName])) {
            throw mcpError('mcp-previous-operation-unknown', 409)
          }
          if (tx.get('SELECT 1 FROM mcp_operations WHERE scope_id=? AND operation_id=?', [context.scopeId, request.operationId])) {
            throw mcpError('mcp-operation-already-admitted', 409)
          }
          tx.execute("INSERT INTO mcp_operations VALUES (?,?,?,?,?,?,'sent')",
            [context.scopeId, request.operationId, id, selected.connection.resourceKey, selected.tool.nativeName, reqId])
        })
        let sent = false
        let terminal = false
        try {
          requireTool()
          if (!processTarget) {
            remote = live.get(id)
            remote?.calls.add(call)
          }
          const client = processTarget?.session.client ?? remote?.client
          if (!client || processTarget?.session.closing) throw mcpError('mcp-tool-unavailable', 409)
          // No wait separates the final fence from the POST or stdio dispatch.
          sent = true
          const reply = await client.call(reqId, selected.tool.nativeName, args, signal)
          terminal = true
          if (reply.failed) throw mcpError('mcp-tool-request-failed', 502)
          return { result: normalizeResult(reply.value) }
        } catch (error) {
          if (sent && !terminal) {
            if (processTarget) {
              try { await stopLocal(processTarget.session) } catch { exitFailure = unknownExit() }
            } else exitFailure = unknownExit()
            if (exitFailure) uncertain.add(selected.key)
          }
          if (signal.aborted) throw cancellation()
          throw mcpError(codeOf(error), 502)
        } finally {
          try {
            await db.transaction(tx => {
              const { changes } = tx.execute("UPDATE mcp_operations SET state=? WHERE scope_id=? AND operation_id=? AND state='sent'",
                [exitFailure ? 'unknown' : 'exited', context.scopeId, request.operationId])
              if (!changes) throw unknownExit()
            })
          } catch {
            uncertain.add(selected.key)
            exitFailure = unknownExit()
          }
        }
      })
      const done = result.then(() => {}, () => {}).then(async () => {
        if (localSession && (signal.aborted || localSession.closing)) {
          try { await stopLocal(localSession) } catch { exitFailure = unknownExit() }
        }
        if (exitFailure) { unknown = true; throw exitFailure }
      })
      const call: ActiveCall = { connectionId: id, toolId: request.toolId, version: request.version, controller, done }
      accepted.add(call)
      calls.add(call)
      void done.finally(() => {
        accepted.delete(call)
        calls.delete(call)
        if (remote) {
          remote.calls.delete(call)
          if (remote.retired) return retire(remote)
        }
      }).catch(() => {})
      return { result, done, cancel() { controller.abort(cancellation()) } }
    }
    return { execute, cancel, hasResources: () => accepted.size > 0 || localSession !== undefined || unknown,
      close() {
        if (!closingScope) {
          const done = cancel()
          const result = done.then(() => ({ closed: true }))
          void result.catch(() => {})
          closingScope = { result, done, cancel() {} }
        }
        return closingScope
      } }
  }

  const close = () => {
    if (closing) return closing
    closingSignal.abort(cancellation())
    return closing = (async () => {
      await Promise.allSettled([...controls, ...[...calls].map(call => call.done), ...[...locals].map(stopLocal)])
      await Promise.all([...remotes].map(remote => retire(remote)))
      await Promise.all([...locals].map(stopLocal))
      live.clear()
      localReady.clear()
    })().finally(() => owners.delete(db))
  }
  return { environmentId: mcpEnvironmentId, version: mcpEnvironmentVersion, targets, openTargetScope, stdioSupported: () => stdioAvailable,
    connections: () => [...connections.values()].map(project), createConnection, refreshConnection, disableConnection, close }
}

export function createMcpEnvironmentComponent(options: McpEnvironmentOptions): Component.Object<void, { [localStorageServiceKey]: LocalStoragePort }> {
  return { name: options.serviceKey, inject: [localStorageServiceKey], async apply(ctx, _config, deps) {
    const environment = await openMcpEnvironment(deps[localStorageServiceKey], options)
    ctx.effect(() => () => environment.close(), 'close MCP connections and join tool calls')
    ctx.provide(options.serviceKey, environment)
  } }
}

# @anybox/models

Reusable Nya module owning unified sourced Provider/Model definitions, account connections, runnable configurations, credentials and protocol execution. Requires Node.js 22.13+ and `@nya/core`. It has no dependency on Anybox Run, Session, tools or frontend code.

独立框架图（含来源接纳、四种原生协议与自动基础配置）：[高清 PNG](docs/architecture.png) · [SVG](docs/architecture.svg)。统一定义、连接与执行配置的数据关系：[PNG](docs/architecture-data-flow.png) · [SVG](docs/architecture-data-flow.svg)。两页均保存在同一 [可编辑 draw.io](docs/architecture.drawio) 中；组件依赖与宿主接入见 [Models 模块架构](../../docs/architecture/models-module.md)。

## Install in an application

```ts
import { Context, FiberState } from '@nya/core'
import {
  createModelsStoreComponent, createModelsVaultComponent, createModelsComponent,
  createResponsesProtocolComponent, createChatCompletionsProtocolComponent,
  createAnthropicMessagesProtocolComponent, createGeminiInteractionsProtocolComponent,
  createModelsDevCatalogSourceComponent, createModelsCatalogCacheComponent,
  createModelsCatalogComponent,
  type ModelsService, type ModelsSettingsService, type ModelsCatalogService,
} from '@anybox/models'

const root = new Context()
for (const component of [
  createModelsStoreComponent({ path: '/absolute/app-data/models.sqlite' }),
  createModelsVaultComponent({ namespace: 'com.example.app.models' }),
  createModelsComponent(),
  createResponsesProtocolComponent(),
  createChatCompletionsProtocolComponent(),
  createAnthropicMessagesProtocolComponent(),
  createGeminiInteractionsProtocolComponent(),
  // Optional public directory. Startup uses bundled/cached data before a refresh.
  createModelsDevCatalogSourceComponent(),
  createModelsCatalogCacheComponent({ path: '/absolute/app-data/models-catalog.sqlite',
    reservedPaths: ['/absolute/app-data/models.sqlite'] }),
  createModelsCatalogComponent(),
]) {
  const fiber = root.installComponent(component)
  await fiber
  if (fiber.state !== FiberState.ACTIVE) throw new Error('Models startup failed')
}

// Trusted host request handlers obtain the current service rather than caching
// it across component restarts. Components use inject and their deps snapshot.
const settings = root.get<ModelsSettingsService>('models.settings')!
const models = root.get<ModelsService>('models')!
const catalog = root.get<ModelsCatalogService>('models.catalog')!
// Application shutdown: await root.fiber.dispose()
```

The host chooses a private database path and credential namespace. Each database has one exclusive owner, including between transactions; OS locks release after process death. The default vault uses macOS Keychain, Windows Credential Manager, or Linux Secret Service. An unavailable vault reports `credential-unavailable`; metadata can still be viewed. There is no plaintext or SQLite secret fallback.

The components register these services:

| Component | Provides | Injects | Owned resources |
|---|---|---|---|
| `createModelsStoreComponent` | `models.store` | — | SQLite connection, transactions, immutable versions, credential journal |
| `createModelsVaultComponent` | `models.vault` | — | OS vault operations and per-slot queues |
| `createModelsComponent` | `models`, `models.settings`, `models.protocols`, `models.source-data` | `models.store`, `models.vault` | Unified data, per-connection reconciliation, registrations, executions and network work |
| `createModelsDevCatalogSourceComponent` | `models.catalog-source` | — | Anonymous catalog HTTP requests, response readers and cancellation |
| `createModelsCatalogCacheComponent` | `models.catalog-cache` | — | Separate catalog SQLite connection and atomic cache writes; visible memory fallback |
| `createModelsCatalogComponent` | `models.catalog` | `models.catalog-source`, `models.catalog-cache`, `models.source-data` | Refresh timers, source exit, cache commit and shared-definition ingestion |
| Each protocol component | Registers a protocol | `models.protocols` | Native HTTP bodies, streams and protocol continuation |

The store, vault, catalog source and catalog cache ports are replaceable Nya dependencies. These are trusted internal services, not frontend APIs. Nya service names are not access-control boundaries. All components live on the same application root. Model execution depends on local settings and installed protocols; it does not depend on catalog availability.

## Unified definitions, connections and configurations

| Record | Responsibility |
|---|---|
| `Provider` | Definition, documentation, connection hints, source and immutable versions |
| `Model` | Provider definition, remote ID, capabilities, modalities, limits, costs, controls, source and versions |
| `ProviderConnection` | Account name, actual endpoint, one fixed protocol, auth and enabled state; private store owns credential reference |
| `ModelConfiguration` | Stable selection ID, connection/definition IDs, pinned definition version, capabilities, defaults and enabled state |
| `RunnableModelSummary` | Configuration plus definition identity, source and derived local availability |

`SourceRef` is `{ kind: 'user' }` or an `external` identity containing `sourceId`, external `providerId`, optional external `modelId` and `sourceVersion`. External identities are scoped by source, never merged by name or hostname. Network/cache/bundled describes acquisition, not origin. A user Model can belong to an external Provider. Adding an account or Key does not change the definition source.

The primary setup path uses an existing definition:

```ts
const provider = settings.providers({ sourceId: 'models.dev', search: 'OpenAI' })[0]
const connection = await settings.createConnection({
  id: 'work', providerDefinitionId: provider.id, name: 'Work account', enabled: true,
  protocolId: 'responses', baseUrl: 'https://api.openai.com/v1',
  auth: 'api-key', timeoutMs: 120_000, apiKey: secretEnteredByUser,
})
const choices = models.list({ connectionId: connection.id, available: true })
// All compatible text models have persistent baseline configurations.
// No per-model save or network authorization probe is required.
```

Each connection uses one protocol. Reconciliation runs after connection saves, Key changes, source ingestion, protocol registration and startup. It atomically adds missing baseline configurations, unique by `(connectionId, modelDefinitionId)`, and never overwrites saved names, enabled state, capability declarations or defaults. Descriptor defaults become explicit saved values, including Anthropic's bounded `4096` output default. Unknown capabilities remain unknown; missing reasoning modes are not inferred. `connectionModels(id)` includes unavailable definitions and their reasons. A saved connection whose initialization failed returns `sync.state === 'failed'`; `retryConnection(id)` is idempotent and retains the Key. Synchronization states and source targets do not increment connection revisions.

`settings.deleteConnection(id, expectedRevision)` uses the connection's configuration queue and CAS revision. It atomically removes the current connection, its baseline/variant configurations and synchronization state, while preserving definition data and immutable histories. Previously opened executions retain their captured configuration and credential; new opens fail with `not-found`. The transaction journals retired credential slots, then awaits vault cleanup; unavailable vault cleanup remains journaled for recovery. Deleted connection/configuration IDs cannot be reused, and source refresh cannot recreate deleted accounts.

Custom definitions use the same data pool:

```ts
const customProvider = await settings.createProvider({
  name: 'Private endpoint', connectionHints: { protocolIds: ['responses'] },
})
const customModel = await settings.createModel({
  providerId: customProvider.id, remoteModelId: modelIdConfirmedByUser, name: 'My model',
  capabilities: unknownCapabilities(), controls: { temperature: 'unknown' },
  modalities: { input: ['text'], output: ['text'] }, limits: {},
  connectionHints: { protocolIds: ['responses'] },
})
const customConnection = await settings.createConnection({
  providerDefinitionId: customProvider.id, name: 'Private account', enabled: true,
  protocolId: 'responses', baseUrl: addressEnteredByUser,
  auth: 'api-key', timeoutMs: 120_000, apiKey: secretEnteredByUser,
})
// Advanced variants use independent selection IDs.
const variant = await settings.createConfiguration({
  modelDefinitionId: customModel.id, connectionId: customConnection.id,
  name: 'My preset', enabled: true, baseline: false,
  capabilities: customModel.capabilities, defaults: { temperature: 0.2 },
})
```

User definition writes always produce `user` source records; source definitions are replaced through the trusted ingestion port. Configuration identity, connection, and fixed definition version stay stable across edits. Extra parameter variants have independent selection IDs and `baseline: false`.

`builtinProviderTemplates` supplies optional endpoint/protocol defaults and an explicit `sourceRef`. It is not a runtime brand registry. `resolveCatalogConnections` uses installed protocols and definition hints; SDK labels never dynamically import implementations. A registered extension may declare `descriptor.sourceMappings` for a known source/protocol mapping. Addresses exclude endpoint suffixes, query strings and URL credentials.

| Operation | Settings API |
|---|---|
| Definition queries/history | `providers(query?)`, `models(query?)`, `providerHistory(id)`, `modelHistory(id)` |
| User definitions | `createProvider`, `updateProvider`, `createModel`, `updateModel` |
| Account connections/history | `connections()`, `connectionHistory(id)`, `createConnection`, `updateConnection` |
| Replace/delete Key | `setApiKey(id, key, expectedRevision)`, `deleteApiKey(id, expectedRevision)` |
| Executable configurations/history | `configurations(connectionId?)`, `configurationHistory(id)`, `createConfiguration`, `updateConfiguration` |
| Initialization and reasons | `retryConnection(id)`, `connectionModels(id)` |
| Installed protocol forms | `protocols()` |
| Explicit remote requests | `discoverModels(connectionId, signal?)`, `checkConnection(connectionId, signal?)` |

User saves create immutable revisions; stale edits return `conflict`. Neutral configuration can be saved before a protocol is installed; synchronization stays pending and execution stays unavailable until registration validates the saved parameters. Discovery returns candidates without writing definitions/configurations. `available` means local configuration readiness and does not establish remote account authorization. Effective image input is always false. Native options remain explicit; omitted optional parameters use server defaults, while unsupported options are rejected. Configurations and Keys affect new executions only.

| Protocol | Native endpoint and supported controls |
|---|---|
| `responses` | `/responses`, `store: false`; `temperature`, `maxOutputTokens`, `protocol.reasoningEffort`, `protocol.reasoningSummary` |
| `chat-completions` | `/chat/completions`; `temperature`, `maxOutputTokens`, `protocol.reasoningEffort` |
| `anthropic-messages` | `/messages`; required `maxOutputTokens` → `max_tokens` (form default `4096`), `temperature` in `0..1`, `protocol.reasoningMode`, `reasoningBudgetTokens`, `reasoningEffort`, `reasoningDisplay` |
| `gemini-interactions` | `/interactions`, `store: false`; optional `maxOutputTokens`, `protocol.thinkingLevel`, `protocol.thinkingSummaries`; `temperature` is not accepted |

Responses and Chat Completions support `reasoningEffort: 'none'`, which makes effective reasoning unavailable. Anthropic accepts declared `disabled`, `adaptive` or `enabled` modes; enabled requires an integer budget of at least `1024`, below `maxOutputTokens` and inside any declared model budget. Adaptive and enabled modes require omitted or default (`1`) temperature. Native effort values are `low/medium/high/xhigh/max`; display is `summarized/omitted` and requires an explicit enabled or adaptive mode. This release sends workspace-scoped API keys in `x-api-key`, with the fixed `anthropic-version: 2023-06-01` and no beta headers. Unscoped multi-workspace keys require an additional workspace header and are outside this connection contract.

Gemini uses an API key in `x-goog-api-key`, a `v1beta` base URL, declared `thinkingLevel` values `minimal/low/medium/high`, and `thinkingSummaries: 'auto' | 'none'`. It uses private stateless input history rather than `previous_interaction_id`, background agents or server tools. All builtins expose text and user-defined function tools through the same public contract; media, structured output schemas and provider-managed tools are not execution features of this release.

`models.list()`/`get()` expose declared and effective capabilities plus availability. Missing protocols do not prevent configuration loading; affected models report `protocol-unavailable`. Image declarations may be saved, but effective image input is always false in this release and the message contract accepts only text.

## Source ingestion and public catalog

`models.catalog` supplies source status and refresh. Definition queries use `models.settings`; separate catalog Provider/Model DTOs and queries have been removed. The anonymous source requests [models.dev JSON](https://models.dev/api.json?type=all), normalizing every known modality into the module's Provider/Model types. `settings.models({ textOnly: true })` filters for the current text/function-tool contract; price and control metadata remain reference information.

```ts
const providerChoices = settings.providers({ sourceId: 'models.dev', search: 'Anthropic' })
const modelChoices = settings.models({ providerId: providerChoices[0].id, textOnly: true })
const directoryStatus = catalog.status()
await catalog.refresh(signal)
```

Catalog injects `models.source-data`, which is provided by the execution core alongside settings. The core itself injects only store/Vault, so existing execution remains independent of source/cache availability. `models.source-data.accept` accepts validated module `SourceSnapshot` schema 2, never raw upstream JSON; it commits all definitions, the source ledger and connection targets atomically, then waits per-connection reconciliation. Removed definitions are marked missing and retained with their versions; existing configurations continue executing pinned values.

Refresh waits for actual HTTP/reader exit, commits the independent cache, accepts shared definitions, then waits all admitted initialization jobs. A connection failure is reported separately from accepted source data. Cancellation stops fetch admission; after local commits are admitted, closure waits their completion through Nya dependency cleanup. Synchronization target guards prevent an earlier batch from marking a newer source version ready.

The shared database's accepted ledger is authoritative at startup. Only newer cache/bundle data or matching content is admitted. Older data cannot downgrade it; differing content with equal timestamps preserves accepted data and clears ETag so a full response can confirm it. Validated schema 1 cache data has a read-only converter; all current writes use schema 2. Cache and source failures retain accepted data, with an observable memory fallback only for the public cache. The cache key includes the source endpoint and `reservedPaths` prevents aliasing other database files.

Default scheduling remains 24 hours, retry after one hour, and a 30-second fetch timeout. ETag `304` updates check time without changing source data. `status()` reports origin (`bundled/cache/network/store`), version/time, staleness, persistence and connection synchronization outcomes. `autoRefresh: false` leaves explicit refresh available; concurrent requests return `busy`.

Raw bundled JSON, provenance, SHA-256 validation and upstream MIT attribution remain. Only explicit `npm --prefix packages/models run catalog:update` downloads replacement assets; ordinary build/test does not fetch the source.

## Persistent upgrade

Configuration SQLite migrates v1 to v2 in an exclusive transaction. Old Providers become connections, and old Models become configurations, preserving IDs, revisions/version IDs, timestamps, endpoints, defaults, disabled states and Key references. Every old Model receives its own user definition, including same-remote parameter duplicates. An explicit old `catalogRef` retains the complete external Provider identity as an unresolved definition until that source is ingested; other old Providers become user definitions. No origin is guessed from remote IDs or hostname.

Original historical records are preserved for read-boundary conversion; successful migration is idempotent and failure rolls back. Credential intents retain their IDs/slot IDs/times and are recovered against current connection references; migration never reads or copies Keys. Old histories do not keep retired secrets alive.

Execution snapshots written now carry schema version 2 and definition identity, while `modelId` remains the configuration selection ID and `providerId` remains the connection ID. Hosts read historical snapshots at their boundary without rewriting Session selections or historical Run JSON.

## Agent execution

```ts
const execution = await models.open({
  modelId: choices[0].id, history, tools,
  requirements: { tools: true }, signal,
})
try {
  let reply = await execution.generate({
    messages: [{ role: 'user', content: userText }], onEvent: displayProgress,
  }).result
  while (reply.status === 'completed' && reply.toolCalls.length) {
    // Agent validates business arguments, obtains authorization and executes tools.
    const messages = await executeTools(reply.toolCalls)
    // Each result: { role: 'tool', callId: call.id, content: serializedResult }
    reply = await execution.generate({ messages, onEvent: displayProgress }).result
  }
  return reply
} finally {
  await execution.close()
}
```

The module parses argument JSON and checks tool names, unique call IDs and corresponding results. It does not execute tools or validate business schemas. Text and multiple tool calls can coexist. Only `completed` results contain executable calls; `incomplete` and `refused` end the execution. Requirements whose capabilities are unknown or unsupported fail before a request.

Only new messages are submitted each turn. The execution privately holds normalized history and protocol continuation. Responses preserves native reasoning items, encrypted content and message phase; Anthropic preserves complete ordered content blocks, thinking signatures and redacted thinking; Gemini preserves thought summaries/signatures and native execution steps. Native tool identities are mapped privately for the two new protocols, while public tool IDs remain stable across an announced call and its final result. Anthropic maps leading system/developer instructions to its top-level system field and rejects mid-conversation instructions. All native context stays inside the execution. Business sessions persist normalized history and selected model IDs in the host. Reopening from history starts fresh; native in-flight context is not restored across process restarts.

`open()` fixes configuration revisions, effective options, registered protocol implementation and one credential read. Its public snapshot contains configuration identities/options, never a credential or its storage reference. Per-connection edits and opening local configuration/credentials run in admission order; subsequent HTTP requests run concurrently.

`generate()` returns `{ result, done, cancel }`. Public `result` settles only after native exit, context commit and unlocking. Awaiting it is sufficient before the next turn. `done` reports actual exit; cancellation and ordinary provider failures can leave `done` successful, whereas true cleanup failure rejects both. Both rejections are observed internally immediately. Same-execution overlap throws `busy`; different executions run concurrently.

Cancellation/timeout requests abort then waits for actual exit. No hidden retries occur. Ordinary call failures preserve the previous committed context for an explicit retry. A cancelled candidate is discarded. Cleanup failure closes the execution and remains visible through execution close, protocol unregister and component cleanup. `close()` is idempotent, stops admission, aborts and joins owned work, then releases private context/credential references. JavaScript strings cannot be securely zeroed; the module releases its references.

## Stream forwarding to a frontend

Without `onEvent`, no progress events are buffered. A throwing callback or accidentally rejected async callback unsubscribes itself without affecting model output. Callbacks must return promptly; CPU-bound user code cannot be preempted on the JS event loop.

Use `createModelEventQueue()` at the host boundary when an HTTP/SSE subscriber may be slow:

```ts
const subscription = createModelEventQueue({ capacity: 128, maxBufferedBytes: 256 * 1024 })
const call = execution.generate({ messages, onEvent: subscription.onEvent })
const forwarding = (async () => {
  for await (const event of subscription.events) await sendEventToBrowser(event)
})()
void forwarding.catch(() => subscription.close())
try { return await call.result }
finally { subscription.close() }
```

Overflow clears and ends only that subscription (`status === 'overflow'`); it does not block or cancel the model. Ending a subscription discards queued progress. Host transport cancellation must also release its own blocked writes. Final authoritative output is the result, not a concatenation of temporary events or tool argument deltas.

## Add a protocol

A trusted Nya component injects `models.protocols`, calls `register(ModelProtocol)`, and registers `registration.unregister()` with an Effect. The contract in `types.ts` includes descriptors, provider/options validation, effective capability calculation, optional discovery/check, and `call()`.

Each raw operation returns `{ result, done, cancel }`. Its candidate result/continuation may arrive before `done`; only the model service commits it after successful exit and a final cancellation check. Implementations must observe their own rejected promises, settle both on every path, cancel idempotently, and settle `done` only after fetch/readers/resources have actually exited. A successful `done` is distinct from a successful model response. Protocol functions are trusted code; frontend users cannot upload implementations.

Unregister immediately removes admission for that registration generation and closes its executions, including idle ones; it aborts and joins initialization, discovery and checks. A new registration with the same ID can be installed after old admission has been removed. Old cleanup cannot remove it. Other protocol generations continue working. Nya manages component dependencies; configuration loading never depends on protocols being registered.

## Credential consistency and tests

Before writing a fresh vault slot, the configuration database commits a cleanup intent. One transaction then commits the new connection revision/reference, removes the new-slot intent and records cleanup of the retired slot. Failure/crash leaves durable intents. Startup and subsequent credential mutations reclaim unreferenced slots; referenced slots are kept. Failed cleanup retains its intent for retry, so unavailable keyrings do not block non-secret configuration access. Histories contain references internally but no old key values. Public connection views expose only `credentialConfigured`, never the private reference.

`npm --prefix packages/models test` builds and runs protocol, catalog source/cache/refresh, runtime, storage, vault and host event-queue tests. Root `npm run check` includes this package. Tests use injected vaults, mocked streams, bundled catalog data and a loopback HTTP server; they do not contact paid APIs or certify native credential stores on every platform. Real OS vault behavior requires platform-specific acceptance.

Protocol references: [Responses streaming](https://developers.openai.com/api/reference/resources/responses/streaming-events), [function calling](https://developers.openai.com/api/docs/guides/function-calling), [reasoning](https://developers.openai.com/api/docs/guides/reasoning), [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions), [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create), [Anthropic thinking](https://platform.claude.com/docs/en/build-with-claude/thinking), [Gemini Interactions](https://ai.google.dev/gemini-api/docs/interactions-overview).

# @anybox/models

逐组件中文说明见 [Models 模块手册](../../docs/modules/models/README.md)，包含配置、Vault、目录和各原生驱动；本文保留独立包安装示例与公共契约。

Reusable Nya module owning unified sourced Provider/Model definitions, account connections, runnable native configurations, credentials and protocol execution. Version 0.2 removes the unified message/result execution API. Requires Node.js 22.13+ and `@nya/core`. It has no dependency on Anybox Run, Session, tools or frontend code.

迁移前组件布局参考图（包含来源接纳和配置关系；图中的旧执行接口不适用于 0.2，以本文原生契约为准）：[高清 PNG](docs/architecture.png) · [SVG](docs/architecture.svg)。统一定义、连接与执行配置的数据关系：[PNG](docs/architecture-data-flow.png) · [SVG](docs/architecture-data-flow.svg)。两页均保存在同一 [可编辑 draw.io](docs/architecture.drawio) 中；组件依赖与宿主接入见 [Models 模块架构](../../docs/architecture/models-module.md)。

## Install in an application

```ts
import { Context, FiberState } from '@nya/core'
import {
  createModelsStoreComponent, createModelsVaultComponent, createModelsComponent,
  createResponsesProtocolComponent, createChatCompletionsProtocolComponent,
  createAnthropicMessagesProtocolComponent, createGeminiInteractionsProtocolComponent,
  createModelsDevCatalogSourceComponent, createModelsCatalogCacheComponent,
  createModelsCatalogComponent,
  type ModelsService, type ModelsSettingsService, type ModelsCatalogService, type ModelsProtocolsService,
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
| `ModelConfiguration` | Stable selection ID, connection/definition IDs, pinned definition version, capabilities, versioned native parameters and enabled state |
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

Each connection uses one protocol. Reconciliation runs after connection saves, Key changes, source ingestion, protocol registration and startup. It atomically adds missing baseline configurations, unique by `(connectionId, modelDefinitionId)`, and never overwrites saved names, enabled state, capability declarations or parameters. Protocol initial parameters become explicit saved values, including Anthropic's bounded `4096` output default. Unknown capabilities remain unknown; missing reasoning modes are not inferred. `connectionModels(id)` includes unavailable definitions and their reasons. A saved connection whose initialization failed returns `sync.state === 'failed'`; `retryConnection(id)` is idempotent and retains the Key. Synchronization states and source targets do not increment connection revisions.

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
  capabilities: customModel.capabilities, parameters: { protocolId: 'responses', formatVersion: 1, value: { temperature: 0.2 } },
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

User saves create immutable revisions; stale edits return `conflict`. Neutral configuration can be saved before a protocol is installed; synchronization stays pending and execution stays unavailable until registration validates the saved parameters. Discovery returns candidates without writing definitions/configurations. `available` means local configuration readiness and does not establish remote account authorization. Effective image input is enabled by the Responses, Anthropic Messages, Gemini Interactions and Chat drivers with an explicit `imageInput: supported` configuration. Native options remain explicit; omitted optional parameters use server defaults, while unsupported options are rejected. Configurations and Keys affect new executions only.

| Protocol | Native endpoint and saved parameter fields |
|---|---|
| `responses` | `/responses`, fixed `store: false`; `temperature`, `max_output_tokens`, `reasoning.effort`, `reasoning.summary`, optional `tools: [{ type: 'web_search' }]` |
| `chat-completions` | `/chat/completions`; `temperature`, `max_completion_tokens`, `reasoning_effort` |
| `anthropic-messages` | `/messages`; required `max_tokens` (new-configuration default `4096`), `temperature`, `thinking.type/budget_tokens/display`, `output_config.effort`, optional `tools: [{ type: 'web_search_20250305', name: 'web_search' }]` |
| `gemini-interactions` | `/interactions`, fixed `store: false`; `generation_config.max_output_tokens/thinking_level/thinking_summaries` |

Parameters use `{ protocolId, formatVersion: 1, value }`; fields in `value` are native API fields. Protocol schemas allow only implemented parameters. Authentication, address, model identity, messages/history and transport controls cannot be overridden by parameter JSON. Native function declarations belong to the initial execution intent; configured server-search tools are validated separately and merged by the driver. `webSearch` is an explicit capability declaration: absence is unknown, and directory/provider names never establish support.

Responses and Chat accept only declared reasoning efforts, including `none`. Anthropic validates declared modes, budgets and efforts: enabled thinking requires a budget of at least 1024 below `max_tokens`; adaptive/enabled thinking requires omitted or default (`1`) temperature. Omitted parameters remain omitted. Anthropic sends `x-api-key` and `anthropic-version: 2023-06-01`, using workspace-scoped keys. Gemini sends `x-goog-api-key`; no server conversation or background agent is enabled. All four native drivers support image input when explicitly declared in the configuration.

Native results retain their protocol status, ordered content and unknown JSON fields. Responses preserves reasoning/encrypted content, phase, search activity and citations. Anthropic preserves thinking/signatures/redaction, client and server tool blocks, and `pause_turn`. Gemini preserves chronological native steps and signatures. A host protocol Loop decides how to handle tool requests, pauses, incomplete output and refusal; Models does not translate these into a shared result status or execute tools.

`models.list()`/`get()` report local readiness and effective capabilities. Configurations without an installed protocol remain queryable. Discovery and checks are explicit read-only requests and do not create settings. Configured native parameters and credentials are fixed for one execution.

## Source ingestion and public catalog

`models.catalog` supplies source status and refresh. Definition queries use `models.settings`; separate catalog Provider/Model DTOs and queries have been removed. The anonymous source requests [models.dev JSON](https://models.dev/api.json?type=all), normalizing every known modality into the module's Provider/Model types. `settings.models({ textOnly: true })` filters for the current text and native function-tool support; price and control metadata remain reference information.

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

SQLite schema 3 migrates v1 through v2 and converts current v2 configuration parameters in an exclusive transaction. IDs, immutable version identities, pinned model definitions, enabled states, baseline identity and credential references are retained. Historical configuration/connection JSON is not rewritten; readers understand older records. No migration reads or copies a credential.

The four built-in legacy converters map `maxOutputTokens` and old `protocol.*` fields to native field names without inserting defaults. An extension supplies its own pure converter through `createModelsStoreComponent({ path, legacyParameterConverters: { [protocolId]: converter } })`. Unknown or unsupported old settings remain readable as `formatVersion: 0` and unavailable for native execution; providing a converter at a later startup converts them transactionally. There is no old execution fallback or old-format configuration writer.

Every connection has a non-secret `historyScopeEpoch`. Successful Key replacement/deletion and endpoint/auth changes rotate it in the same connection transaction. Failed writes, names, timeout changes and synchronization do not rotate it. The epoch is not a Key hash or Vault reference. Native restore requires matching configuration/definition and remote model identities, scope epoch, parameter JSON and effective capabilities. Object key order and cosmetic renames do not change compatibility. No account identity is inferred from a connection ID or hostname.

Native snapshots use `schemaVersion: 3`, carrying native parameters, effective capabilities, registration generation and history scope. The host keeps old Session snapshots read-only; Models never rewrites application history.

## Native execution

```ts
const protocols = root.get<ModelsProtocolsService>('models.protocols')!
const lease = protocols.acquire('responses')
const execution = await models.openNative({ modelId: selectedId, lease })
try {
  const prepared = execution.prepareExchange({
    input: [{ role: 'user', content: 'Find the relevant facts' }],
    tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
  })
  // The host persists an operation intent and prepared.record before starting.
  const reply = await prepared.start(event => projectSafeDisplay(event)).result
  // reply.response is the native Responses object, not a shared ModelResult.
  // The protocol-specific host interprets it and supplies native tool outputs.
  const exit = await execution.close()
  // Commit a successful node only after checking exit.cleanup and host outcome.
  // exit.records contains only this execution's incremental request/response records.
} finally {
  await execution.close()
  lease.release()
}
```

`prepareExchange()` performs no external request. It fixes an immutable intent recipe, a request record ID and the preceding record ID. Its single-use `start()` returns `{ result, done, cancel }`. Same-execution overlap is rejected. Public `result` waits for actual operation exit, candidate validation and context commit; different executions run independently. The request record stores only the newly appended native intent, never a copy of all prior history.

`close()` is idempotent, synchronously stops new operations, cancels active work and waits for exit. It returns `{ records, restoreState?, cleanup }` even on cleanup failure, then releases private credential/context references. Diagnostics cannot create a successful history node. Responses failed/cancelled terminals and Anthropic error events retain terminal identity, error type/code and received native blocks; provider error messages, authentication fields and captured credential values are excluded. Any failed exchange makes that execution’s record chain ineligible for restore, including after an explicit successful retry. A late result after failed `done` cannot alter the frozen report. JavaScript strings cannot be securely zeroed; references are released.

For the next Run, the host resolves the selected immutable parent chain and supplies `restore: { ...parentMetadata, records: orderedRecords }` to `openNative`. Each protocol codec validates and reconstructs native state in memory. The host stores each Run's incremental records and small `restoreState` metadata, not the expanded historical array on every node. Native tool IDs, signatures, encrypted reasoning, root instructions and fixed tool declarations survive serialization and reopening. No text projection or browser stream cache is used for recovery.

## Image resources and recovery

Responses, Anthropic Messages, Gemini Interactions and Chat Completions 2.1.0 (including DeepSeek) accept ordered user text/image blocks. Chat images use `image_url.url = nativeImageResourceUri(id)`; this reserved internal URI is never sent to the provider. External URLs, inline data URLs, provider file IDs, image detail controls, and images in system/developer/tool messages remain unsupported. Existing string messages remain unchanged.

Pass a trusted `resources: NativeResourceResolver` to `openNative`. Its `read(ref, { signal })` synchronously returns `ProtocolOperation<Uint8Array>`; callers may implement memory, file or object storage without depending on Harness. `NativeImageResourceRef` contains only `{ id, sha256, byteLength, mimeType }`, with JPEG/PNG/GIF/WebP MIME types. Resource bytes must already have been admitted by the host's image validation policy. Models checks the byte count and SHA-256; it never opens a host path or interprets Session ownership. The host pins resource lifetime through accepted Run settlement and maintains durable resource ownership.

```ts
const image = { type: 'image_url', image_url: { url: nativeImageResourceUri(ref.id) } }
const execution = await models.openNative({ modelId, lease, resources,
  requirements: { imageInput: true } })
const prepared = execution.prepareExchange({ messages: [{ role: 'user',
  content: [{ type: 'text', text: 'Describe this image' }, image] }] },
  { resourceRefs: [ref] })
// Persist prepared.record/recipe before starting, just as with text.
const reply = await prepared.start().result
const exit = await execution.close()
```

`prepareExchange` captures the exact resource reference set used by the incremental intent, with no resource I/O. References cannot be duplicated, omitted or associated with conflicting metadata. Request records/recipes carry top-level `resourceRefs`; payload remains the native intent. An execution privately reconstructs the resource directory from restored records and restricts driver reads to resources in its current request.

The other drivers use the same resource URI and top-level references in their own native user blocks:

| Driver | Persisted intent image | Private HTTP image |
| --- | --- | --- |
| Responses | `{ type: 'input_image', image_url: nativeImageResourceUri(id) }` | `image_url` data URL |
| Anthropic Messages | `{ type: 'image', source: { type: 'url', url: nativeImageResourceUri(id) } }` | `source: { type: 'base64', media_type, data }` |
| Gemini Interactions | `{ type: 'image', uri: nativeImageResourceUri(id) }` in `user_input.content` | `{ type: 'image', mime_type, data }` |

These internal URI forms never reach the provider. `protocols/images.ts` contains pure field-specific codecs and a shared managed operation, not an additional component. Terminal native diagnostics remain available when cancellation or cleanup failure follows provider completion. Existing legal text-only shapes remain readable, including empty content arrays accepted by the old codecs.

After `start`, each protocol operation joins each resource read's result and actual exit before generating private native image fields and starting HTTP. Cancellation, missing bytes, checksum mismatch and cleanup failure never silently remove an image. The 32 MiB serialized request limit counts base64 expansion and repeated historical images, is checked before resource reads and again after materialization, and is separate from response limits. Model result/done and unregister wait for resource reads and HTTP cleanup. Wire image strings are temporary and never enter snapshots or request records. Public resource failures use fixed `resource-unavailable`, `invalid-resource` or `request-too-large` codes.

All built-in drivers write native record format 2 and read formats 1/2; each new Run writes one format while the selected parent chain may contain both. Their explicit readers support driver versions 2.0.0/2.1.0. Format 1 remains text-only and is never rewritten. The execution exposes `recordFormatVersion` so a host can bind its matching writer. Only a text-only parent's effective `imageInput: false` may upgrade to true; tools/streaming/search/reasoning, native parameters and account/model identity still require compatibility. Downgrading image capability is rejected. Catalog refresh never rewrites saved configuration capabilities.

`NativeProtocol` may declare `recordFormatVersion`, `canRestoreVersion(version)` and `resourceIds(intentOrRequest)`. Without these, the writer is format 1, reader version compatibility is strict, and resource references are unavailable. The protocol owns its native image mapping; Models owns reference validation and execution lifetime. [native-images.test.mjs](tests/native-images.test.mjs) covers JSON/SSE, the DeepSeek policy, tools, recovery, capability admission, resource failures, read cancellation/cleanup and wire limits.

## Events and protocol registration

Callbacks receive protocol-native events for a trusted host projector. Do not forward these raw events or recovery records to a browser: signatures, encrypted continuation and other private protocol fields may be present. The host generates a versioned safe display projection. `createNativeEventQueue({ capacity, maxBufferedBytes })` bounds a subscriber; overflow releases only that subscriber and never blocks model completion. Observer exceptions and rejected async callbacks detach the observer without affecting the operation.

A Nya component injects `models.protocols`, registers `NativeProtocol<I, R, E>`, and records `registration.unregister()` in an Effect. `registration.acquire()` returns a typed lease fixed to that generation, including `protocolVersion`, `generationId` and revocation `signal`. Acquire before opening and bind the host Loop/codec to the same generation. Releasing a lease prevents further admission with it. A stale or foreign lease is rejected.

Drivers provide parameter validation, effective capability calculation, native `prepare/exchange/commit`, record `restore`, and optional discovery/check. Driver types and state remain protocol-specific; Models has no dependency on the host's Run, Session, tools, UI or context tree. `createChatCompletionsProtocol(options, policy)` supports explicit extension differences (`protocolId`, `maxTokensField`, `disableThinking`, `allowDeveloper`, source mappings), so a host can register DeepSeek separately while reusing the native transport and parser.

A raw driver's `result` may precede `done`. `done` is the actual resource-exit boundary, including a completed cleanup attempt that failed. Models observes both promises immediately; failed `done` terminates a broken still-pending result, preserves available diagnostics and requests cancellation only once. Ordinary result failure still waits for `done`. Cancellation does not substitute for exit. No hidden network retries occur.

Unregister stops admission and signals revocation synchronously, then closes executions and joins owned initialization/discovery/check resources. The old generation cannot remove a replacement or stop another protocol. A host application registry must additionally stop and wait for its Run tools, program and settlement; Models unregister only guarantees resources Models owns. Nya still manages service dependency cleanup.

## Credential consistency and tests

Before writing a fresh vault slot, the configuration database commits a cleanup intent. One transaction then commits the new connection revision/reference, removes the new-slot intent and records cleanup of the retired slot. Failure/crash leaves durable intents. Startup and subsequent credential mutations reclaim unreferenced slots; referenced slots are kept. Failed cleanup retains its intent for retry, so unavailable keyrings do not block non-secret configuration access. Histories contain references internally but no old key values. Public connection views expose only `credentialConfigured`, never the private reference.

`npm --prefix packages/models test` builds and runs protocol, catalog source/cache/refresh, runtime, storage, vault and host event-queue tests. Root `npm run check` includes this package. Tests use injected vaults, mocked streams, bundled catalog data and a loopback HTTP server; they do not contact paid APIs or certify native credential stores on every platform. Real OS vault behavior requires platform-specific acceptance.

Protocol references: [Responses streaming](https://developers.openai.com/api/reference/resources/responses/streaming-events), [function calling](https://developers.openai.com/api/docs/guides/function-calling), [reasoning](https://developers.openai.com/api/docs/guides/reasoning), [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions), [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create), [Anthropic thinking](https://platform.claude.com/docs/en/build-with-claude/thinking), [Gemini Interactions](https://ai.google.dev/gemini-api/docs/interactions-overview).

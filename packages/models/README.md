# @anybox/models

Reusable Nya module for a public provider/model catalog, local model configurations, credentials and protocol execution. Requires Node.js 22.13+ and `@nya/core`. It has no dependency on Anybox Run, Session, tools or frontend code.

独立框架图：[高清 PNG](docs/architecture.png) · [SVG](docs/architecture.svg) · [可编辑 draw.io](docs/architecture.drawio)。组件依赖与宿主接入见 [Models 模块架构](../../docs/architecture/models-module.md)。

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
| `createModelsComponent` | `models`, `models.settings`, `models.protocols` | `models.store`, `models.vault` | Provider coordination, registrations, executions and network work |
| `createModelsDevCatalogSourceComponent` | `models.catalog-source` | — | Anonymous catalog HTTP requests, response readers and cancellation |
| `createModelsCatalogCacheComponent` | `models.catalog-cache` | — | Separate catalog SQLite connection and atomic cache writes; visible memory fallback |
| `createModelsCatalogComponent` | `models.catalog` | `models.catalog-source`, `models.catalog-cache` | Current immutable directory, refresh timers, in-flight refresh and publication |
| Each protocol component | Registers a protocol | `models.protocols` | Native HTTP bodies, streams and protocol continuation |

The store, vault, catalog source and catalog cache ports are replaceable Nya dependencies. These are trusted internal services, not frontend APIs. Nya service names are not access-control boundaries. All components live on the same application root. Model execution depends on local settings and installed protocols; it does not depend on catalog availability.

## Configure connections and models

```ts
const provider = await settings.createProvider({
  id: 'work', name: 'Work account', enabled: true,
  protocolId: 'responses', baseUrl: 'https://api.openai.com/v1',
  auth: 'api-key', timeoutMs: 120_000,
  apiKey: secretEnteredByUser, // optional; never present in the returned DTO
})
const candidates = await settings.discoverModels(provider.id) // explicit network request
// The user may instead enter remoteModelId manually; saving never requires network access.
const model = await settings.createModel({
  id: 'assistant', name: 'My assistant', enabled: true, providerId: provider.id,
  remoteModelId: modelIdConfirmedByUser,
  capabilities: {
    tools: { support: 'supported' },
    streaming: { support: 'supported' },
    imageInput: { support: 'unknown' },
    reasoning: { support: 'unknown' },
  },
  defaults: {}, // omitted parameters use server defaults
})
```

Capabilities above are **user declarations**, not inferred promises about any named model. Use `unknownCapabilities()` when metadata is absent. A second local Model may reference the same remote model with different defaults. API addresses and credentials belong only to Provider. `protocolId` and a Model's `providerId` are immutable.

`builtinProviderTemplates` supplies optional address/protocol defaults for the UI. It is not a runtime brand registry. Hosts may supply their own templates or let users choose an installed protocol and arbitrary HTTP(S) API base URL. The base URL excludes the endpoint suffix, query strings and URL credentials. The builtins append their own Messages, Interactions, Responses, Chat Completions or model-list endpoint.

Settings methods:

| Operation | API |
|---|---|
| Read connections and their non-secret history | `providers()`, `providerHistory(id)` |
| Create/edit/enable/disable connection | `createProvider(input)`, `updateProvider(id, patch, expectedRevision)` |
| Replace/delete API key | `setApiKey(id, key, expectedRevision)`, `deleteApiKey(id, expectedRevision)` |
| Read/create/edit/enable/disable model | `models(providerId?)`, `createModel(input)`, `updateModel(id, patch, expectedRevision)` |
| Inspect immutable model versions | `modelHistory(id)` |
| Installed protocol form descriptions | `protocols()` |
| Explicit remote discovery and check | `discoverModels(providerId, signal?)`, `checkConnection(providerId, signal?)` |

Every save creates a revision and immutable version. Stale edits return `conflict`; refresh before editing again. Disable via `{ enabled: false }`; records are retained for history. Existing executions survive edits, disabling, and key replacement. Authenticated model discovery returns candidates and never updates local models. Responses, Chat Completions and Gemini discovery provide IDs/names without guessing capabilities; Anthropic additionally maps capability evidence returned by its Models API. Connection checks validate authenticated access to a model-list endpoint, not the ability to generate with every model.

Protocol descriptors supply connection fields, parameter fields, ranges, enums and optional `defaultValue`. A form default initializes an editable value; the submitted value is saved in Model defaults and the execution snapshot. Descriptors do not silently insert missing execution parameters. Field paths such as `protocol.reasoningEffort` refer to Model defaults. Unsupported parameters are rejected, never silently removed; omitted optional parameters keep server defaults. A mode or effort must be implemented by the protocol and explicitly declared in the local model. The module does not guess undocumented model-specific restrictions; provider rejection remains a fixed `provider-failure`.

| Protocol | Native endpoint and supported controls |
|---|---|
| `responses` | `/responses`, `store: false`; `temperature`, `maxOutputTokens`, `protocol.reasoningEffort`, `protocol.reasoningSummary` |
| `chat-completions` | `/chat/completions`; `temperature`, `maxOutputTokens`, `protocol.reasoningEffort` |
| `anthropic-messages` | `/messages`; required `maxOutputTokens` → `max_tokens` (form default `4096`), `temperature` in `0..1`, `protocol.reasoningMode`, `reasoningBudgetTokens`, `reasoningEffort`, `reasoningDisplay` |
| `gemini-interactions` | `/interactions`, `store: false`; optional `maxOutputTokens`, `protocol.thinkingLevel`, `protocol.thinkingSummaries`; `temperature` is not accepted |

Responses and Chat Completions support `reasoningEffort: 'none'`, which makes effective reasoning unavailable. Anthropic accepts declared `disabled`, `adaptive` or `enabled` modes; enabled requires an integer budget of at least `1024`, below `maxOutputTokens` and inside any declared model budget. Adaptive and enabled modes require omitted or default (`1`) temperature. Native effort values are `low/medium/high/xhigh/max`; display is `summarized/omitted` and requires an explicit enabled or adaptive mode. This release sends workspace-scoped API keys in `x-api-key`, with the fixed `anthropic-version: 2023-06-01` and no beta headers. Unscoped multi-workspace keys require an additional workspace header and are outside this connection contract.

Gemini uses an API key in `x-goog-api-key`, a `v1beta` base URL, declared `thinkingLevel` values `minimal/low/medium/high`, and `thinkingSummaries: 'auto' | 'none'`. It uses private stateless input history rather than `previous_interaction_id`, background agents or server tools. All builtins expose text and user-defined function tools through the same public contract; media, structured output schemas and provider-managed tools are not execution features of this release.

`models.list()`/`get()` expose declared and effective capabilities plus availability. Missing protocols do not prevent configuration loading; affected models report `protocol-unavailable`. Image declarations may be saved, but effective image input is always false in this release and the message contract accepts only text.

## Public provider and model catalog

`models.catalog` is an optional read service backed by the anonymous [models.dev JSON](https://models.dev/api.json?type=all). Its source always requests `type=all`, so the directory can retain text, image, audio and other model metadata. `models({ textOnly: true })` selects text-capable entries for this module's current execution contract; deprecated entries are hidden unless `includeDeprecated: true`. Public metadata includes names, release/status information, modalities, context/input/output limits, price estimates in USD per million tokens, capability suggestions and separate `controls` hints. A catalog entry is not an account configuration or evidence that the current key can use the model.

```ts
const providerChoices = catalog.providers({ search: 'Anthropic' })
const modelChoices = catalog.models({ providerId: 'anthropic', textOnly: true })
const directoryStatus = catalog.status()
// Explicit request; resolves after source exit and the admitted cache commit.
await catalog.refresh(signal)
```

`resolveCatalogConnections(provider, settings.protocols(), hostTemplates, model?)` converts known connection hints into optional templates using installed protocols. Unknown SDK/connection shapes produce no automatic template. Catalog `npm` labels are data, never dynamically imported SDKs. Model-level address/protocol overrides are considered when selecting an entry. Hosts can still create a manual connection and remote model ID when no mapping exists.

Provider's optional `catalogRef: { sourceId, providerId }` links a local account to a directory namespace; `null` clears the link. Local Provider IDs and Model IDs remain independent. A Model uses its local `providerId` and `remoteModelId`; selection copies reviewed values into settings. Refreshing the directory never changes saved addresses, keys, capability declarations, parameters, model selection or open executions. `controls` can inform a form, but does not prove model-specific reasoning modes or efforts that the source does not provide.

Catalog startup immediately uses the latest valid local cache, or the bundled upstream snapshot. It schedules an asynchronous refresh when the cache has never been checked or is at least 24 hours old; a fresh cache waits until its next 24-hour boundary. Refresh uses ETag/`If-None-Match`; `304` retains the snapshot and updates the successful-check time. Failures keep the previous directory and retry after one hour, with a 30-second fetch timeout. `status()` reports origin (`bundled/cache/network`), staleness, refresh activity, version/times, errors and persistence. `autoRefresh: false` disables scheduled refreshes, leaving explicit `refresh()` available. Concurrent refresh attempts return `busy`.

The cache lives in a separate SQLite file and contains no credentials or local account settings. `reservedPaths` protects the host's other database files, including canonical path aliases. Its key includes the normalized source endpoint, so caches cannot cross endpoints. Cache initialization failure defaults to an observable memory fallback (`cache.persistence === 'memory'`, `cache.error === 'storage-unavailable'`); set `fallbackToMemory: false` to require persistence. Failed writes retain the previous published snapshot. A refresh waits for actual HTTP/reader exit before admitting an atomic cache commit; once that commit has started, late cancellation cannot undo it. Component cleanup stops timers/admission, aborts fetches and waits for source exit and accepted writes. Catalog dependencies and cleanup are managed by Nya, independently of the execution service.

The package ships `assets/models.dev.api.json`, provenance (source URL, capture time, SHA-256 and normalized version) and the upstream MIT license. Startup verifies provenance before normalizing the bundled data. `npm --prefix packages/models run catalog:update` is an explicit developer operation that fetches and updates these reviewable assets; normal builds and tests do not download them. The source/cache interfaces can be replaced by another root component without importing Anybox business code.

## Agent execution

```ts
const execution = await models.open({
  modelId: 'assistant', history, tools,
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

`open()` fixes configuration revisions, effective options, registered protocol implementation and one credential read. Its public snapshot contains configuration identities/options, never a credential or its storage reference. Per-provider edits and opening local configuration/credentials run in admission order; subsequent HTTP requests run concurrently.

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

Before writing a fresh vault slot, the configuration database commits a cleanup intent. One transaction then commits the new Provider revision/reference, removes the new-slot intent and records cleanup of the retired slot. Failure/crash leaves durable intents. Startup and subsequent credential mutations reclaim unreferenced slots; referenced slots are kept. Failed cleanup retains its intent for retry, so unavailable keyrings do not block non-secret configuration access. Histories contain references internally but no old key values. Public provider views expose only `credentialConfigured`.

`npm --prefix packages/models test` builds and runs protocol, catalog source/cache/refresh, runtime, storage, vault and host event-queue tests. Root `npm run check` includes this package. Tests use injected vaults, mocked streams, bundled catalog data and a loopback HTTP server; they do not contact paid APIs or certify native credential stores on every platform. Real OS vault behavior requires platform-specific acceptance.

Protocol references: [Responses streaming](https://developers.openai.com/api/reference/resources/responses/streaming-events), [function calling](https://developers.openai.com/api/docs/guides/function-calling), [reasoning](https://developers.openai.com/api/docs/guides/reasoning), [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions), [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create), [Anthropic thinking](https://platform.claude.com/docs/en/build-with-claude/thinking), [Gemini Interactions](https://ai.google.dev/gemini-api/docs/interactions-overview).

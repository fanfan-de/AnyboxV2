# Claude Agent application package

`@anybox/app-claude-agent` owns the Claude Agent SDK adapter, project/thread/run index, HTTP service, owner authentication and browser resources. Its stable application ID remains `claude-agent`. It uses the execution device's existing Claude environment; no Claude credentials are copied into owner tokens or application storage.

D1.2 adds the `anybox.app.json` archive recipe and public `package/client` / `package/execution` factories. Preparation only constructs existing registrations; it does not locate or launch Claude, read settings, access credentials, migrate data or open a business server. The signed artifact contains its complete production closure while excluding unused SDK platform Claude executables; the user-provided Claude executable and environment remain application runtime requirements. See [archive contracts](../../docs/modules/package-management/archives.md). Actual installation and role activation follow in D1.3/D1.4.

## Standalone business server

Install this package with its declared dependencies and `@nya/core`, then initialize and start it:

```sh
anybox-claude-agent init
anybox-claude-agent serve
```

`init [device name]` prints the instance ID and a single-use display of the owner token. `recover-access [device name]` issues another owner token; `new-identity [device name]` replaces the instance identity and revokes existing tokens. Run these commands with the server stopped. Send SIGINT or SIGTERM for normal shutdown. The server prints its URL and identity and sends an IPC `{ type: 'ready', instanceId, url }` message when launched with an IPC channel.

The standalone service owns one Nya root, one existing business SQLite connection, owner authentication and its HTTP listener. The `claude-agent-listener` component injects the current `host.access` generation and resolves the business handler per request; access restarts replace its authentication and revocation subscriptions while retaining the port. It does not require `@anybox/host`, distribution, Anybox Harness, Models or Computer. Its owner-authentication implementation preserves `host-access` v2, `host_identity`, `host_access_tokens`, instance IDs, token digests and the existing token format. This authentication is separate from Claude's login and settings.

| Configuration | Behavior |
| --- | --- |
| `ANYBOX_HARNESS_DATABASE` | Existing business database, default `./data/harness.sqlite` |
| `ANYBOX_CLAUDE_AGENT_PORT` | Standalone port; falls back to `ANYBOX_HARNESS_PORT`, then `ANYBOX_WEB_PORT`; CLI default 3002 |
| `ANYBOX_CLAUDE_AGENT_BIND` | Bind address; falls back to `ANYBOX_HARNESS_BIND`, then `127.0.0.1` |
| `ANYBOX_CLAUDE_AGENT_NAME` | Instance display name, default `Claude Agent` |
| `ANYBOX_CLAUDE_AGENT_BINARY` | Explicit Claude executable path; otherwise use the existing Claude environment |

The parser's API default port is 0. No separate Claude database is introduced. Standalone and Anybox-managed services cannot open the same business file simultaneously; stop its current owner before switching modes. Claude transcripts remain in the Claude environment.

HTTP retains `/api/v1/instance`, `/api/v1/access/tokens` and `/api/v1/apps/claude-agent/*`. Use `Authorization: Bearer <token>`; requests other than instance discovery also require `X-Anybox-Instance-Id`. Instance discovery advertises `tokens`, `claude-agent.v1` and `sse`. The standalone listener exposes business service APIs, without application management or a standalone desktop/browser client.

## Shared business assembly

`createClaudeAgentRuntime(root, config, options)` in `./server-runtime` installs business services into an existing root and returns the application runtime. The caller provides SQLite and owns the root; opening the business runtime requires neither `app.activity` nor `host.access`. `claudeAgentServerApplication()` adds Anybox registration and its stop protection around this same installation. `createClaudeAgentServer(config, options)` in `./server` creates the standalone root and listener. `parseClaudeAgentServerConfig(env)` in `./server-config` validates service settings before resources are opened.

Both modes share store, SDK adapter, Runs and business HTTP handler. A normal shutdown closes admission, begins HTTP drain, joins starts still persisting their index before SDK launch, cancels accepted Runs and waits for SDK process `done`, HTTP subscriptions, retained operations and database cleanup. Run cancellation and client disconnect preserve their existing meanings; disconnecting a stream does not cancel a Run.

The client runtime owns its connection store, credentials, local pairing, forwarding and connection-management UI; none of these are shared with Harness. The registration declares system directory selection optional. The execution registration requires SQL. Neither capability is mandatory in the minimum application API. D0a.1 provides independent business service execution; consumer-specific composition and application package installation remain later stages. Existing distribution commands and process roles are unchanged.

## Validation

Run `npm run build --workspace @anybox/app-claude-agent`, `npm run typecheck --workspace @anybox/app-claude-agent` or `npm test --workspace @anybox/app-claude-agent` after building its workspace dependencies. Package tests verify assets, environment configuration, runtime operation without host services, legacy owner identity/token migration, authenticated HTTP, SSE, token revocation, exclusive data ownership and shutdown waiting for actual SDK exit. Root tests additionally verify isolated package installation, SDK execution, approvals, cancellation, HTTP and browser flows.

Browser assets resolve relative to this package and retain `/applications/claude-agent/` and `/apps/claude-agent/` URLs. Existing migration domains, database ownership and API routes remain compatible. See [the Claude Agent design](../../docs/claude-agent-design.md).

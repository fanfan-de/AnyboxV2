# Anybox host

`@anybox/host` manages application lifecycle: package verification, local installation, selected/pending/actual versions, role loading, controlled activation, opening, closing, local uninstallation and shutdown. Application business, migrations, connections, credentials, Models, Session, Run and Computer behavior remain application-owned. Online download remains D2.

D1.4 adds the formal installed-role loader and `host-package-activation` alongside the registry and installer. A successful installation remains pending; activation and opening are separate. First activation leaves a new backend disabled. A UI-only application has no simulated backend or background target. Existing Products targets and browser workspace positions survive a controlled role restart.

The minimum host chooses no applications or optional business providers. The existing full application composition remains in `@anybox/distribution`; the old default desktop has not been fully migrated to an install-on-demand distribution. Workspace splitting, Nya component installation and package installation are distinct operations.

## Run the minimum host

Build dependency products first with the repository `npm run build`, or copy the complete host artifact produced by `npm run artifacts:build -- --out <empty-directory> --host-only`. Destination machines use the declared external Node/Electron runtime; they do not install npm dependencies.

```sh
ANYBOX_CLIENT_DATABASE=/absolute/data/client.sqlite \
ANYBOX_APPLICATION_DIRECTORY=/absolute/data/applications \
ANYBOX_APPLICATION_TRUST=/absolute/config/publishers.json \
ANYBOX_HOST_ROLES=client,execution \
ANYBOX_WEB_PORT=3000 \
node packages/host/dist/main.js serve
```

`serve` runs a lifecycle parent with a stable loopback proxy and privately supervised client/execution roles. The parent has no Nya root, registry connection, business database or application imports. The client is the sole package writer. An execution process starts only if its selected role snapshot contains entries. `ANYBOX_HOST_ROLES=client` explicitly disables execution hosting. `ANYBOX_EXECUTION_DATABASE` selects the execution control path; defaults preserve the configured directory and identity across restarts. No dotenv loader is used.

`ANYBOX_APPLICATION_CONFIG` optionally points to a bounded nonsecret JSON document:

```json
{
  "schemaVersion": 1,
  "applications": {
    "example-app": {
      "client": { "applicationOwnedOption": "value" },
      "execution": { "applicationOwnedOption": "value" }
    }
  }
}
```

The host passes each role's object to that application's pure registration factory. The application defines its schema, paths and defaults; secrets still belong in its credential provider. No application configuration can choose a bootstrap executable, import path or another application role.

`@anybox/host/desktop/main` runs the minimum Electron host through the same supervisor, fixed utility-process entries and stable `anybox-app://app` protocol. It uses `<userData>/data/client.sqlite` and `<userData>/applications`; `ANYBOX_DESKTOP_USER_DATA` selects an explicit profile. The private proxy has an incoming transport gate, and renderer code receives no transport or usage secret. Hidden `--host-smoke` requires an explicit isolated userData and verifies the empty host. Node factory preparation and independent worker launch remain unavailable in Electron/Windows; UI-only archives do not need Node preparation.

## Trust and local installation

`ANYBOX_APPLICATION_TRUST` names an external Ed25519 publisher/appId policy. The default trusts no publisher. Uploaded files, URLs, request-supplied public keys and generated example policies cannot grant trust. See the [archive manual](../../docs/modules/package-management/archives.md) for the exact schema.

```text
anybox-host verify <application.anybox-app> --trust <publishers.json>
anybox-host install <file> --directory <root> --trust <policy> --request-id <id>
anybox-host installations --directory <root>
anybox-host operations --directory <root>
anybox-host cancel <install-id> --directory <root>
anybox-host recover <install-id> --action inspect|resume|discard --directory <root> [--trust <policy>]
```

`verify` is read-only. The other commands acquire the same offline single writer and refuse an already managed directory; they do not steal ownership through PID checks or deleted locks. `install` durably accepts metadata before byte consumption, verifies the complete archive, prepares only pure registration descriptors, flushes and atomically commits an immutable directory, then records installed/pending facts. It never opens the application. Explicit recovery proves all historic work has exited and revalidates original bytes; discard never deletes a possibly committed version. See the [installation manual](../../docs/modules/package-management/installation.md).

## Apply installed versions

The shell's “Apply changes” action and lifecycle HTTP API live outside application routes at `/api/client/v1/app-packages`. Status reports registry revision, installations, safe actual role generations, activation progress and manager availability. Prepare, commit, cancel and explicit resume are separate controls. A 202 response confirms an accepted stage; only all-role ready receipts establish completion.

The coordinator freezes Products controls and application Activity guards for every affected process. Every registered browser page, including hidden pages, checks all mounted interfaces. The initiating page rechecks and joins actual `dispose()` exits before commit; peers acknowledge their own disposal. Unsaved drafts, busy applications, uncertain cleanup or disconnected pages retain pending versions. The default upgrade never cancels business work. A stable origin survives child port changes, and pages observe the original operation through reconnect before reloading. Newly installed applications are not opened or inserted into the workspace.

A failed interface cleanup retains its handle and failed promise, including ordinary close, initial activation failure and close during mounting. It cannot be remounted or omitted from later guards. Page registrations survive SSE disconnection; reconnects and acknowledgements use a document-local registration credential. Only an explicit exit after all interface cleanup succeeds unregisters the page. Controlled reload waits for that receipt. A hard refresh or forced close that interrupts cleanup retains an uncertain registration and may require restarting the page coordinator; a new document or a timeout does not prove the old one disposed.

Explicit activation recovery uses the same two-minute preparation timeout. Expiry releases only its temporary guards and preserves the durable recovery intent. Pre-spawn worker failures release their parent locks; once a process exists, actual exit proof is still required.

`createClientHost` / `createMinimumHost` remain embeddable APIs. A composition without a lifecycle manager can install packages and report pending state, but cannot promise process restart or hot replacement. `createClientHost` accepts trusted `applications`, optional capability `providers`, package policy and role hooks; `createExecutionHost` receives an explicit catalog and does not open another registry writer. Every service process owns one Nya root. SQL and directory selection remain optional application capabilities; no shared business layer is created.

Online lifecycle CLI uses the running local manager and never opens a second writer:

```text
anybox-host apply --endpoint http://127.0.0.1:3000 --request-id apply-001 [--app agent --app claude-agent]
anybox-host uninstall <appId> --endpoint http://127.0.0.1:3000 --request-id remove-001
anybox-host activation <id> --endpoint http://127.0.0.1:3000 [--action inspect|resume|cancel]
```

Only an explicit HTTP loopback root origin is accepted; remote hosts, credentials, query/hash, paths and redirects are rejected. Apply prepares and commits once, then only observes the original ID. Inspect is read-only; resume is explicit. Unknown responses, observation timeout or recovery do not become completion and never trigger an automatic repeated mutation.

## Uninstall a local application

In “My applications”, choose “Uninstall <appId>” from the installed package list, or use the online uninstall command above. This removes every nonremoved installed version of that application on this device. No trust policy is needed to read the uninstall target's package; damaged packages remain removable once ownership and exit are proven. Application databases, Models configuration, Vault entries, worker records, project files, images and remote services remain application-owned and are preserved. There is no delete-data option.

Uninstall uses an explicit `kind: remove` batch and nonempty appIds in the same prepare/commit API. All affected role guards and page interfaces participate. After actual page disposal, the coordinator saves existing backend targets as closed through the generic Products port, then replaces roles with plans excluding the removed application. It does not call business cancellation or migration. Other applications retain their targets and workspace positions. Independent workers or service managers still using a package block removal until their actual exit is proven.

A new role reporting ready only advances the batch to reclaiming. The registry pins its original canonical root directory handle and physical identity until controlled work exits. The trusted file adapter compares that private anchor with its captured root and rechecks exclusive usage protection before deleting each fixed identity container; it never follows links into application data. Completion requires every target installation removed and every remove operation completed. Windows currently rejects destructive reclamation when secure directory handles are unavailable; its ledger and UI-only installation remain usable. A changed original root, partial deletion, unsafe paths or failed cleanup retain recovery facts and cannot show uninstall success. Explicit `activation <id> --action resume` rechecks ownership and retries the original batch; reads never replay deletion. Once completed, every browser page removes only the target app's tabs and route before reloading. A historical uninstall does not clear positions after a subsequent reinstall, which starts closed and lets the application read its compatible retained data.

## Ownership and compatibility

The registry's v4 domain keeps v1 installation/usage data, v2 file jobs and v3 durable activation batches. It normalizes old batches to kind activate and records explicit remove batches without adding a separate component. `installed`, `selected`, `pending`, actual ready snapshots and Products targets are independent. Before any package import, the loader holds an actual SHARED usage anchor, claims the exact snapshot, checks immutable bytes, external trust, runtime/capability compatibility and resource closure. Complete archives can carry standalone runtime copies; hosted resolution uses canonical public Nya/API/SQL and rejects actually loading private copies or outside fallback. Corruption can quarantine a version; unsupported runtime or policy changes do not become fabricated disk damage.

A signed package declaring an independent worker must include `lifecycleVersion: 1`. Older signed packages remain verifiable but cannot be formally loaded through an unsafe legacy spawn path; publishers must release the update with a new application version, since same-version digest replacement remains rejected. The runtime-only `startRole('computer-worker', { ownership: 'independent', args })` launches only the same signed package's declared main. Parent and child retain continuous usage ownership; successful handoff makes that worker independently owned. Closing the host does not stop it. Current independent launch support is Unix Node only.

Version exit is proven by an EXCLUSIVE anchor and durable credential revocation. Missing, damaged or occupied anchors block reuse/reclamation. The host never infers exit from PID or timeout, restores shared business database backups or automatically replays uncertain operations. Activation recovery is explicit. Cleanup failure preserves the owner and blocks replacement; shutdown drains accepted local work before releasing the writer, without waiting on a restart that requires that writer to close.

New usage and installation-work anchors use format v2 and persist their original physical device/inode identity. Copied replacements, symbolic/hard-link aliases and legacy v1 anchors without an original identity cannot authorize use or reclamation, even if the ledger previously recorded exited. They are not silently adopted or upgraded. The managed host falls back to an empty management client while retaining such uncertain uses; restarting alone does not supply missing original anchor evidence. See the [registry compatibility boundary](../../docs/modules/package-management/registry.md).

## Build and tests

Run `npm run build --workspace @anybox/host` after public dependencies are built; `npm test --workspace @anybox/host` runs package behavior tests. Repository `npm run check` builds dependencies and includes host, application API and integration coverage. Key entries are `package-activation-ledger`, `package-loader`, `package-managed-process`, `package-independent-role`, `package-role-proxy`, page lifecycle, removal ledger/managed process/reclamation, package HTTP/UI and `desktop-managed-utility` tests, plus root `tests/application-shell.test.mjs`.

Current actual platform coverage is macOS arm64 Node and an isolated hidden minimum Electron host, including pure-web first activation and version 1→2 switching with draft rejection, actual interface disposal, new-role readiness, workspace restoration and normal process shutdown. Preparation, independent worker support, native credential access and other platforms keep their documented validation limits. See [activation/loading](../../docs/modules/package-management/activation.md), [package design and implementation order](../../docs/application-packages-design.md), [application development](../../docs/application-development.md) and the [stage record](../../docs/harness-server-plan.md).

import type { StorageMigration } from '@anybox/storage-sqlite/port'

/** The package manager owns this domain in its separately locked registry database. */
export const packageRegistryMigrations: readonly StorageMigration[] = [{ version: 1, up(tx) {
  tx.execute('CREATE TABLE package_registry_meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, owner_epoch INTEGER NOT NULL)')
  tx.execute('INSERT INTO package_registry_meta VALUES(1,0,0)')
  tx.execute('CREATE TABLE package_registry_applications (app_id TEXT PRIMARY KEY, facts_json TEXT NOT NULL)')
  tx.execute('CREATE TABLE package_registry_operations (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, operation_json TEXT NOT NULL)')
  tx.execute('CREATE TABLE package_registry_snapshots (id TEXT PRIMARY KEY, snapshot_json TEXT NOT NULL)')
  tx.execute('CREATE TABLE package_registry_usages (id TEXT PRIMARY KEY, usage_json TEXT NOT NULL, secret_digest TEXT NOT NULL, fenced INTEGER NOT NULL CHECK(fenced IN(0,1)), ready_confirmed INTEGER NOT NULL CHECK(ready_confirmed IN(0,1)))')
} }, { version: 2, up(tx) {
  tx.execute('CREATE TABLE package_registry_file_installs (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, install_json TEXT NOT NULL)')
} }, { version: 3, up(tx) {
  tx.execute('CREATE TABLE package_registry_activations (id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, activation_json TEXT NOT NULL)')
} }, { version: 4, up(tx) {
  // The existing durable role handoff also carries removals. Old records remain
  // activation intents; no package, filesystem or application data is touched.
  for (const row of tx.all('SELECT id,activation_json FROM package_registry_activations')) {
    const value = JSON.parse(String(row.activation_json)) as { kind?: unknown; ownedUsageIds?: unknown }
    if (value.kind === undefined) value.kind = 'activate'
    if (value.ownedUsageIds === undefined) value.ownedUsageIds = []
    tx.execute('UPDATE package_registry_activations SET activation_json=? WHERE id=?', [JSON.stringify(value), row.id])
  }
} }]

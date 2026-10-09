import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { Component } from '@nya/core';
import { modelsError, normalizeError } from './errors.js';
import { applyModelsJsonChange, emptyModelsJsonSnapshot, parseModelsJsonSnapshot } from './json-store-domain.js';
import type { ModelsJsonSnapshot } from './json-store-domain.js';
import type { LegacyParameterConverter } from './native-types.js';
import { migrateLegacyParameters } from './legacy-parameters.js';
import { readModelsSqliteSnapshot } from './store.js';
import { normalizeStoreChange } from './store-domain.js';
import { modelsStoreServiceKey } from './types.js';
import type { ModelsStore, StoreChange, Versioned } from './types.js';

export interface ModelsJsonStoreOptions {
  readonly path: string;
  /** Existing SQLite configuration is imported only when the JSON file is absent. */
  readonly legacyPath?: string;
  readonly legacyParameterConverters?: Readonly<Record<string, LegacyParameterConverter>>;
  /** Other independently owned storage paths must never alias the JSON file. */
  readonly reservedPaths?: readonly string[];
}
function missing(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }
async function fileInfo(path: string) { try { return await lstat(path); } catch (error) { if (missing(error)) return undefined; throw error; } }
async function canonicalPath(input: string): Promise<string> {
  const absolute = resolve(input), parent = dirname(absolute);
  try { return await realpath(absolute); } catch (error) {
    if (!missing(error)) throw error;
    if (parent === absolute) return absolute;
    return join(await canonicalPath(parent), basename(absolute));
  }
}
async function storagePath(options: ModelsJsonStoreOptions): Promise<string> {
  await mkdir(dirname(resolve(options.path)), { recursive: true, mode: 0o700 });
  const info = await fileInfo(resolve(options.path));
  if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)) throw modelsError('invalid-config');
  const path = await canonicalPath(options.path);
  for (const reserved of [...(options.reservedPaths ?? []), ...(options.legacyPath ? [options.legacyPath] : [])]) {
    if (typeof reserved !== 'string' || !reserved.trim()) throw modelsError('invalid-config');
    if (path === await canonicalPath(reserved)) throw modelsError('invalid-config');
    const other = await fileInfo(reserved);
    if (info && other && info.dev === other.dev && info.ino === other.ino) throw modelsError('invalid-config');
  }
  return path;
}
interface ProcessLock { readonly schemaVersion: 1; readonly pid: number; readonly token: string }
async function recoverStaleLock(lockPath: string): Promise<void> {
  // Serialize reclamation. Without this gate, two dead-PID contenders can both
  // validate the old inode, then one could unlink the other's newly acquired lock.
  const recoveryPath = `${lockPath}.recovery`, token = `${JSON.stringify({ schemaVersion: 1, pid: process.pid, token: randomUUID() })}\n`;
  let recovery: FileHandle;
  try { recovery = await open(recoveryPath, 'wx', 0o600); } catch { throw modelsError('storage-unavailable'); }
  try {
    await recovery.writeFile(token); await recovery.close();
    const info = await fileInfo(lockPath);
    if (!info || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw modelsError('storage-unavailable');
    const before = await readFile(lockPath, 'utf8');
    let previous: ProcessLock;
    try { previous = JSON.parse(before) as ProcessLock; } catch { throw modelsError('storage-unavailable'); }
    if (!previous || Object.keys(previous).length !== 3 || previous.schemaVersion !== 1 || !Number.isSafeInteger(previous.pid) || previous.pid <= 0 || typeof previous.token !== 'string' || !previous.token.trim()) throw modelsError('storage-unavailable');
    try { process.kill(previous.pid, 0); throw modelsError('storage-unavailable'); }
    catch (alive) {
      if (!(alive && typeof alive === 'object' && 'code' in alive && alive.code === 'ESRCH')) throw modelsError('storage-unavailable');
    }
    const after = await fileInfo(lockPath);
    if (!after || after.dev !== info.dev || after.ino !== info.ino || await readFile(lockPath, 'utf8') !== before) throw modelsError('storage-unavailable');
    await unlink(lockPath);
  } finally {
    await recovery.close().catch(() => {});
    // A recovery gate with unknown ownership is never automatically deleted.
    if (await readFile(recoveryPath, 'utf8') === token) await unlink(recoveryPath);
  }
}
async function acquireLock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`, lock: ProcessLock = { schemaVersion: 1, pid: process.pid, token: randomUUID() }, encoded = `${JSON.stringify(lock)}\n`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let handle: FileHandle;
    try { handle = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw modelsError('storage-unavailable');
      await recoverStaleLock(lockPath); continue;
    }
    try { await handle.writeFile(encoded); await handle.sync(); await handle.close(); }
    catch (error) { try { await handle.close(); } finally { await unlink(lockPath).catch(() => {}); } throw normalizeError(error, 'storage-unavailable'); }
    return async () => {
      try {
        if (await readFile(lockPath, 'utf8') !== encoded) throw modelsError('cleanup-failure');
        await unlink(lockPath);
      } catch { throw modelsError('cleanup-failure'); }
    };
  }
  throw modelsError('storage-unavailable');
}
function digest(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
async function currentHash(path: string): Promise<string | null> {
  try {
    const info = await fileInfo(path);
    if (!info) return null;
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw modelsError('conflict');
    return digest(await readFile(path));
  } catch (error) { throw normalizeError(error, 'storage-unavailable'); }
}
async function writeSnapshot(path: string, snapshot: ModelsJsonSnapshot, expectedHash: string | null): Promise<string> {
  if (await currentHash(path) !== expectedHash) throw modelsError('conflict');
  const bytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8'), temporary = `${path}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined, committed = false;
  try {
    handle = await open(temporary, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = undefined;
    if (await currentHash(path) !== expectedHash) throw modelsError('conflict');
    await rename(temporary, path); committed = true;
    // Rename is the commit point. A later directory flush cannot report this
    // committed reference as failed: Vault callers would remove its new Key.
    // Directory handles/fsync are also unavailable on some supported platforms.
    try {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch { /* The file itself was flushed before its atomic publication. */ }
    return digest(bytes);
  } catch (error) { throw normalizeError(error, 'storage-unavailable'); }
  finally {
    if (handle) await handle.close().catch(() => { throw modelsError('cleanup-failure'); });
    if (!committed) await unlink(temporary).catch(error => { if (!missing(error)) throw modelsError('cleanup-failure'); });
  }
}
function byId<T extends { readonly id: string }>(records: readonly T[], id: string): T | undefined { return records.find(record => record.id === id); }
function sorted<T extends { readonly id: string }>(records: readonly T[]): readonly T[] { return [...records].sort((a, b) => a.id.localeCompare(b.id)); }
function history<T extends Versioned>(records: readonly T[], id: string): readonly T[] { return records.filter(record => record.id === id).sort((a, b) => a.revision - b.revision); }

/** Owns authoritative nonsecret Models JSON, serialized atomic commits, and process locking. */
export function createModelsJsonStoreComponent(options: ModelsJsonStoreOptions): Component.Object<void> {
  if (!options || typeof options.path !== 'string' || !options.path.trim() || options.path === ':memory:' ||
      (options.legacyPath !== undefined && (typeof options.legacyPath !== 'string' || !options.legacyPath.trim() || options.legacyPath === ':memory:'))) throw modelsError('invalid-config');
  return { name: 'models-json-store', async apply(ctx) {
    let path: string, release: () => Promise<void>;
    try { path = await storagePath(options); release = await acquireLock(path); }
    catch (error) { throw normalizeError(error, 'storage-unavailable'); }
    let accepting = true, tail: Promise<void> = Promise.resolve(), snapshot: ModelsJsonSnapshot, fileHash: string | null;
    let released = false;
    const close = async () => { accepting = false; await tail; if (!released) { released = true; await release(); } };
    ctx.effect(() => close, 'join Models JSON commits and release exclusive file ownership');
    const initialize = async () => {
      fileHash = await currentHash(path);
      if (fileHash === null) {
        const legacy = options.legacyPath && await fileInfo(options.legacyPath);
        const candidate = legacy ? readModelsSqliteSnapshot({ path: options.legacyPath!, legacyParameterConverters: options.legacyParameterConverters }) : emptyModelsJsonSnapshot();
        snapshot = parseModelsJsonSnapshot(candidate, { now: new Date().toISOString(), versionId: () => randomUUID(), historyScopeEpoch: () => randomUUID() }).snapshot;
        fileHash = await writeSnapshot(path, snapshot, null);
      } else {
        const bytes = await readFile(path);
        if (digest(bytes) !== fileHash) throw modelsError('conflict');
        const parsed = parseModelsJsonSnapshot(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown, { now: new Date().toISOString(), versionId: () => randomUUID(), historyScopeEpoch: () => randomUUID() });
        snapshot = parsed.snapshot;
        const upgrades = snapshot.configurations.filter(record => record.parameters.formatVersion === 0).flatMap(record => {
          const parameters = migrateLegacyParameters(record.parameters.protocolId, record.parameters.value, options.legacyParameterConverters);
          return parameters.formatVersion === 1 ? [{ expectedRevision: record.revision, record: { ...record, parameters, revision: record.revision + 1, versionId: randomUUID(), updatedAt: new Date().toISOString() } }] : [];
        });
        if (upgrades.length) snapshot = applyModelsJsonChange(snapshot, { configurations: upgrades });
        if (parsed.changed || upgrades.length) fileHash = await writeSnapshot(path, snapshot, fileHash);
      }
    };
    const ready = initialize(); tail = ready.then(() => {}, () => {});
    try { await ready; if (!accepting) throw modelsError('closed'); } catch (error) { await close(); throw normalizeError(error, 'storage-unavailable'); }
    const assertOpen = () => { if (!accepting) throw modelsError('closed'); };
    const clone = <T>(read: () => T): T => { assertOpen(); return structuredClone(read()); };
    const service: ModelsStore = {
      providers: () => clone(() => sorted(snapshot.providers)), provider: id => clone(() => byId(snapshot.providers, id)), providerHistory: id => clone(() => history(snapshot.history.providers, id)),
      models: () => clone(() => sorted(snapshot.models)), model: id => clone(() => byId(snapshot.models, id)), modelHistory: id => clone(() => history(snapshot.history.models, id)),
      connections: () => clone(() => sorted(snapshot.connections)), connection: id => clone(() => byId(snapshot.connections, id)), connectionHistory: id => clone(() => history(snapshot.history.connections, id)),
      configurations: () => clone(() => sorted(snapshot.configurations)), configuration: id => clone(() => byId(snapshot.configurations, id)), configurationHistory: id => clone(() => history(snapshot.history.configurations, id)),
      sources: () => clone(() => [...snapshot.sources].sort((a, b) => a.sourceId.localeCompare(b.sourceId))), syncState: id => clone(() => snapshot.syncStates.find(record => record.connectionId === id)),
      intents: () => clone(() => sorted(snapshot.credentialIntents)),
      commit(input) {
        let change: StoreChange;
        try { assertOpen(); change = normalizeStoreChange(input); } catch (error) { return Promise.reject(normalizeError(error, 'invalid-config')); }
        const result = tail.then(async () => {
          const candidate = applyModelsJsonChange(snapshot, change);
          const nextHash = await writeSnapshot(path, candidate, fileHash);
          snapshot = candidate; fileHash = nextHash;
        });
        tail = result.then(() => {}, () => {}); return result;
      },
    };
    ctx.provide(modelsStoreServiceKey, service);
  } };
}

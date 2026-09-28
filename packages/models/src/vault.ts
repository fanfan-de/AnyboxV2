import { AsyncEntry } from '@napi-rs/keyring';
import type { Component } from '@nya/core';
import { modelsError } from './errors.js';
import { modelsVaultServiceKey } from './types.js';
import type { ModelsVault } from './types.js';

/** Injection seam for tests and host-owned OS vault bindings, never a disk fallback. */
export interface ModelsCredentialEntry {
  getPassword(signal: AbortSignal): Promise<string | undefined>;
  setPassword(value: string, signal: AbortSignal): Promise<void>;
  deleteCredential(signal: AbortSignal): Promise<boolean>;
}
export interface ModelsVaultOptions {
  readonly namespace: string;
  readonly openEntry?: (namespace: string, slotId: string) => ModelsCredentialEntry;
}

function validId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw modelsError('invalid-config');
}

function nativeEntry(namespace: string, slotId: string): ModelsCredentialEntry {
  const entry = new AsyncEntry(namespace, slotId, { linux: { store: 'secret-service' } });
  // Native cancellation can settle a JS promise before an OS operation finishes.
  // Await native completion, then report cancellation; never release ownership early.
  return {
    getPassword: () => entry.getPassword(),
    setPassword: value => entry.setPassword(value),
    deleteCredential: () => entry.deleteCredential(),
  };
}

/** One OS credential namespace; each slot is sequenced in admission order. */
export function createModelsVaultComponent(options: ModelsVaultOptions): Component.Object<void> {
  validId(options?.namespace);
  if (options.openEntry !== undefined && typeof options.openEntry !== 'function') throw modelsError('invalid-config');
  const namespace = options.namespace;
  const openEntry = options.openEntry ?? nativeEntry;
  return {
    name: 'models-vault',
    apply(ctx) {
      let accepting = true;
      const tails = new Map<string, Promise<void>>();
      const active = new Map<AbortController, Promise<void>>();
      const schedule = <T>(slotId: string, signal: AbortSignal | undefined, work: (entry: ModelsCredentialEntry, signal: AbortSignal) => Promise<T>): Promise<T> => {
        try { validId(slotId); if (!accepting) throw modelsError('closed'); }
        catch (error) { return Promise.reject(error); }
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
        const previous = tails.get(slotId) ?? Promise.resolve();
        const result = previous.then(async () => {
          if (controller.signal.aborted) throw modelsError('cancelled');
          try {
            const value = await work(openEntry(namespace, slotId), controller.signal);
            if (controller.signal.aborted) throw modelsError('cancelled');
            return value;
          } catch { throw modelsError(controller.signal.aborted ? 'cancelled' : 'credential-unavailable'); }
        });
        // Observe all accepted work immediately, including queued calls abandoned by a caller.
        const done = result.then(() => {}, () => {}).finally(() => {
          signal?.removeEventListener('abort', abort);
          active.delete(controller);
          if (tails.get(slotId) === done) tails.delete(slotId);
        });
        tails.set(slotId, done);
        active.set(controller, done);
        return result;
      };
      const service: ModelsVault = {
        read(slotId, signal) { return schedule(slotId, signal, (entry, owned) => entry.getPassword(owned)); },
        write(slotId, value, signal) {
          if (typeof value !== 'string' || !value.trim()) return Promise.reject(modelsError('invalid-config'));
          return schedule(slotId, signal, (entry, owned) => entry.setPassword(value, owned));
        },
        delete(slotId, signal) { return schedule(slotId, signal, async (entry, owned) => { await entry.deleteCredential(owned); }); },
      };
      ctx.effect(() => async () => {
        accepting = false;
        const accepted = [...active];
        for (const [controller] of accepted) controller.abort();
        await Promise.all(accepted.map(([, done]) => done));
      }, 'cancel and join system credential operations');
      ctx.provide(modelsVaultServiceKey, service);
    },
  };
}

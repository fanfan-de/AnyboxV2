import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { normalizeModelsDevCatalog } from '../dist/catalog-domain.js';

const sourceUrl = 'https://models.dev/api.json?type=all';
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30_000);
let reader;
try {
  const response = await fetch(sourceUrl, { headers: { Accept: 'application/json' }, credentials: 'omit', signal: controller.signal });
  if (!response.ok || !response.body) throw new Error('Catalog download failed');
  reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > 32 * 1024 * 1024) throw new Error('Catalog exceeds 32 MiB');
    chunks.push(part.value);
  }
  const raw = Buffer.concat(chunks);
  const fetchedAt = Date.now();
  const snapshot = normalizeModelsDevCatalog(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)), 'models.dev', fetchedAt);
  const provenance = {
    format: 'models.dev/type=all', sourceUrl, fetchedAt,
    sha256: createHash('sha256').update(raw).digest('hex'), snapshotVersion: snapshot.snapshotVersion,
    license: 'MIT', repository: 'https://github.com/anomalyco/models.dev',
    providers: snapshot.providers.length, models: snapshot.models.length,
  };
  const directory = new URL('../assets/', import.meta.url);
  await mkdir(directory, { recursive: true });
  // Explicit developer operation; both files remain reviewable before packaging.
  for (const [name, content] of [['models.dev.api.json', raw], ['models.dev.provenance.json', JSON.stringify(provenance, null, 2) + '\n']]) {
    const target = new URL(name, directory), temporary = new URL(`${name}.tmp`, directory);
    await writeFile(temporary, content);
    await rename(temporary, target);
  }
  process.stdout.write(`Updated ${snapshot.providers.length} providers and ${snapshot.models.length} models in ${fileURLToPath(directory)}\n`);
} finally {
  clearTimeout(timeout);
  if (reader) { await reader.cancel(); reader.releaseLock(); }
}

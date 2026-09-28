import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { normalizeModelsDevCatalog } from './catalog-domain.js';
import { modelsError } from './errors.js';
import type { CatalogSnapshot } from './catalog-types.js';

let bundled: CatalogSnapshot | undefined;
/** Real upstream data, captured explicitly by scripts/update-models-dev-snapshot.mjs. */
export function loadBundledModelsDevCatalog(): CatalogSnapshot {
  if (bundled) return bundled;
  try {
    const raw = readFileSync(new URL('../assets/models.dev.api.json', import.meta.url));
    const provenance = JSON.parse(readFileSync(new URL('../assets/models.dev.provenance.json', import.meta.url), 'utf8')) as { sourceUrl?: string; sha256?: string; fetchedAt?: number; format?: string };
    if (provenance.sourceUrl !== 'https://models.dev/api.json?type=all' || provenance.format !== 'models.dev/type=all' || !Number.isFinite(provenance.fetchedAt) || provenance.sha256 !== createHash('sha256').update(raw).digest('hex')) throw modelsError('invalid-response');
    bundled = normalizeModelsDevCatalog(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)), 'models.dev', provenance.fetchedAt);
    return bundled;
  } catch { throw modelsError('invalid-response'); }
}

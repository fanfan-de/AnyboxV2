import { createHash } from 'node:crypto';

/** Source identities are namespaced tuples; names and endpoint hosts are never identity. */
export function externalProviderId(sourceId: string, providerId: string): string {
  return `provider-external-${createHash('sha256').update(JSON.stringify([sourceId, providerId])).digest('hex')}`;
}

export function externalModelId(sourceId: string, providerId: string, modelId: string): string {
  return `model-external-${createHash('sha256').update(JSON.stringify([sourceId, providerId, modelId])).digest('hex')}`;
}

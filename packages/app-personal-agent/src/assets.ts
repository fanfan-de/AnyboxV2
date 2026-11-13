import { fileURLToPath } from 'node:url'
import type { ApplicationAsset } from '@anybox/application-api/node'

/** Browser resources belong to this application and are installed with its immutable package. */
export const personalAgentAssetPrefix = '/apps/personal-agent/0.1.0'
export const personalAgentAssets: readonly ApplicationAsset[] = [
  ...['app', 'view'].map(name => ({ path: `${personalAgentAssetPrefix}/web/${name}.js`, file: fileURLToPath(new URL(`./web/${name}.js`, import.meta.url)), type: 'text/javascript; charset=utf-8' })),
  { path: `${personalAgentAssetPrefix}/style.css`, file: fileURLToPath(new URL('../web/style.css', import.meta.url)), type: 'text/css; charset=utf-8' },
]

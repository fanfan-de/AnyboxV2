import { fileURLToPath } from 'node:url'
import type { ApplicationAsset } from '../../../host/applications/registration.js'

/** Exact browser asset map. Browser code lives under the application's web/ entry plus two pure core projections. */
export const claudeAgentAssets: readonly ApplicationAsset[] = [
  ...['app', 'client', 'projects', 'state', 'view'].map(name => ({ path: `/applications/claude-agent/web/${name}.js`, file: fileURLToPath(new URL(`../web/${name}.js`, import.meta.url)), type: 'text/javascript; charset=utf-8' })),
  { path: '/applications/claude-agent/core/events.js', file: fileURLToPath(new URL('../core/events.js', import.meta.url)), type: 'text/javascript; charset=utf-8' },
  { path: '/applications/claude-agent/core/view.js', file: fileURLToPath(new URL('../core/view.js', import.meta.url)), type: 'text/javascript; charset=utf-8' },
  { path: '/apps/claude-agent/style.css', file: fileURLToPath(new URL('../../../../web/apps/claude-agent/style.css', import.meta.url)), type: 'text/css; charset=utf-8' },
]

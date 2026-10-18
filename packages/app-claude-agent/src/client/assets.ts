import { fileURLToPath } from 'node:url'
import type { ApplicationAsset } from '@anybox/application-api/node'

/** Exact browser asset map. Browser code lives under the application's web/ entry plus two pure core projections. */
export const claudeAgentAssets: readonly ApplicationAsset[] = [
  ...['app', 'account', 'composer-extras', 'client', 'connections', 'projects', 'capabilities', 'permissions', 'session-permissions', 'workspace', 'state', 'view', 'markdown', 'vendor/markdown-parser'].map(name => ({ path: `/applications/claude-agent/web/${name}.js`, file: fileURLToPath(new URL(`../web/${name}.js`, import.meta.url)), type: 'text/javascript; charset=utf-8' })),
  { path: '/applications/claude-agent/web/vendor/markdown-parser.LICENSE.txt', file: fileURLToPath(new URL('../web/vendor/markdown-parser.LICENSE.txt', import.meta.url)), type: 'text/plain; charset=utf-8' },
  { path: '/applications/claude-agent/core/events.js', file: fileURLToPath(new URL('../core/events.js', import.meta.url)), type: 'text/javascript; charset=utf-8' },
  { path: '/applications/claude-agent/core/view.js', file: fileURLToPath(new URL('../core/view.js', import.meta.url)), type: 'text/javascript; charset=utf-8' },
  { path: '/apps/claude-agent/style.css', file: fileURLToPath(new URL('../../web/style.css', import.meta.url)), type: 'text/css; charset=utf-8' },
]

import { fileURLToPath } from 'node:url'
import type { ApplicationAsset } from '@anybox/application-api/node'
export const shellAssets: readonly ApplicationAsset[] = [
  { path: '/application-api/web.js', file: fileURLToPath(import.meta.resolve('@anybox/application-api/web')), type: 'text/javascript; charset=utf-8' },
  { path: '/', file: fileURLToPath(new URL('../web/index.html', import.meta.url)), type: 'text/html; charset=utf-8' },
  { path: '/style.css', file: fileURLToPath(new URL('../web/style.css', import.meta.url)), type: 'text/css; charset=utf-8' },
  { path: '/host/web/http-client.js', file: fileURLToPath(import.meta.resolve('@anybox/application-api/web')), type: 'text/javascript; charset=utf-8' },
  { path: '/host/web/client.js', file: fileURLToPath(new URL('./web/client.js', import.meta.url)), type: 'text/javascript; charset=utf-8' },
  { path: '/host/web/package-management.js', file: fileURLToPath(new URL('./web/package-management.js', import.meta.url)), type: 'text/javascript; charset=utf-8' },
  { path: '/host/web/package-directory.js', file: fileURLToPath(new URL('./web/package-directory.js', import.meta.url)), type: 'text/javascript; charset=utf-8' },
  { path: '/host/package-management/directory-format.js', file: fileURLToPath(new URL('./package-management/directory-format.js', import.meta.url)), type: 'text/javascript; charset=utf-8' },
  { path: '/host/web/page-lifecycle.js', file: fileURLToPath(new URL('./web/page-lifecycle.js', import.meta.url)), type: 'text/javascript; charset=utf-8' },
  { path: '/host/web/application-lifecycle.js', file: fileURLToPath(new URL('./web/application-lifecycle.js', import.meta.url)), type: 'text/javascript; charset=utf-8' },
  { path: '/host/web/application-workspace.js', file: fileURLToPath(new URL('./web/application-workspace.js', import.meta.url)), type: 'text/javascript; charset=utf-8' },
]

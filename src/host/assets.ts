import { fileURLToPath } from 'node:url'
import type { ApplicationAsset } from './applications/registration.js'
export const shellAssets: readonly ApplicationAsset[] = [
  { path: '/', file: fileURLToPath(new URL('../../web/index.html', import.meta.url)), type: 'text/html; charset=utf-8' },
  { path: '/style.css', file: fileURLToPath(new URL('../../web/style.css', import.meta.url)), type: 'text/css; charset=utf-8' },
  { path: '/host/web/http-client.js', file: fileURLToPath(new URL('./web/http-client.js', import.meta.url)), type: 'text/javascript; charset=utf-8' },
  { path: '/host/web/client.js', file: fileURLToPath(new URL('./web/client.js', import.meta.url)), type: 'text/javascript; charset=utf-8' },
  { path: '/host/web/application-workspace.js', file: fileURLToPath(new URL('./web/application-workspace.js', import.meta.url)), type: 'text/javascript; charset=utf-8' },
]

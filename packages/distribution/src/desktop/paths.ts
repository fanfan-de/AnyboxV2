import { join, resolve } from 'node:path'

/** Desktop paths never inherit CLI database environment variables or repository cwd. */
export function desktopPaths(userData: string) {
  const data = join(resolve(userData), 'data')
  return Object.freeze({ data, client: join(data, 'client.sqlite'), harness: join(data, 'harness.sqlite'),
    models: join(data, 'models.json'), legacyModels: join(data, 'models.sqlite'), catalog: join(data, 'models-catalog.sqlite'),
    images: join(data, 'images'), applications: join(resolve(userData), 'applications') })
}
export type { DesktopWorkerStart, DesktopWorkerReady } from '@anybox/host/desktop/contracts'

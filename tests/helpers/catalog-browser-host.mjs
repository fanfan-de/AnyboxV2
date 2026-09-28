/** Disposable browser QA entry point. CATALOG_BROWSER_SEED=1 preloads both native models and a selected session. */
import { startCatalogModelsHost } from './catalog-models-host.mjs'

const host = await startCatalogModelsHost({ seedModels: process.env.CATALOG_BROWSER_SEED === '1', seedSession: process.env.CATALOG_BROWSER_SEED === '1' })
process.stdout.write(JSON.stringify({ url: host.web.url, project: host.project, models: host.seededModels, session: host.session }) + '\n')
const stop = () => { void host.close().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }) }
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

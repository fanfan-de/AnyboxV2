/** Disposable browser QA entry point. CATALOG_BROWSER_SEED=1 preloads native models; CATALOG_BROWSER_LEGACY=1 adds read-only history. */
import { startCatalogModelsHost } from './catalog-models-host.mjs'

const host = await startCatalogModelsHost({ seedModels: process.env.CATALOG_BROWSER_SEED === '1', seedSession: process.env.CATALOG_BROWSER_SEED === '1' })
let legacy
if (process.env.CATALOG_BROWSER_LEGACY === '1') {
  legacy = { id: 'legacy-browser-session', projectId: host.project.id }
  // Test-only state setup through the database's existing exclusive owner.
  await host.root.get('local-storage').transaction(tx => {
    tx.execute("INSERT INTO harness_sessions (id, project_id, agent_id, created_at, model_id, history_mode) VALUES (?, ?, ?, ?, ?, 'dialogue-v1')",
      [legacy.id, host.project.id, 'assistant', new Date().toISOString(), host.seededModels[0]?.id ?? null])
    tx.execute('INSERT INTO harness_nodes (id, session_id, parent_id, input, output) VALUES (?, ?, ?, ?, ?)',
      ['legacy-browser-node', legacy.id, null, 'Legacy text history', 'Preserved original answer'])
  })
}
process.stdout.write(JSON.stringify({ url: host.web.url, project: host.project, models: host.seededModels, session: host.session, legacy }) + '\n')
const stop = () => { void host.close().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }) }
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

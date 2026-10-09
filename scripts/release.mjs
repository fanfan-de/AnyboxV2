/** Build an installable Node application with pinned local packages and catalog. */
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { stageApplication } from './stage-application.mjs'
const root = fileURLToPath(new URL('..', import.meta.url))
const output = resolve(process.argv[2] ?? join(root, 'artifacts/anybox-app'))
await stageApplication(root, output)
process.stdout.write(`Application release: ${output}\nInstall on target: npm ci --omit=dev --include=optional\n`)

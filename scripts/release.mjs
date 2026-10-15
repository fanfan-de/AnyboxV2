/** Build an installable Node application with pinned local packages and catalog. */
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { stageApplication } from './stage-application.mjs'
import { run } from './stage-application.mjs'
import { stageRuntime } from './stage-runtime.mjs'
import { buildProcessNative } from './build-process-native.mjs'
import { buildServiceNative } from './build-service-native.mjs'
const root = fileURLToPath(new URL('..', import.meta.url))
const output = resolve(process.argv[2] ?? join(root, 'artifacts/anybox-app'))
await stageApplication(root, output)
await buildProcessNative(root, join(output, 'dist/platform/native'))
await buildServiceNative(root, join(output, 'dist/platform/native'))
await run('npm', ['ci', '--omit=dev', '--include=optional', '--no-audit', '--no-fund'], output)
const runtime = await stageRuntime(root, output)
process.stdout.write(`Self-contained application release: ${output}\nStart roles with ${join(runtime, process.platform === 'win32' ? 'anybox.cmd' : 'anybox')}\n`)

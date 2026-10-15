import { execFile } from 'node:child_process'
import { access, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
const execute = promisify(execFile)
const app = resolve(process.argv[2] ?? `artifacts/desktop/out/Anybox-${process.platform}-${process.arch}${process.platform === 'darwin' ? '/Anybox.app' : ''}`)
const runtime = join(app, process.platform === 'darwin' ? 'Contents/Resources/runtime' : 'resources/runtime')
const node = join(runtime, process.platform === 'win32' ? 'node.exe' : 'node')
await access(node)
const env = { ...process.env, ANYBOX_RUNTIME_DIRECTORY: runtime }
delete env.NODE_OPTIONS; delete env.ELECTRON_RUN_AS_NODE; delete env.ANYBOX_POWERSHELL; delete env.ANYBOX_BASH
for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
env.PATH = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32') : '/usr/bin:/bin'
const { stdout } = await execute(node, [fileURLToPath(new URL('../tests/helpers/packaged-runtime-probe.mjs', import.meta.url)), runtime],
  { cwd: runtime, env, windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 })
const report = JSON.parse(stdout.trim().split(/\r?\n/).at(-1))
await writeFile(join(app, 'runtime-smoke-report.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))

/** Build public package products before their consumers, without a root production dependency set. */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { rm } from 'node:fs/promises'
const root = fileURLToPath(new URL('..', import.meta.url))
const packages = ['api-key-manager', 'application-api', 'storage-sqlite', 'directory-picker', 'models', 'app-harness', 'app-claude-agent', 'host', 'distribution']
const typecheck = process.argv.includes('--typecheck')
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' && command === 'npm' })
  child.once('error', reject)
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)))
})
await rm(new URL('../dist', import.meta.url), { recursive: true, force: true })
// Public declarations are required for independent consumer checking as well.
for (const name of packages) {
  if (!typecheck) await rm(new URL(`../packages/${name}/dist`, import.meta.url), { recursive: true, force: true })
  await run('npm', ['run', 'build', '--workspace', `packages/${name}`])
}
if (!typecheck) await run(process.execPath, ['scripts/verify-web-assets.mjs'])

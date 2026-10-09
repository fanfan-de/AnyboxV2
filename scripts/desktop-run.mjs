/** Launch the shared desktop entry with Electron's bundled runtime. */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const smoke = process.argv.includes('--smoke') || process.env.ANYBOX_DESKTOP_SMOKE === '1'
if (smoke && process.env.ANYBOX_KEYRING_TESTS !== '1') {
  process.stderr.write('Desktop smoke uses the system Vault. Run: ANYBOX_KEYRING_TESTS=1 npm run desktop:smoke\n')
  process.exit(1)
}
const env = { ...process.env, ...(smoke ? { ANYBOX_DESKTOP_SMOKE: '1' } : {}) }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
const child = spawn(require('electron'), [root, ...process.argv.slice(2).filter(argument => argument !== '--smoke')], { cwd: root, env, stdio: 'inherit' })
child.once('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))

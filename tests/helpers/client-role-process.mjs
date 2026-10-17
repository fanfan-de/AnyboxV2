import { register, syncBuiltinESMExports } from 'node:module'
import childProcess from 'node:child_process'

register('./role-import-guard.mjs', import.meta.url, { data: { mode: process.env.ANYBOX_TEST_ROLE_GUARD ?? 'client' } })
// Loading and opening the client must not create any executor or tool subprocess.
for (const name of ['spawn', 'fork', 'exec', 'execFile', 'spawnSync', 'execSync', 'execFileSync']) {
  childProcess[name] = () => { throw new Error(`Client unexpectedly called child_process.${name}`) }
}
syncBuiltinESMExports()
// Windows process.kill does not deliver a graceful SIGTERM. Drive the entry's own signal handler.
process.on('message', value => { if (value === 'test-stop') process.emit('SIGTERM') })

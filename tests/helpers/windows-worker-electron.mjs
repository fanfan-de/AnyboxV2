import { app, utilityProcess } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = process.argv[2]
if (!directory) throw new Error('Missing isolated Electron worker directory')
app.setPath('userData', join(directory, 'electron-profile'))
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
async function main() {
try {
  await app.whenReady()
  const utility = utilityProcess.fork(fileURLToPath(new URL('./windows-worker-utility.mjs', import.meta.url)), [join(directory, 'worker')], {
    cwd: directory, serviceName: 'Anybox worker lifetime test', stdio: 'pipe',
  })
  let identity, utilityPid
  utility.stdout?.pipe(process.stdout, { end: false })
  utility.stderr?.pipe(process.stderr, { end: false })
  utility.on('spawn', () => { utilityPid = utility.pid })
  utility.on('message', message => {
    if (message.event !== 'started') return
    identity = message
    utility.postMessage({ command: 'close' })
  })
  utility.on('error', () => {})
  const code = await new Promise(resolve => utility.once('exit', resolve))
  if (code !== 0 || !identity || !utilityPid) throw new Error('Worker utility failed to close normally')
  await writeFile(join(directory, 'electron-exit.json'), JSON.stringify({ mainPid: process.pid, utilityPid, utilityExitCode: code, worker: identity }))
  app.exit(0)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Electron lifetime fixture failed'}\n`)
  app.exit(1)
}
}
// Electron emits ready after loading the main module; do not block that module
// with a top-level await of app.whenReady().
void main()

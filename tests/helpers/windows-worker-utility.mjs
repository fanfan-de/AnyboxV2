import { connectLocalComputerWorker } from '../../dist/applications/harness/core/computer/worker-client.js'

const directory = process.argv[2]
if (!directory || !process.parentPort) throw new Error('Missing isolated worker utility configuration')
const close = new Promise(resolve => process.parentPort.on('message', event => {
  if (event.data?.command === 'close') resolve()
}))
const observer = connectLocalComputerWorker({ directory, autoStart: false })
try {
  await observer.start()
  const status = await observer.status()
  if (status.state !== 'running') throw new Error('Utility could not start its independent worker')
  process.parentPort.postMessage({ event: 'started', pid: status.pid, bootId: status.bootId, workerId: status.workerId })
  await close
  // The utility owns only an observer. It must not stop the independent worker.
  await observer.closeObserver()
  process.exit(0)
} catch (error) {
  await observer.closeObserver()
  process.stderr.write(`${error instanceof Error ? error.message : 'worker utility failed'}\n`)
  process.exit(1)
}

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { adaptManagedDesktopUtility } from '../dist/desktop/managed-utility.js'
const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture() {
  const child = new EventEmitter(), messages = []
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdout.resume(); child.stderr.resume()
  child.postMessage = message => messages.push(message)
  return { child, messages, transport: adaptManagedDesktopUtility(child) }
}
test('utility transport relays private RPC without exposing a renderer or selecting an application entry', async () => {
  const f = fixture(), request = { type: 'request', id: 1, method: 'start', value: { role: 'client' } }, received = []
  f.transport.on('message', value => received.push(value)); f.child.emit('message', request); assert.deepEqual(received, [request])
  let result; f.transport.send(request, error => { result = error }); await tick(); assert.equal(result, null); assert.deepEqual(f.messages, [request])
  assert.equal(f.transport.stdout, f.child.stdout); assert.equal(f.transport.stderr, f.child.stderr)
  f.child.stdout.end(); f.child.stderr.end(); f.child.emit('exit', 0)
})
test('utility exit is actual process proof and close additionally joins both stdio streams', async () => {
  const f = fixture(), events = []
  f.transport.on('exit', (...args) => events.push(['exit', ...args])); f.transport.on('disconnect', () => events.push(['disconnect'])); f.transport.on('close', (...args) => events.push(['close', ...args]))
  f.child.emit('exit', 0); assert.equal(f.transport.connected, false); assert.deepEqual(events, [['exit', 0, null], ['disconnect']]); await tick(); assert.equal(events.length, 2)
  f.child.stdout.end(); await tick(); assert.equal(events.length, 2)
  f.child.stderr.end(); await tick(); assert.deepEqual(events.at(-1), ['close', 0, null])
  let failure; f.transport.send({ private: true }, error => { failure = error }); await tick(); assert.equal(failure.message, 'worker-unavailable'); assert.deepEqual(f.messages, [])
})
test('native utility diagnostics are never forwarded through the managed transport error event', () => {
  const f = fixture(); let observed
  f.transport.on('error', error => { observed = error }); f.child.emit('error', 'FatalError', '/private/path', 'SECRET_NATIVE_REPORT')
  assert.equal(observed.message, 'managed-role-start-failed'); assert.doesNotMatch(String(observed), /SECRET|private/)
  f.child.stdout.end(); f.child.stderr.end(); f.child.emit('exit', 1)
})
test('minimal desktop uses a fixed utility entry and stable supervised proxy without Electron RunAsNode', async () => {
  const source = await readFile(new URL('../src/desktop/main.ts', import.meta.url), 'utf8'), entry = await readFile(new URL('../src/desktop/managed-role-entry.ts', import.meta.url), 'utf8')
  assert.match(source, /startManagedApplicationHost/); assert.match(source, /utilityProcess\.fork\(fileURLToPath\(new URL\('\.\/managed-role-entry\.js'/)
  assert.match(source, /incomingTransportSecret: transportSecret/); assert.match(source, /createDesktopProtocolBridge\(managed\.url, transportSecret\)/)
  assert.match(entry, /process[^\n]*parentPort/); assert.match(entry, /installManagedRoleRpc/)
  assert.doesNotMatch(source + entry, /ELECTRON_RUN_AS_NODE|RunAsNode|createDesktopWorker|app-harness|app-claude/)
})

import { register } from 'node:module'
register('./web-local-loader.mjs', import.meta.url)

// Observe actual listeners in the entry process without adding production diagnostics.
import { Server } from 'node:net'
const listen = Server.prototype.listen
Server.prototype.listen = function (...args) {
  this.once('listening', () => {
    const address = this.address()
    if (address && typeof address === 'object' && process.connected) process.send({ type: 'test-listener-owner', pid: process.pid, port: address.port })
  })
  return Reflect.apply(listen, this, args)
}

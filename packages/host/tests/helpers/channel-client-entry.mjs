// Trusted test adapter deliberately corrupts private envelopes to exercise the parent boundary.
import { installManagedRoleProcess } from '../../dist/package-management/role-process.js'
import { createClientHost } from '../../dist/client.js'

const send = process.send.bind(process)
process.send = (message, ...args) => {
  if (message?.type === 'request' && message.method === 'channel.request' && message.value?.payload?.op === 'wrong-source') {
    message = { ...message, value: { ...message.value, source: { ...message.value.source, secret: 'wrong-private-secret' } } }
  }
  return send(message, ...args)
}
installManagedRoleProcess({ createClient: options => createClientHost({ ...options,
  packageChannel: (identity, payload, signal) => options.packageChannel(payload?.op === 'wrong-package' ? { ...identity, digest: 'f'.repeat(64) } : identity, payload, signal),
}) })

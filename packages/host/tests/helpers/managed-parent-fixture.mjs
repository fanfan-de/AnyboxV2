import { startManagedApplicationHost } from '../../dist/package-management/managed-process.js'
const host = await startManagedApplicationHost({ path: process.argv[2], packageDirectory: process.argv[3], roles: ['client'], clientEntry: new URL('./managed-role-fixture.mjs', import.meta.url) })
process.send({ type: 'ready', url: host.url })
process.on('message', value => { if (value?.type === 'close') void host.close().then(() => process.exit(0), () => process.exit(1)) })

import { createClientHost as createActualClientHost } from '../../packages/host/dist/client.js'
export async function createClientHost(options) {
  // Keep the real role inside its asynchronous host factory until the parent requests stop.
  const response = await fetch(process.env.ANYBOX_TEST_CLIENT_START_GATE_URL)
  await response.arrayBuffer()
  return createActualClientHost(options)
}

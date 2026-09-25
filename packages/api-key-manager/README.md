# API Key Manager

Framework-independent Node.js service for storing named API keys in the operating system credential store and exposing only configuration status.

```js
import { createApiKeyService } from '@anybox/api-key-manager'

const keys = createApiKeyService({
  namespace: 'my-project',
  definitions: [
    { id: 'llm/provider/default', label: 'LLM provider', category: 'Language models' },
    { id: 'video/provider/default', label: 'Video provider', category: 'Video models' },
  ],
})

await keys.write('video/provider/default', process.env.VIDEO_API_KEY)
console.log(await keys.list()) // metadata and configured flags only
const secret = await keys.read('video/provider/default') // trusted server code only
await keys.close()
```

Use `npm install /path/to/anybox-api-key-manager-0.1.0.tgz` after packing this directory with `npm pack`. The module depends on Node.js 22.13+ and `@napi-rs/keyring`; it does not depend on Anybox, Nya, or a Web framework. Other projects configure their own namespace and credential definitions without editing the module. On Linux the built-in store requires Secret Service and does not fall back to the temporary kernel keyring. `read(id, signal)` can be cancelled; settlement waits for the underlying operation to exit. Reads, writes, and deletes of one ID run in admission order.

`createApiKeyManager(definitions, store)` and `createSystemKeyringStore(options)` are also exported when a host needs separate lifecycle control or a different storage backend.

The host should authenticate and authorize any HTTP route that calls `write` or `delete`. This package intentionally does not create a public HTTP endpoint or browser UI.

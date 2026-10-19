import assert from 'node:assert/strict'
import test from 'node:test'
import picomatch from 'picomatch'
import forge from '../forge.config.mjs'

test('Harness native process resources stay physical outside the desktop ASAR', () => {
  const unpack = picomatch(forge.packagerConfig.asar.unpack)
  for (const root of ['packages/app-harness', 'node_modules/@anybox/app-harness']) {
    for (const file of ['anybox-process-host.exe', 'anybox-process-host', 'process-host.json']) {
      assert.equal(unpack(`${root}/dist/core/platform/native/${file}`), true)
    }
  }
  assert.equal(unpack('node_modules/@anybox/app-claude-agent/dist/core/sdk/adapter.js'), false)
})

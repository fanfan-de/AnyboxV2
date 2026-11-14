import assert from 'node:assert/strict'
import test from 'node:test'
import picomatch from 'picomatch'
import forge from '../forge.config.mjs'

test('Computer tools native process resources stay physical outside the desktop ASAR', () => {
  const unpack = picomatch(forge.packagerConfig.asar.unpack)
  for (const root of ['packages/computer-tools', 'node_modules/@anybox/computer-tools']) {
    for (const file of ['anybox-process-host.exe', 'anybox-process-host', 'process-host.json']) {
      assert.equal(unpack(`${root}/dist/platform/native/${file}`), true)
    }
  }
  assert.equal(unpack('node_modules/@anybox/app-claude-agent/dist/core/sdk/adapter.js'), false)
})

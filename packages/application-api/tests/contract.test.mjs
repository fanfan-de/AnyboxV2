import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { requireApplicationHttp } from '../dist/web.js'

// A browser application can consume the public contract without pulling in a Node,
// Nya, storage, connection or credential implementation.
test('core and browser adapters bundle independently for a browser', async () => {
  const entries = ['../dist/index.js', '../dist/web.js'].map(path => fileURLToPath(new URL(path, import.meta.url)))
  const result = await build({
    entryPoints: entries,
    bundle: true, platform: 'browser', format: 'esm', write: false, outdir: '/unused-application-api', metafile: true,
  })
  assert.equal(result.outputFiles.length, 2)
  const sources = Object.keys(result.metafile.inputs)
  assert.deepEqual(new Set(sources.map(path => resolve(path))), new Set(entries))
})

test('only an application that uses HTTP requires an API address', () => {
  const core = { appId: 'calculator', signal: new AbortController().signal,
    domId: value => `calculator--${value}`, route: { read: () => '', navigate() {}, subscribe: () => () => {} } }
  assert.equal(core.apiBase, undefined)
  assert.throws(() => requireApplicationHttp(core), /HTTP entry required/)
  const http = { ...core, apiBase: '/api/client/v1/apps/agent' }
  assert.equal(requireApplicationHttp(http), http)
})

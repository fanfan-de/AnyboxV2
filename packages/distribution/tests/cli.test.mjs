import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
const execute = promisify(execFile)
for (const [entry, args, expected] of [
  ['anybox-main', ['--help'], /Usage: anybox <role>/],
  ['computer-worker-main', ['--help'], /permissions/],
]) test(`the public ${entry} entry shows help without starting services`, async () => {
  const path = fileURLToPath(import.meta.resolve(`@anybox/distribution/entrypoints/${entry}`))
  const { stdout, stderr } = await execute(process.execPath, [path, ...args], { timeout: 10000 })
  assert.match(stdout, expected)
  assert.equal(stderr, '')
})

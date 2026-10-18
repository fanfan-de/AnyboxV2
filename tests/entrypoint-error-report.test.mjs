import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeError } from '../packages/distribution/dist/entrypoints/error-report.js'

test('describeError flattens AggregateError members and cause links on indented lines', () => {
  const inner = new Error('disk full')
  const member = new Error('cleanup failed', { cause: inner })
  const error = new AggregateError([member, 'raw'], 'Application shutdown failed')
  assert.equal(describeError(error), [
    'AggregateError: Application shutdown failed', '  Error: cleanup failed', '  caused by', '    Error: disk full', '  raw',
  ].join('\n'))
  assert.equal(describeError(new TypeError('plain')), 'TypeError: plain')
  assert.equal(describeError(undefined), 'undefined')
})

test('describeError stops at a bounded depth instead of following an endless cause chain', () => {
  let error = new Error('deepest')
  for (let n = 0; n < 12; n++) error = new Error(`level ${n}`, { cause: error })
  const lines = describeError(error).split('\n')
  assert.ok(lines.length < 20, `bounded: ${lines.length}`)
  assert.ok(lines.at(-1).endsWith('…'))
})

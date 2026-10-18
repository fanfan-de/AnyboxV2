import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computerScopeAllowsTool } from '../packages/app-harness/dist/core/unit/domain.js'

test('Computer tool grants reject empty selections and preserve explicit stable tool IDs', () => {
  const scope = { kind: 'computer', projects: 'all', tools: ['anybox.apply_patch'] }
  assert.equal(computerScopeAllowsTool(scope, 'anybox.apply_patch'), true)
  assert.equal(computerScopeAllowsTool(scope, 'anybox.bash'), false)
  assert.equal(computerScopeAllowsTool({ ...scope, tools: [] }, 'anybox.bash'), false)
  assert.equal(computerScopeAllowsTool({ ...scope, tools: 'all' }, 'anybox.bash'), true)
  assert.equal(computerScopeAllowsTool(null, 'anybox.bash'), false)
  assert.equal(computerScopeAllowsTool({ kind: 'models', access: 'manage', configurations: 'all' }, 'anybox.bash'), false)
})

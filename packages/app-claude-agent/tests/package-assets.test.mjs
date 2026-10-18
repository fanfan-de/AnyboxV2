import test from 'node:test'
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { claudeAgentDefinition, claudeAgentId } from '@anybox/app-claude-agent/definition'
import { parseClaudeAgentConfig } from '@anybox/app-claude-agent/config'
import { claudeAgentAssets } from '@anybox/app-claude-agent/client/assets'

test('the independent Claude Agent package keeps application identity and owns all browser assets', async () => {
  assert.equal(claudeAgentId, 'claude-agent')
  assert.equal(claudeAgentDefinition.id, claudeAgentId)
  assert.equal(new Set(claudeAgentAssets.map(asset => asset.path)).size, claudeAgentAssets.length)
  await Promise.all(claudeAgentAssets.map(asset => access(asset.file)))
  assert.ok(claudeAgentAssets.some(asset => asset.path === '/apps/claude-agent/style.css'))
})

test('source packaging retains the existing external Claude environment configuration', () => {
  assert.deepEqual(parseClaudeAgentConfig({}), {})
  assert.deepEqual(parseClaudeAgentConfig({ ANYBOX_CLAUDE_AGENT_BINARY: '/existing/bin/claude' }), { executableOverride: '/existing/bin/claude' })
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveClaudeExecutable } from '../dist/applications/claude-agent/core/sdk/executable.js'
import { parseClaudeAgentConfig } from '../dist/applications/claude-agent/config.js'

const files = (...paths) => path => paths.includes(path)

test('the explicit override wins and a missing override is reported with its path', () => {
  const found = resolveClaudeExecutable({ override: '/opt/claude/bin/claude', env: { PATH: '/usr/bin' }, platform: 'darwin', homeDirectory: '/Users/me', isFile: files('/opt/claude/bin/claude', '/usr/bin/claude') })
  assert.deepEqual(found, { path: '/opt/claude/bin/claude', source: 'override' })
  const missing = resolveClaudeExecutable({ override: '/nowhere/claude', env: { PATH: '/usr/bin' }, platform: 'darwin', homeDirectory: '/Users/me', isFile: files('/usr/bin/claude') })
  assert.equal(missing.path, null); assert.equal(missing.error.code, 'claude-binary-missing'); assert.match(missing.error.message, /\/nowhere\/claude/)
})
test('PATH entries are searched in order, then the official installer location, then a clear missing error', () => {
  const env = { PATH: '/usr/local/bin:/Users/me/.local/bin:/usr/bin' }
  assert.deepEqual(resolveClaudeExecutable({ env, platform: 'darwin', homeDirectory: '/Users/me', isFile: files('/Users/me/.local/bin/claude', '/usr/bin/claude') }), { path: '/Users/me/.local/bin/claude', source: 'path' })
  assert.deepEqual(resolveClaudeExecutable({ env: { PATH: '/usr/bin:/bin' }, platform: 'linux', homeDirectory: '/home/me', isFile: files('/home/me/.local/bin/claude') }), { path: '/home/me/.local/bin/claude', source: 'fallback' })
  const missing = resolveClaudeExecutable({ env: { PATH: '/usr/bin' }, platform: 'linux', homeDirectory: '/home/me', isFile: () => false })
  assert.equal(missing.path, null); assert.equal(missing.error.code, 'claude-binary-missing'); assert.match(missing.error.message, /ANYBOX_CLAUDE_AGENT_BINARY/); assert.doesNotMatch(missing.error.message, /Claude Code/)
})
test('Windows resolves PATHEXT candidates and replaces npm launcher shims with the package entry', () => {
  const env = { Path: 'C:\\Tools;C:\\Users\\me\\AppData\\Roaming\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD' }
  const shimDirectory = 'C:\\Users\\me\\AppData\\Roaming\\npm'
  const cli = `${shimDirectory}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`
  assert.deepEqual(resolveClaudeExecutable({ env, platform: 'win32', homeDirectory: 'C:\\Users\\me', isFile: files(`${shimDirectory}\\claude.cmd`, cli) }), { path: cli, source: 'path' })
  assert.deepEqual(resolveClaudeExecutable({ env, platform: 'win32', homeDirectory: 'C:\\Users\\me', isFile: files('C:\\Tools\\claude.exe') }), { path: 'C:\\Tools\\claude.exe', source: 'path' })
  const shimOnly = resolveClaudeExecutable({ env, platform: 'win32', homeDirectory: 'C:\\Users\\me', isFile: files(`${shimDirectory}\\claude.cmd`) })
  assert.equal(shimOnly.error.code, 'claude-binary-shim')
  const noFallback = resolveClaudeExecutable({ env: { Path: 'C:\\Tools' }, platform: 'win32', homeDirectory: 'C:\\Users\\me', isFile: files('C:\\Users\\me\\.local\\bin\\claude') })
  assert.equal(noFallback.error.code, 'claude-binary-missing')
})
test('configuration only accepts a non-empty executable override', () => {
  assert.deepEqual(parseClaudeAgentConfig({}), {})
  assert.deepEqual(parseClaudeAgentConfig({ ANYBOX_CLAUDE_AGENT_BINARY: ' /opt/claude ' }), { executableOverride: '/opt/claude' })
  assert.throws(() => parseClaudeAgentConfig({ ANYBOX_CLAUDE_AGENT_BINARY: '  ' }), TypeError)
  assert.throws(() => parseClaudeAgentConfig({ ANYBOX_CLAUDE_AGENT_BINARY: 'a\0b' }), TypeError)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, readdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const execute = promisify(execFile)
const entry = fileURLToPath(new URL('../dist/entrypoints/anybox-main.js', import.meta.url))
const standalone = fileURLToPath(new URL('../../app-harness/dist/entrypoints/cli-main.js', import.meta.url))

test('public help/version/completion work with all business and config imports forbidden', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'anybox-cli-help-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const guard = join(directory, 'guard.mjs')
  await writeFile(guard, `import { registerHooks } from 'node:module'; registerHooks({ resolve(specifier, context, next) {
    if (/^(@nya\\/|@anybox\\/(models|storage-sqlite|host)|@napi-rs\\/keyring)/.test(specifier) || specifier === 'node:sqlite' || specifier === 'node:fs/promises' || /\\/cli\\/(config|http|commands)\\.js$/.test(new URL(specifier, context.parentURL || 'file:///').pathname)) throw new Error('Business resource import forbidden: ' + specifier);
    return next(specifier, context);
  } });`)
  const env = { ...process.env, HOME: directory, ANYBOX_HARNESS_DATABASE: join(directory, 'business.sqlite'), ANYBOX_HARNESS_CLI_CONFIG: join(directory, 'private', 'config.json'), ANYBOX_HARNESS_PORT: 'invalid' }
  for (const args of [[], ['--help'], ['harness', '--help'], ['harness', 'run', 'start', '--help'], ['--version'], ['completion', 'harness', 'run', '--json'], ['client', '--help'], ['harness-server', '--help']]) {
    const result = await execute(process.execPath, ['--import', guard, entry, ...args], { env, cwd: directory, timeout: 10000 })
    assert.equal(result.stderr, ''); assert.ok(result.stdout.length > 0)
  }
  const help = await execute(process.execPath, ['--import', guard, entry, '--help', '--json'], { env })
  const names = JSON.parse(help.stdout).data.command.commands.map(command => command.name)
  assert.ok(names.includes('harness')); assert.ok(!names.includes('claude-agent')); assert.ok(!names.includes('miao'))
  for (const args of [['--help'], ['run', 'start', '--help'], ['--version', '--json']]) {
    const result = await execute(process.execPath, ['--import', guard, standalone, ...args], { env }); assert.equal(result.stderr, '')
  }
  assert.deepEqual(await readdir(directory), ['guard.mjs'])
})

test('standalone binary shares command metadata and unified entry reports safe usage errors', async t => {
  const unified = await execute(process.execPath, [entry, 'harness', 'run', 'start', '--help', '--json'])
  const own = await execute(process.execPath, [standalone, 'run', 'start', '--help', '--json'])
  assert.deepEqual(JSON.parse(unified.stdout).data.command, JSON.parse(own.stdout).data.command)
  await assert.rejects(execute(process.execPath, [entry, 'harness', 'target', 'add', 'x', '--token=SECRET', '--json']), error => {
    assert.equal(error.code, 2); assert.doesNotMatch(error.stderr, /SECRET/); assert.equal(JSON.parse(error.stderr).type, 'error'); return true
  })
  if (process.platform !== 'win32') {
    const directory = await mkdtemp(join(tmpdir(), 'anybox-cli-bin-')); t.after(() => rm(directory, { recursive: true, force: true }))
    const bin = join(directory, 'anybox'); await symlink(entry, bin)
    assert.match((await execute(process.execPath, [bin, '--version'])).stdout, /anybox 0\.1\.0/)
  }
})

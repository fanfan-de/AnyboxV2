import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

test('the independently distributed Harness package carries its own working native process backend', async t => {
  const run = promisify(execFile)
  // npm's JS entry keeps Windows paths with spaces out of command-shell parsing.
  const npmEntry = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
  const { stdout } = await run(process.execPath, [npmEntry, 'pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: packageRoot, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  const files = JSON.parse(stdout)[0].files.map(file => file.path)
  const executable = `dist/core/platform/native/anybox-process-host${process.platform === 'win32' ? '.exe' : ''}`
  assert.ok(files.includes(executable))
  assert.ok(files.includes('dist/core/platform/native/process-host.json'))
  const manifest = JSON.parse(await readFile(join(packageRoot, 'anybox.app.json'), 'utf8'))
  assert.ok(manifest.runtimeRequirements.computerWorker.platforms.includes(process.platform))
  const copy = await mkdtemp(join(tmpdir(), 'harness-native-package-'))
  t.after(() => rm(copy, { recursive: true, force: true }))
  await writeFile(join(copy, 'package.json'), '{"type":"module"}')
  for (const file of files.filter(file => file.startsWith('dist/core/platform/'))) {
    await mkdir(dirname(join(copy, file)), { recursive: true })
    await cp(join(packageRoot, file), join(copy, file))
  }
  const { spawnManagedProcess, processRuntimeAvailable } = await import(pathToFileURL(join(copy, 'dist/core/platform/process-runtime.js')).href)
  assert.equal(processRuntimeAvailable(), true)
  const process_ = spawnManagedProcess({ executable: process.execPath, args: ['-e', 'process.stdout.write("standalone Harness")'], cwd: copy, env: process.env, stdin: 'ignore' })
  t.after(async () => { process_.terminate(); await process_.done })
  let output = ''
  process_.stdout.on('data', bytes => { output += bytes.toString('utf8') })
  process_.stderr.resume()
  assert.equal((await process_.exited).exitCode, 0)
  await process_.done
  assert.equal(output, 'standalone Harness')
})

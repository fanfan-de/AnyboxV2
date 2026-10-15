import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { validateServiceConfiguration, renderSystemdService, renderLaunchdService, quoteWindowsArgument } from '../dist/platform/services.js'
import { executeServiceCommand, manageService } from '../dist/platform/services-control.js'
import { managedServiceLifetime } from '../dist/entrypoints/service-runner.js'
import { readServicePassword } from '../dist/entrypoints/service-main.js'
import { binaryMatchesTarget, verifyWindowsHelperRuntime } from '../scripts/verify-staged-application.mjs'

const config = (workingDirectory, extra = {}) => ({ formatVersion: 1, name: 'worker-test', role: 'computer-worker', workingDirectory,
  workerDirectory: join(workingDirectory, 'worker data'), environment: { ANYBOX_COMPUTER_WORKER_NAMESPACE: 'anybox.test' }, ...extra })
const launch = { executable: resolve('runtime/node'), runner: resolve('runtime/app/dist/entrypoints/service-runner.js'), serviceHost: resolve('native/anybox-service-host.exe') }
test('private service credentials decode fragmented UTF-8 without exposing invalid input', async () => {
  const password = '私有 密码é😀', bytes = Buffer.from(JSON.stringify({ password }))
  async function* fragments() { for (const byte of bytes) yield Buffer.from([byte]) }
  assert.equal(await readServicePassword(fragments()), password)
  for (const text of ['{"password":private-secret-marker}', 'null', '[]', '"private-secret-marker"']) {
    const error = await readServicePassword([Buffer.from(text)]).catch(error => error)
    assert.ok(error instanceof Error)
    assert.doesNotMatch(error.message, /private-secret-marker/)
    assert.match(error.message, /Service credentials require/)
  }
  await assert.rejects(readServicePassword([Buffer.from('x'.repeat(8193))]), /too large/)
})
test('service config excludes credentials and executable injection while retaining explicit role ownership', () => {
  const good = config(resolve('test data'))
  assert.deepEqual(validateServiceConfiguration(good), good)
  for (const key of ['ANYBOX_API_KEY', 'NODE_OPTIONS', 'PATH']) {
    assert.throws(() => validateServiceConfiguration({ ...good, environment: { [key]: 'secret' } }), /Unsupported non-secret/)
  }
  assert.throws(() => validateServiceConfiguration({ ...good, password: 'secret' }), /Invalid service/)
  assert.throws(() => validateServiceConfiguration({ ...good, name: '../other' }), /Invalid service/)
  assert.throws(() => validateServiceConfiguration({ ...good, workerDirectory: 'relative' }), /absolute/)
})
test('service stop waits for startup and actual cleanup, including repeated stops', async () => {
  let start, finish, entered, closed = 0
  const closing = new Promise(resolve => { entered = resolve })
  const lifetime = managedServiceLifetime(() => new Promise(resolve => { start = resolve }))
  await Promise.resolve()
  const first = lifetime.stop(), second = lifetime.stop()
  assert.equal(first, second)
  start({ close() { closed++; entered(); return new Promise(resolve => { finish = resolve }) } })
  await closing
  assert.equal(closed, 1)
  let settled = false; void first.then(() => { settled = true })
  await Promise.resolve(); assert.equal(settled, false)
  finish(); await first; assert.equal(settled, true)
})
test('service definitions preserve paths and use separate service stop scopes', () => {
  const value = config(resolve('test & spaces')), specification = { ...launch, configuration: resolve('config%".json') }
  const linux = renderSystemdService(value, specification)
  assert.match(linux, /KillMode=control-group/); assert.match(linux, /TimeoutStopSec=infinity/); assert.match(linux, /config%%\\"\.json/)
  assert.doesNotMatch(linux, /PartOf=|BindsTo=/)
  const mac = renderLaunchdService(value, specification, value.workingDirectory)
  assert.match(mac, /&amp;/); assert.match(mac, /&quot;/); assert.match(mac, /<key>ExitTimeOut<\/key><integer>0<\/integer>/)
  assert.equal(quoteWindowsArgument('C:\\data path\\'), '"C:\\data path\\\\"')
})
test('Windows service credentials only enter private stdin and never persisted registration', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anybox-service-'))
  const calls = [], execute = async (executable, args, input) => {
    calls.push({ executable, args, input })
    const data = JSON.parse(input)
    if (data.action === 'identity') return 'DEVICE\\owner\n'
    if (data.action === 'status') return '{"state":"stopped"}'
    return ''
  }
  const options = { home, platform: 'win32', execute, launch }
  try {
    assert.deepEqual(await manageService('status', 'worker-test', undefined, options), { state: 'not-installed', name: 'worker-test' })
    assert.equal(calls.length, 0)
    await manageService('install', config(home, { account: 'DEVICE\\owner' }), 'test-only-password', options)
    assert.ok(calls.some(call => JSON.parse(call.input).password === 'test-only-password'))
    assert.ok(calls.every(call => !JSON.stringify(call.args).includes('test-only-password')))
    const saved = await readFile(join(home, '.anybox/services/worker-test/service.json'), 'utf8')
    assert.doesNotMatch(saved, /test-only-password|password/)
    assert.ok(calls.every(call => JSON.parse(call.input).action !== 'start'))
    await manageService('uninstall', 'worker-test', undefined, options)
    assert.deepEqual(await manageService('status', 'worker-test', undefined, options), { state: 'not-installed', name: 'worker-test' })
  } finally { await rm(home, { recursive: true, force: true }) }
})
test('Windows PowerShell 5 preserves Unicode in private service stdin and output', { skip: process.platform !== 'win32' }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'anybox-service-中文 空格-'))
  const account = '测试设备\\所有者', password = '测试 密码é😀'
  let observed
  const execute = async (executable, args, input) => {
    const data = JSON.parse(input)
    if (data.action === 'identity') return account + '\n'
    assert.equal(data.action, 'install')
    // Exercise the exact production decoder/encoder with an unrecognized action:
    // no branch can register, query, start, or stop any Windows service.
    const probe = { ...data, action: 'encoding-probe' }
    const output = await executeServiceCommand(executable, [...args.slice(0, -1), args.at(-1) + '\n$i | ConvertTo-Json -Compress'], JSON.stringify(probe))
    observed = JSON.parse(output)
    assert.deepEqual(observed, probe)
    return ''
  }
  try {
    await manageService('install', config(home, { account }), password, { home, platform: 'win32', execute, launch })
    assert.equal(observed.account, account); assert.equal(observed.password, password)
    assert.ok(observed.command.includes(home))
  } finally { await rm(home, { recursive: true, force: true }) }
})
test('Windows service status uses PowerShell 5 built-in modules despite an inherited incompatible module path', { skip: process.platform !== 'win32' }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'anybox-service-modules-')), name = `absent-${randomUUID()}`
  const previous = process.env.PSModulePath, modules = join(home, 'foreign-modules'), foreign = join(modules, 'Microsoft.PowerShell.Management')
  try {
    await mkdir(foreign, { recursive: true })
    await writeFile(join(foreign, 'Microsoft.PowerShell.Management.psd1'), "@{ RootModule='foreign.psm1'; ModuleVersion='99.0.0'; PowerShellVersion='7.0'; FunctionsToExport=@('Get-Service') }")
    await writeFile(join(foreign, 'foreign.psm1'), "function Get-Service { throw 'incompatible inherited module loaded' }")
    process.env.PSModulePath = modules
    // Only an isolated local metadata file is written. The actual system call
    // is Get-Service for a random absent name; no SCM registration occurs.
    const directory = join(home, '.anybox/services', name)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'service.json'), JSON.stringify(config(home, { name })))
    assert.deepEqual(await manageService('status', name, undefined, { home }), { name, state: 'not-installed' })
  } finally {
    if (previous === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = previous
    await rm(home, { recursive: true, force: true })
  }
})
test('Linux and macOS service install never start a role and uninstall retains its data', async () => {
  for (const platform of ['linux', 'darwin']) {
    const home = await mkdtemp(join(tmpdir(), 'anybox-service-')), calls = []
    const execute = async (command, args) => { calls.push({ command, args }); return '' }
    const options = { home, platform, execute, launch, uid: 501 }
    try {
      await manageService('install', config(home), undefined, options)
      assert.ok(calls.every(call => !call.args.includes('start') && !call.args.includes('bootstrap') && !call.args.includes('kickstart')))
      const result = await manageService('uninstall', 'worker-test', undefined, options)
      assert.equal(result.dataRetained, true)
      assert.equal((await manageService('status', 'worker-test', undefined, options)).state, 'not-installed')
    } finally { await rm(home, { recursive: true, force: true }) }
  }
})
test('release executable validation checks actual PE, ELF and Mach-O architecture', () => {
  const pe = Buffer.alloc(256); pe.writeUInt16LE(0x5a4d); pe.writeUInt32LE(128, 0x3c); pe.writeUInt32LE(0x4550, 128); pe.writeUInt16LE(0x8664, 132)
  assert.equal(binaryMatchesTarget(pe, 'win32', 'x64'), true); assert.equal(binaryMatchesTarget(pe, 'win32', 'arm64'), false)
  const elf = Buffer.alloc(64); Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(elf); elf.writeUInt16LE(183, 18)
  assert.equal(binaryMatchesTarget(elf, 'linux', 'arm64'), true); assert.equal(binaryMatchesTarget(elf, 'linux', 'x64'), false)
  const mach = Buffer.alloc(64); mach.writeUInt32LE(0xfeedfacf); mach.writeUInt32LE(0x0100000c, 4)
  assert.equal(binaryMatchesTarget(mach, 'darwin', 'arm64'), true); assert.equal(binaryMatchesTarget(mach, 'darwin', 'x64'), false)
})
test('Windows native helpers have no external VC runtime dependency', { skip: process.platform !== 'win32' }, async () => {
  for (const path of ['dist/platform/native/anybox-process-host.exe', 'dist/platform/native/anybox-service-host.exe', 'dist/desktop/native/anybox-dialog-host.exe']) {
    const libraries = await verifyWindowsHelperRuntime(resolve(path))
    assert.ok(libraries.some(name => name.toLowerCase() === 'kernel32.dll'))
  }
})
test('real service runner drains a worker on private control stop and on control-owner EOF', { timeout: 30_000 }, async () => {
  for (const mode of ['stop', 'eof', 'startup-stop']) {
    const directory = await mkdtemp(join(tmpdir(), 'anybox-service-real-')), configuration = join(directory, 'service.json')
    let child
    try {
      await writeFile(configuration, JSON.stringify(config(directory)))
      child = spawn(process.execPath, [resolve('dist/entrypoints/service-runner.js'), configuration, '--stdio-control'], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ANYBOX_COMPUTER_WORKER_NAMESPACE: 'anybox.service-test' },
      })
      let output = '', errors = ''
      child.stderr.on('data', part => { errors += part })
      const ready = new Promise((yes, no) => {
        child.stdout.on('data', part => { output += part; if (output.includes('ANYBOX_SERVICE_READY')) yes() })
        child.once('error', no)
        child.once('exit', code => { if (!output.includes('ANYBOX_SERVICE_READY') && mode !== 'startup-stop') no(new Error(`Worker failed before ready: ${code} ${errors}`)) })
      })
      const exit = new Promise((yes, no) => { child.once('error', no); child.once('exit', (code, signal) => yes({ code, signal })) })
      if (mode !== 'startup-stop') await ready
      if (mode === 'eof') child.stdin.end()
      else child.stdin.end('{"type":"stop"}\n')
      assert.deepEqual(await exit, { code: 0, signal: null }, errors)
      await assert.rejects(access(join(directory, 'worker data/endpoint.json')), { code: 'ENOENT' })
      const receipt = JSON.parse(await readFile(join(directory, 'worker data/shutdown.json'), 'utf8'))
      assert.equal(receipt.error, undefined)
    } finally { if (child && child.exitCode === null) child.kill(); await rm(directory, { recursive: true, force: true }) }
  }
})

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { ensurePrivateDirectory } from '../dist/platform/private-directory.js'
import { createDirectoryIdentityCheck } from '../dist/platform/path-identity.js'
import { resolveBackgroundEntrypoint, resolveBackgroundRuntime } from '../dist/platform/runtime-path.js'
import { ceilingPermits } from '../dist/applications/harness/core/computer/worker-attachments-domain.js'
import { acquireImageDirectoryLock } from '../dist/applications/harness/core/image/directory-lock.js'

async function temporary(t) {
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'anybox-platform-files-')))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  return directory
}

test('role directories protect current-user local authentication material using native permissions', async t => {
  const directory = await temporary(t), path = join(directory, '私有 worker space')
  assert.equal(await ensurePrivateDirectory(path), await fs.realpath(path))
  await fs.writeFile(join(path, 'endpoint.json'), '{}')
  await ensurePrivateDirectory(path)
  if (process.platform === 'win32') {
    const script = `$acl=[IO.Directory]::GetAccessControl($env:ANYBOX_TEST_DIRECTORY); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { @{sid=$_.IdentityReference.Value;type=$_.AccessControlType.ToString();inherited=$_.IsInherited} }); @{protected=$acl.AreAccessRulesProtected;sid=$sid;rules=$rules} | ConvertTo-Json -Compress -Depth 4`
    const { stdout } = await promisify(execFile)(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, env: { ...process.env, ANYBOX_TEST_DIRECTORY: path } })
    const acl = JSON.parse(stdout)
    assert.equal(acl.protected, true)
    assert.ok(acl.rules.some(rule => rule.sid === acl.sid))
    assert.ok(acl.rules.every(rule => !rule.inherited && rule.type === 'Allow' && [acl.sid, 'S-1-5-18'].includes(rule.sid)))
  } else assert.equal((await fs.stat(path)).mode & 0o777, 0o700)
  const alias = join(directory, 'alias')
  await fs.symlink(path, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(ensurePrivateDirectory(alias), /private-directory-unavailable/)
})

test('directory ceilings use actual ancestry and retain case-sensitive directory distinctions', async t => {
  const directory = await temporary(t), allowed = join(directory, 'Workspace'), child = join(allowed, 'child'), outside = join(directory, 'Workspace-other')
  await fs.mkdir(child, { recursive: true }); await fs.mkdir(outside)
  const scope = { kind: 'computer', projects: [allowed], tools: ['anybox.bash'] }
  const permits = path => ceilingPermits(scope, { path, toolId: 'anybox.bash' }, createDirectoryIdentityCheck())
  assert.equal(permits(allowed), true); assert.equal(permits(child), true)
  assert.equal(permits(outside), false); assert.equal(permits(join(directory, 'missing')), false)
  assert.equal(ceilingPermits(scope, { path: child, toolId: 'anybox.apply_patch' }, createDirectoryIdentityCheck()), false)
  const alias = join(allowed, 'outside-link')
  await fs.symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(permits(alias), false, 'a junction or symlink cannot turn an outside directory into a descendant')
  const caseVariant = join(directory, 'workspace')
  await fs.mkdir(caseVariant, { recursive: true })
  const originalId = await fs.stat(allowed, { bigint: true }), variantId = await fs.stat(caseVariant, { bigint: true })
  assert.equal(permits(caseVariant), originalId.dev === variantId.dev && originalId.ino === variantId.ino)
})

test('a Windows directory owner can protect an inherited Modify-only directory without WRITE_OWNER', { skip: process.platform !== 'win32' }, async t => {
  const directory = await temporary(t), path = join(directory, 'modify-only-worker')
  await fs.mkdir(path)
  // An ordinary workspace may grant Modify rather than FullControl. Its owner
  // can set the DACL but cannot redundantly set the owner through WRITE_OWNER.
  const script = `$path=$env:ANYBOX_TEST_DIRECTORY; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true,$false); $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'Modify','ContainerInherit,ObjectInherit','None','Allow')); $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-18'),'FullControl','ContainerInherit,ObjectInherit','None','Allow')); [IO.Directory]::SetAccessControl($path,$acl)`
  await promisify(execFile)(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, env: { ...process.env, ANYBOX_TEST_DIRECTORY: path } })
  assert.equal(await ensurePrivateDirectory(path), await fs.realpath(path))
  await fs.writeFile(join(path, 'endpoint.json'), '{}')
  assert.equal(await fs.readFile(join(path, 'endpoint.json'), 'utf8'), '{}')
})

test('permission errors without an existing image lock are not treated as lock contention', async t => {
  const directory = await temporary(t), images = join(directory, 'images'), original = fs.rename
  fs.rename = async () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) }; syncBuiltinESMExports()
  try { await assert.rejects(acquireImageDirectoryLock(images), { code: 'asset-unavailable' }) }
  finally { fs.rename = original; syncBuiltinESMExports() }
  assert.deepEqual(await fs.readdir(directory), [])
})

test('background runtime resolves a real independent runtime and entrypoint without Electron RunAsNode', async t => {
  const directory = await temporary(t), previous = process.env.ANYBOX_RUNTIME_DIRECTORY
  const restore = () => { if (previous === undefined) delete process.env.ANYBOX_RUNTIME_DIRECTORY; else process.env.ANYBOX_RUNTIME_DIRECTORY = previous }
  t.after(restore)
  delete process.env.ANYBOX_RUNTIME_DIRECTORY
  assert.equal(resolveBackgroundRuntime().executable, process.execPath)
  assert.ok(resolveBackgroundEntrypoint('computer-worker-main.js').endsWith(join('dist', 'entrypoints', 'computer-worker-main.js')))
  process.env.ANYBOX_RUNTIME_DIRECTORY = directory
  assert.throws(() => resolveBackgroundRuntime(), /background-runtime-unavailable/)
  const executable = join(directory, process.platform === 'win32' ? 'node.exe' : 'node')
  await fs.writeFile(executable, '')
  await fs.mkdir(join(directory, 'app/dist/entrypoints'), { recursive: true })
  const entrypoint = join(directory, 'app/dist/entrypoints/computer-worker-main.js')
  await fs.writeFile(entrypoint, '')
  assert.deepEqual(resolveBackgroundRuntime(), { executable, prefixArgs: [] })
  assert.equal(resolveBackgroundEntrypoint('computer-worker-main.js'), entrypoint)
  assert.throws(() => resolveBackgroundEntrypoint('../private.js'), /background-entrypoint-invalid/)
})

test('source Electron workers use the source launcher Node and fail closed without an explicit runtime', async t => {
  const directory = await temporary(t)
  const saved = Object.fromEntries(['ANYBOX_RUNTIME_DIRECTORY', 'ANYBOX_DEVELOPMENT_NODE_EXECUTABLE'].map(key => [key, process.env[key]]))
  const electron = Object.getOwnPropertyDescriptor(process.versions, 'electron'), resources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    if (electron) Object.defineProperty(process.versions, 'electron', electron); else delete process.versions.electron
    if (resources) Object.defineProperty(process, 'resourcesPath', resources); else delete process.resourcesPath
  })
  Object.defineProperty(process.versions, 'electron', { configurable: true, value: 'development-fixture' })
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: directory })
  delete process.env.ANYBOX_RUNTIME_DIRECTORY; delete process.env.ANYBOX_DEVELOPMENT_NODE_EXECUTABLE
  assert.throws(() => resolveBackgroundRuntime(), /background-runtime-unavailable/)
  process.env.ANYBOX_DEVELOPMENT_NODE_EXECUTABLE = 'node.exe'
  assert.throws(() => resolveBackgroundRuntime(), /background-runtime-unavailable/)
  process.env.ANYBOX_DEVELOPMENT_NODE_EXECUTABLE = process.execPath
  assert.deepEqual(resolveBackgroundRuntime(), { executable: process.execPath, prefixArgs: [] })
  assert.ok(resolveBackgroundEntrypoint('computer-worker-main.js').endsWith(join('dist', 'entrypoints', 'computer-worker-main.js')))
})

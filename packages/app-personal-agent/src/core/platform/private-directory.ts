import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
// The path is passed as an environment value, never interpolated into PowerShell.
const protectDirectory = `
$ErrorActionPreference = 'Stop'
$path = $env:ANYBOX_PRIVATE_DIRECTORY_TARGET
$attributes = [IO.File]::GetAttributes($path)
if (-not ($attributes -band [IO.FileAttributes]::Directory) -or ($attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'invalid directory' }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$previousOwner = [IO.Directory]::GetAccessControl($path).GetOwner([Security.Principal.SecurityIdentifier])
$acl = [Security.AccessControl.DirectorySecurity]::new()
if ($previousOwner -ne $sid) { $acl.SetOwner($sid) }
$acl.SetAccessRuleProtection($true, $false)
foreach ($identity in @($sid, $system)) {
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit', [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
}
[IO.Directory]::SetAccessControl($path, $acl)
$actual = [IO.Directory]::GetAccessControl($path)
if ($actual.GetOwner([Security.Principal.SecurityIdentifier]) -ne $sid) { throw 'unexpected directory owner' }
if (-not $actual.AreAccessRulesProtected) { throw 'unprotected directory' }
$rules = $actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
$ownerGranted = $false
foreach ($rule in $rules) {
  if ($rule.IdentityReference -eq $sid -and $rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { $ownerGranted = $true }
  if ($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or ($rule.IdentityReference -ne $sid -and $rule.IdentityReference -ne $system)) { throw 'unexpected directory access' }
}
if (-not $ownerGranted) { throw 'missing owner access' }
`

/** OS adapter for a Harness worker-owned directory containing local authentication material. */
export async function ensurePrivateDirectory(input: string): Promise<string> {
  const path = resolve(input)
  if (dirname(path) === path) throw new Error('private-directory-invalid')
  try {
    await mkdir(path, { recursive: true, mode: 0o700 })
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('invalid directory')
    const canonical = await realpath(path)
    if (process.platform === 'win32') {
      const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      await run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(protectDirectory, 'utf16le').toString('base64')], {
        windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024,
        env: { ...process.env, ANYBOX_PRIVATE_DIRECTORY_TARGET: canonical },
      })
    } else await chmod(canonical, 0o700)
    return canonical
  } catch { throw new Error('private-directory-unavailable') }
}

import { execFile } from 'node:child_process'
import { access, mkdir, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
export async function buildServiceNative(root, outputDirectory = join(root, 'dist/platform/native')) {
  if (process.platform !== 'win32') return undefined
  await mkdir(outputDirectory, { recursive: true })
  const source = join(root, 'src/platform/native/service-host.rs'), output = join(outputDirectory, 'anybox-service-host.exe')
  const temporary = output + '.building.exe'
  let env = { ...process.env }
  try { await run('where.exe', ['link.exe'], { env, windowsHide: true }) }
  catch {
    const vswhere = join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft Visual Studio/Installer/vswhere.exe')
    await access(vswhere)
    const { stdout } = await run(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-find', `VC/Tools/MSVC/**/bin/Hostx64/${process.arch === 'arm64' ? 'arm64' : 'x64'}/link.exe`], { windowsHide: true })
    const linker = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)
    if (!linker) throw new Error('Windows native service host requires MSVC build tools')
    env.ANYBOX_SERVICE_LINKER = linker
  }
  try {
    await run('rustc', ['--edition=2021', '-C', 'opt-level=2', '-C', 'strip=symbols', '-C', 'target-feature=+crt-static', ...(env.ANYBOX_SERVICE_LINKER ? ['-C', `linker=${env.ANYBOX_SERVICE_LINKER}`] : []), source, '-o', temporary], { cwd: root, env, windowsHide: true })
    await run(temporary, ['--version'], { windowsHide: true })
    await rename(temporary, output)
    return output
  } finally { await rm(temporary, { force: true }) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const output = await buildServiceNative(root)
  if (output) console.log(output)
}

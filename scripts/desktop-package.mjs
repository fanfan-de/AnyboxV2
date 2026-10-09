/** Package a self-contained app without copying development symlinks. */
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { api, utils } from '@electron-forge/core'
import forgeConfig from '../forge.config.mjs'
import { run, stageApplication } from './stage-application.mjs'
import { verifyDesktopNativeFiles } from './verify-staged-application.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Desktop v1 packages must be built on macOS arm64')
const base = join(root, 'artifacts/desktop'), output = join(base, 'out')
await mkdir(base, { recursive: true })
const stage = await mkdtemp(join(base, '.stage-'))
const assertPortable = async directory => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Desktop staging contains a symlink: ${path}`)
    if (entry.isDirectory()) await assertPortable(path)
  }
}
try {
  const { manifest } = await stageApplication(root, stage, { desktop: true, build: !process.argv.includes('--no-build') })
  await run(process.execPath, [join(root, 'scripts/build-desktop-native.mjs'),
    '--output', join(stage, 'dist/desktop/native/mac-dialog.node')], root)
  await run('npm', ['ci', '--omit=dev', '--include=optional', '--no-audit', '--no-fund'], stage, { env: { ...process.env, SHARP_IGNORE_GLOBAL_LIBVIPS: '1' } })
  await rm(join(stage, 'node_modules/.bin'), { recursive: true, force: true })
  await assertPortable(stage)
  await stat(join(stage, 'dist/entrypoints/desktop-main.js'))
  if (manifest.devDependencies.electron !== '44.5.1') throw new Error('Desktop runtime must be pinned to Electron 44.5.1')
  utils.registerForgeConfigForDirectory(stage, forgeConfig)
  const options = { dir: stage, arch: 'arm64', platform: 'darwin', outDir: output, interactive: false }
  const results = process.argv.includes('--make') ? await api.make(options) : await api.package(options)
  await verifyDesktopNativeFiles(join(output, 'Anybox-darwin-arm64/Anybox.app'))
  process.stdout.write(`Anybox desktop artifacts: ${output}\n`)
  for (const result of results) for (const artifact of result.artifacts ?? [result.packagedPath]) process.stdout.write(`${artifact}\n`)
} finally {
  utils.unregisterForgeConfigForDirectory(stage)
  await rm(stage, { recursive: true, force: true })
}

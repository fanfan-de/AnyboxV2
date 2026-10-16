import { spawnSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

// No downloads or global installation. Use an existing D2 CLI and local CJK font.
const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`)
  return args[index + 1]
}
const d2 = option('--d2') ?? 'd2'
const font = option('--font') ?? (process.platform === 'win32' ? 'C:/Windows/Fonts/simhei.ttf' : undefined)
const family = option('--font-family') ?? (process.platform === 'win32' ? 'SimHei' : undefined)
if (!font || !family) throw new Error('Provide --font <CJK.ttf> and --font-family <installed family name>')
if (!/^[\p{L}\p{N} _-]+$/u.test(family)) throw new Error('Use a plain installed font family name')
const directory = dirname(fileURLToPath(import.meta.url))
const run = args => {
  const result = spawnSync(d2, args, { stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`D2 failed with status ${result.status}`)
}
run(['--version'])
for (const name of (await readdir(directory)).filter(name => name.endsWith('.d2')).sort()) {
  const source = join(directory, name)
  const svg = source.replace(/\.d2$/, '.svg')
  const png = source.replace(/\.d2$/, '.png')
  run(['validate', source])
  run(['fmt', '--check', source])
  run(['--font-regular', font, '--font-bold', font, '--font-semibold', font,
    '--elk-nodeNodeBetweenLayers', '40', source, svg])
  // SVG retains D2's embedded font subsets. librsvg does not load web fonts,
  // so rasterization uses the same installed font family explicitly.
  const rasterInput = (await readFile(svg, 'utf8')).replace(/font-family\s*:[^;}]+/g, `font-family: ${family}`)
  const output = await sharp(Buffer.from(rasterInput)).png().toFile(png)
  console.log(`${name}: ${output.width} × ${output.height} → SVG + PNG`)
}

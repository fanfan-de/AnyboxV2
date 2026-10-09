/** Emit the portable Markdown parser as one application-owned browser module. */
import { build } from 'esbuild'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = join(root, 'dist/applications/harness/web/vendor/markdown-parser.js')
const bundled = await build({
  absWorkingDir: root,
  stdin: {
    contents: `import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'
export function parseMarkdown(source) {
  return fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
}
`,
    resolveDir: root,
    sourcefile: 'markdown-parser.js',
    loader: 'js',
  },
  outfile: output,
  bundle: true,
  platform: 'browser',
  // Choose portable entity decoding instead of the DOM-only browser fallback.
  conditions: ['worker'],
  format: 'esm',
  target: 'es2022',
  charset: 'utf8',
  legalComments: 'eof',
  minify: true,
  metafile: true,
  write: false,
})
for (const file of Object.values(bundled.metafile.outputs)) {
  if (file.imports.length) throw new Error('Markdown browser parser must not retain runtime imports')
}
const packageDirectories = new Set()
for (const input of Object.keys(bundled.metafile.inputs)) {
  const path = input.replaceAll('\\', '/')
  const owner = [...path.matchAll(/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+(?=\/|$)/g)].at(-1)
  if (owner) packageDirectories.add(resolve(root, path.slice(0, owner.index + owner[0].length)))
}
const licenses = await Promise.all([...packageDirectories].map(async directory => {
  const [manifestText, entries] = await Promise.all([readFile(join(directory, 'package.json'), 'utf8'), readdir(directory, { withFileTypes: true })])
  const manifest = JSON.parse(manifestText)
  const files = entries.filter(entry => entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(entry.name)).map(entry => entry.name).sort()
  if (!manifest.name || !manifest.version || !files.length) throw new Error(`Missing third-party package or license metadata: ${directory}`)
  const texts = await Promise.all(files.map(async file => `--- ${file} ---\n${(await readFile(join(directory, file), 'utf8')).trimEnd()}`))
  return { name: `${manifest.name}@${manifest.version}`, text: `${manifest.name}@${manifest.version}\nDeclared license: ${typeof manifest.license === 'string' ? manifest.license : JSON.stringify(manifest.license) ?? 'unspecified'}\n\n${texts.join('\n\n')}` }
}))
licenses.sort((first, second) => first.name < second.name ? -1 : first.name > second.name ? 1 : 0)
await mkdir(dirname(output), { recursive: true })
for (const file of bundled.outputFiles) await writeFile(file.path, file.contents)
await writeFile(join(dirname(output), 'markdown-parser.LICENSE.txt'), `Third-party licenses for markdown-parser.js\n\n${licenses.map(license => license.text).join('\n\n========================================\n\n')}\n`)

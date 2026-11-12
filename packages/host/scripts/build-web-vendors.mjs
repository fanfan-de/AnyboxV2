/** Bundle the shell's own translation engine; applications ship their independent copy. */
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const output = new URL('../dist/web/vendor/', import.meta.url)
await mkdir(output, { recursive: true })
await build({ stdin: { contents: "export { createInstance } from 'i18next'", resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'js' },
  outfile: fileURLToPath(new URL('i18next.js', output)), bundle: true, platform: 'browser', format: 'esm', target: 'es2022', charset: 'utf8', minify: true, legalComments: 'eof' })
const manifestUrl = import.meta.resolve('i18next/package.json')
const manifest = JSON.parse(await readFile(new URL(manifestUrl), 'utf8'))
const license = await readFile(new URL('./LICENSE', manifestUrl), 'utf8')
await writeFile(new URL('i18next.LICENSE.txt', output), `i18next@${manifest.version}\nDeclared license: ${manifest.license}\n\n${license}`)

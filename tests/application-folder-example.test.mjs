import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readApplicationDirectory } from '../packages/host/dist/package-management/directory.js'
import { verifyApplicationPackage } from '../packages/host/dist/package-management/archive.js'
import { prepareApplicationArchive } from '../packages/host/dist/package-management/preparation.js'

test('the documented Agent application folder verifies and implements the complete mounted lifecycle', async t => {
  const documentText = await readFile(new URL('../docs/application-development.md', import.meta.url), 'utf8')
  const script = documentText.match(/node --input-type=module <<'JS'\n([\s\S]*?)\nJS\n/)?.[1]
  assert.ok(script, 'The runnable Agent folder creation example must remain in the application guide')
  const temporary = await mkdtemp(join(tmpdir(), 'anybox-folder-guide-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module'], { cwd: temporary, stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', bytes => { stderr += bytes })
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr)))
    child.stdin.end(script)
  })
  const directory = join(temporary, 'notes')
  assert.deepEqual((await readdir(directory)).sort(), ['manifest.json', 'payload'])
  const verified = verifyApplicationPackage(await readApplicationDirectory(directory), {
    trustedPublishers: [], allowUnsignedLocal: true,
    target: { os: process.platform, arch: process.arch }, applicationApiVersion: '0.1.0',
  })
  await prepareApplicationArchive(verified)
  const source = await readFile(join(directory, 'payload/web/app.js'))
  const application = await import(`data:text/javascript;base64,${source.toString('base64')}`)
  const previousDocument = globalThis.document
  t.after(() => { globalThis.document = previousDocument })
  let editor, children = []
  globalThis.document = { createElement(tag) { assert.equal(tag, 'textarea'); return editor = { value: '', setAttribute() {} } } }
  const mounted = await application.mount({ replaceChildren(...elements) { children = elements } })
  assert.equal(children[0], editor); assert.equal(mounted.canClose(), true)
  mounted.setActive(false, 'select'); mounted.setActive(true, 'open')
  editor.value = 'unsaved note'; assert.equal(mounted.canClose(), false)
  await mounted.dispose(); assert.deepEqual(children, [])
})

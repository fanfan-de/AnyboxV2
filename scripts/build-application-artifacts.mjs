/** Produce the D1.2 empty host and separately signed, offline-complete applications. */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { stageMinimalHost, buildApplicationDirectory, currentArtifactTarget } from './application-artifacts.mjs'
import { buildDesktopNative } from './build-desktop-native.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2), values = new Map(), switches = new Set()
for (let index = 0; index < args.length; index++) {
  const argument = args[index]
  if (['--host-only', '--skip-build', '--archive', '--help', '-h'].includes(argument)) switches.add(argument)
  else if (['--out', '--signing-key', '--key-id'].includes(argument) && args[index + 1] && !args[index + 1].startsWith('--')) values.set(argument, args[++index])
  else throw new Error(`Unknown or incomplete argument: ${argument}`)
}
if (switches.has('--help') || switches.has('-h')) {
  process.stdout.write(`Usage: node scripts/build-application-artifacts.mjs --out <empty-directory> [--host-only] [--skip-build] [--archive]\n  --signing-key <private-pem> --key-id <trusted-id>  Optional directory signing; both required with --archive\n  --archive  Also emit optional signed .anybox-app ZIP files for distribution\nBuild on the target OS/architecture with prebuilt production dependencies already present.\nApplication directories can be installed directly with explicit local trust, without signing or compression.\nThe empty Node host and application payloads need no npm install on the destination.\nNode itself is externally provisioned at D1.2; self-contained runtime distribution is D4.\nNo development signing key or trust-on-first-use policy is included.\n`)
} else {
  const output = resolve(values.get('--out') ?? join(root, 'artifacts', `d1.2-${process.platform}-${process.arch}`))
  const hostOnly = switches.has('--host-only')
  if (values.has('--signing-key') !== values.has('--key-id') || switches.has('--archive') && !values.has('--signing-key')) throw new Error('Provide both --signing-key and --key-id when signing; --archive requires signing')
  const privateKey = hostOnly || !values.has('--signing-key') ? undefined : await readFile(resolve(values.get('--signing-key')), 'utf8')
  await mkdir(output, { recursive: true })
  if ((await readdir(output)).length) throw new Error('Artifact output directory must be empty')
  if (!switches.has('--skip-build')) await new Promise((resolveBuild, reject) => {
    const child = spawn('npm', ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
    child.once('error', reject); child.once('exit', code => code === 0 ? resolveBuild() : reject(new Error(`Build exited ${code}`)))
  })
  if (!hostOnly && !switches.has('--skip-build') && process.platform === 'darwin' && process.arch === 'arm64') await buildDesktopNative(root)
  const target = currentArtifactTarget(), host = await stageMinimalHost(root, join(output, 'host'), { target }), applications = []
  let publicKey
  if (!hostOnly) for (const name of ['app-harness', 'app-claude-agent']) {
    const directory = `${name}-${target.os}-${target.arch}`
    const result = await buildApplicationDirectory(root, join(output, directory), name, { privateKey, keyId: values.get('--key-id'), target })
    let archive
    if (switches.has('--archive')) {
      const { createApplicationArchiveZip } = await import('@anybox/host/package-management/archive')
      const { createHash } = await import('node:crypto')
      const bytes = createApplicationArchiveZip(result.entries), file = `${result.manifest.appId}-${result.manifest.version}-${target.os}-${target.arch}.anybox-app`
      await writeFile(join(output, file), bytes)
      archive = { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    }
    publicKey = result.publicKey
    applications.push({ appId: result.manifest.appId, version: result.manifest.version, directory,
      bytes: result.bytes.length, sha256: result.sha256, packages: result.packages.length, ...(archive ? { archive } : {}) })
  }
  if (!hostOnly) await writeFile(join(output, 'publisher-policy.example.json'), JSON.stringify({ schemaVersion: 1,
    publishers: publicKey ? [{ publisher: 'anybox', keyId: values.get('--key-id'), publicKey, appIds: ['agent', 'claude-agent'] }] : [],
    applications: {
      agent: { assetPrefixes: ['/applications/harness/', '/apps/agent/'], webLegacyRoutes: ['#/harness/', '#/products/agent', '#/projects/'], routePrefixes: [
        '/api/client/v1/connections', '/api/client/v1/local', '/api/connections',
        ...['models', 'prompts', 'tools', 'agents', 'projects', 'sessions', 'runs', 'changes'].map(name => `/api/v1/${name}`)] },
      'claude-agent': { assetPrefixes: ['/applications/claude-agent/', '/apps/claude-agent/'], routePrefixes: [] },
    },
  }, null, 2) + '\n')
  await writeFile(join(output, 'artifacts.json'), JSON.stringify({ schemaVersion: 1, target,
    host: { directory: 'host', packages: host.packages.length }, applications,
    signing: !publicKey ? null : { keyId: values.get('--key-id'), trust: 'Configure the corresponding public key and authorized app IDs explicitly on the verifying host.' } }, null, 2) + '\n')
  process.stdout.write(`D1.2 artifacts: ${output}\n${host.packages.length} host production packages; ${applications.length} ${publicKey ? 'signed' : 'local'} application directories${switches.has('--archive') ? ' with optional ZIP archives' : ''}.\n`)
}

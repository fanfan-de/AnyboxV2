/** Executed by the product's Node with an OS-only PATH, never the developer's Node. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
const runtime = process.argv[2], base = pathToFileURL(join(runtime, 'app/dist/'))
const { connectLocalComputerWorker } = await import(new URL('applications/harness/core/computer/worker-client.js', base))
const { computerDeclarationDigest } = await import(new URL('applications/harness/core/computer/operations-domain.js', base))
const { getToolById } = await import(new URL('applications/harness/core/tool/catalog.js', base))
const directory = await mkdtemp(join(tmpdir(), 'anybox-packaged-中文 '))
const port = connectLocalComputerWorker({ directory: join(directory, 'worker'), startupTimeoutMs: 30_000 })
const owner = { runId: 'packaged-run', runOwnerEpoch: 1, attachmentId: 'local:computer' }
const finished = async input => {
  for (let attempt = 0; attempt < 2000; attempt++) {
    const result = await port.get(input)
    if (result && ['succeeded', 'failed', 'cancelled', 'outcome-unknown'].includes(result.state)) {
      assert.equal(result.state, 'succeeded', JSON.stringify(result.error)); return result
    }
    await delay(20)
  }
  throw new Error('Packaged operation did not settle')
}
try {
  const info = await port.info()
  assert.equal(info.platform, process.platform)
  await port.claimRun(owner)
  let number = 0
  const tool = async (toolId, args) => {
    const operationId = `tool-${++number}`, entry = getToolById(toolId)
    const declaration = { schemaVersion: 1, operationId, ...owner, sessionId: 'session', projectId: 'project',
      tool: { toolId, version: entry.version, definition: entry.definition }, request: { id: operationId, name: entry.definition.name, arguments: args },
      workspaceId: 'workspace', workspaceRevision: 0, computerId: 'local', spec: { providerId: 'local', platform: process.platform, architecture: process.arch } }
    const binding = { bindingId: 'binding', reservationId: 'reservation', workspaceId: 'workspace', projectId: 'project', scopeId: owner.runId,
      computerId: 'local', computerInstanceId: `${info.workerId}:${info.bootId}`, instanceGeneration: 1, workspaceEpoch: 1, revision: 0, path: directory, preparedAt: 'now' }
    const input = { ...owner, operationId, kind: 'tool', declaration, declarationDigest: computerDeclarationDigest(declaration), binding, workerBootId: info.bootId }
    await port.submit(input)
    return (await finished(input)).observation.result
  }
  await tool('claude-code.Write', { file_path: '中文 space.txt', content: 'packaged-one\n' })
  await tool('codex.apply_patch', { patch: '*** Begin Patch\n*** Update File: 中文 space.txt\n@@\n-packaged-one\n+packaged-two\n*** End Patch' })
  assert.equal(await readFile(join(directory, '中文 space.txt'), 'utf8'), 'packaged-two\n')
  const read = await tool('claude-code.Read', { file_path: '中文 space.txt' })
  assert.match(JSON.stringify(read), /packaged-two/)
  const grep = await tool('claude-code.Grep', { pattern: 'packaged-two', output_mode: 'content' })
  assert.match(JSON.stringify(grep), /packaged-two/)
  const command = await tool('codex.exec_command', { cmd: process.platform === 'win32' ? "Write-Output 'native-powershell'" : "printf 'native-unix'", yield_time_ms: 30_000 })
  assert.equal(command.exit_code, 0); assert.match(command.output, /native-powershell|native-unix/)
  const bash = await tool('anybox.bash', { command: "printf 'native-bash'" })
  assert.match(JSON.stringify(bash), /native-bash/)
  const close = { ...owner, operationId: 'close', kind: 'close-scope', declarationDigest: 'close' }
  await port.submit(close); await finished(close)
  console.log(JSON.stringify({ passed: true, platform: process.platform, architecture: process.arch, runtime: process.version,
    worker: true, write: true, read: true, patch: true, grep: true, defaultShell: true, bash: true, cleanup: true }))
} finally {
  try { await port.shutdown() } finally { await port.closeObserver(); await rm(directory, { recursive: true, force: true }) }
}

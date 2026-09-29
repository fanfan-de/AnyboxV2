/** Local browser acceptance: real storage/codecs, in-memory credentials and no external transport. */
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { startCatalogModelsHost } from './catalog-models-host.mjs'

const host = await startCatalogModelsHost({ initialRefresh: false, protocolFetch: async (_url, _init, { body }) => {
  const text = JSON.stringify(body).includes('SNAPSHOT-CONTENT') ? '已读取引用文件中的 SNAPSHOT-CONTENT。' : '已收到消息。'
  return new Response(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }] }), { headers: { 'content-type': 'application/json' } })
} })
try {
  const settings = host.root.get('models.settings'), protocolId = 'chat-completions'
  const capabilities = { tools: { support: 'unsupported' }, streaming: { support: 'unsupported' }, reasoning: { support: 'unsupported' }, imageInput: { support: 'unsupported' } }
  const provider = await settings.createProvider({ name: '文件引用验收', connectionHints: { protocolIds: [protocolId] } })
  const connection = await settings.createConnection({ providerDefinitionId: provider.id, name: '本地模型替身', enabled: true, protocolId, baseUrl: 'https://mock.invalid/v1', auth: 'none', timeoutMs: 5000 })
  const definition = await settings.createModel({ providerId: provider.id, name: '文件引用验收', remoteModelId: 'files', capabilities,
    controls: { temperature: 'unknown' }, modalities: { input: ['text'], output: ['text'] }, limits: {}, connectionHints: { protocolIds: [protocolId] } })
  const configuration = await settings.createConfiguration({ connectionId: connection.id, modelDefinitionId: definition.id, name: '文件引用验收', enabled: true, baseline: true, capabilities,
    parameters: { protocolId, formatVersion: 1, value: {} } })
  const session = await host.harness.createSession(host.project.id, 'assistant', configuration.id)
  await mkdir(join(host.project.path, 'src'), { recursive: true })
  await writeFile(join(host.project.path, 'src/example.ts'), '// SNAPSHOT-CONTENT\nexport const example = 42\n// final line\n')
  await writeFile(join(host.project.path, '.hidden.txt'), 'hidden file\n')
  process.stdout.write(JSON.stringify({ url: host.web.url, directory: host.directory, projectId: host.project.id, sessionId: session.id }) + '\n')
  process.once('SIGINT', () => { void host.close() }); process.once('SIGTERM', () => { void host.close() })
} catch (error) { await host.close(); throw error }

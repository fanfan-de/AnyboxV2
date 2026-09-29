/** Disposable browser acceptance host with real native codecs and strictly local mock providers. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { startCatalogModelsHost } from './catalog-models-host.mjs'

const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const protocols = ['responses', 'anthropic-messages', 'gemini-interactions']
let requests = 0
const host = await startCatalogModelsHost({ initialRefresh: false, protocolFetch: async (url, _init, { body }) => {
  assert.ok(body)
  assert.doesNotMatch(JSON.stringify(body), /urn:anybox:resource:/)
  const messages = body.messages ?? body.input
  const images = messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => ['image', 'input_image'].includes(block.type)) : [])
  for (const image of images) {
    const data = image.type === 'input_image' ? image.image_url.split(',')[1] : image.source?.data ?? image.data
    assert.ok(data); assert.ok((await sharp(Buffer.from(data, 'base64')).metadata()).width)
  }
  const text = `图片验收通过：${images.length} 张；请求 ${++requests}`
  if (url.endsWith('/responses')) return json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] })
  if (url.endsWith('/messages')) return json({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] })
  return json({ id: `interaction-${requests}`, status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text }] }] })
} })
try {
  const settings = host.root.get('models.settings'), sessions = []
  for (const protocolId of protocols) {
    const provider = await settings.createProvider({ name: protocolId, connectionHints: { protocolIds: [protocolId] } })
    const connection = await settings.createConnection({ providerDefinitionId: provider.id, name: protocolId, enabled: true, protocolId,
      baseUrl: `https://mock.invalid/${protocolId}`, auth: 'none', timeoutMs: 5000 })
    const capabilities = { tools: { support: 'unsupported' }, streaming: { support: 'unsupported' }, reasoning: { support: 'unsupported' }, imageInput: { support: 'supported' } }
    const definition = await settings.createModel({ providerId: provider.id, name: `${protocolId} 图片验收`, remoteModelId: 'vision-test', capabilities,
      controls: { temperature: 'unknown' }, modalities: { input: ['text', 'image'], output: ['text'] }, limits: {}, connectionHints: { protocolIds: [protocolId] } })
    const configuration = await settings.createConfiguration({ connectionId: connection.id, modelDefinitionId: definition.id, name: `${protocolId} 图片验收`, enabled: true, baseline: true, capabilities,
      parameters: { protocolId, formatVersion: 1, value: protocolId === 'anthropic-messages' ? { max_tokens: 4096 } : {} } })
    const session = await host.harness.createSession(host.project.id, 'assistant', configuration.id)
    sessions.push({ protocolId, sessionId: session.id })
  }
  const imagePath = join(host.directory, 'browser-red.png')
  await writeFile(imagePath, await sharp({ create: { width: 64, height: 64, channels: 3, background: 'red' } }).png().toBuffer())
  process.stdout.write(JSON.stringify({ url: host.web.url, directory: host.directory, imagePath, sessions }) + '\n')
  process.once('SIGINT', () => { void host.close() })
  process.once('SIGTERM', () => { void host.close() })
} catch (error) { await host.close(); throw error }

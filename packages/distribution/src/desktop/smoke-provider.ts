import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'

/** Offline provider fixture for explicit desktop QA; never configured by normal startup. */
export async function createSmokeProvider() {
  const held = new Set<ServerResponse>()
  const answer = (response: ServerResponse, value: unknown) => {
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value))
  }
  const final = () => ({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Desktop smoke completed' } }] })
  const tool = (name: string, args: object) => ({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
    tool_calls: [{ id: `smoke-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url !== '/chat/completions' || request.method !== 'POST') { response.writeHead(404); response.end(); return }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: { role: string }[] }
      if (JSON.stringify(body.messages).includes('SMOKE-HOLD')) {
        held.add(response); response.once('close', () => held.delete(response)); return
      }
      const observations = body.messages.filter(message => message.role === 'tool').length
      if (observations === 0) answer(response, tool('bash', { command: 'printf desktop-bash-proof' }))
      else if (observations === 1) answer(response, tool('apply_patch', { patch: '*** Begin Patch\n*** Add File: smoke-result.txt\n+desktop-patch-proof\n*** End Patch' }))
      else answer(response, final())
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end() })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Smoke provider listener failed')
  return { url: `http://127.0.0.1:${address.port}`, get held() { return held.size },
    release() { for (const response of held) answer(response, final()) },
    async close() {
      for (const response of held) response.destroy()
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() })
    } }
}

/** Disposable browser acceptance surface for the published four-protocol assets. */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { harnessAssets } from '../../dist/applications/harness/assets.js'
import { projectNativeExchange } from '../../dist/applications/harness/core/protocol-agents/projection.js'

const text = '原生输出保留协议的内容顺序。\n\n```ts\nconst protocol = "native"\n```'
const citation = { url: 'https://example.com/native', title: '原生引用', start_index: 0, end_index: 4 }
const protocols = {
  responses: { status: 'completed', output: [
    { type: 'reasoning', summary: [{ type: 'summary_text', text: '这里是 Responses 返回的推理摘要。' }], encrypted_content: 'PRIVATE' },
    { type: 'message', phase: 'commentary', content: [{ type: 'output_text', text: '先整理来源。' }] },
    { type: 'web_search_call', status: 'completed', action: { type: 'search', query: '原生内容', sources: [{ url: 'https://example.com', title: '搜索来源' }] } },
    { type: 'function_call', call_id: 'call', name: 'bash', arguments: '{"command":"pwd"}' },
    { type: 'message', phase: 'final_answer', content: [{ type: 'output_text', text, annotations: [citation] }, { type: 'refusal', refusal: '示例拒绝子块' }] },
  ] },
  'anthropic-messages': { stop_reason: 'end_turn', content: [
    { type: 'thinking', thinking: '这里是 Anthropic 返回的思考内容。', signature: 'PRIVATE' },
    { type: 'redacted_thinking', data: 'PRIVATE' },
    { type: 'server_tool_use', id: 'search', name: 'web_search', input: { query: '原生内容' } },
    { type: 'web_search_tool_result', tool_use_id: 'search', content: [{ type: 'web_search_result', url: 'https://example.com', title: '搜索来源', encrypted_content: 'PRIVATE' }] },
    { type: 'tool_use', id: 'call', name: 'bash', input: { command: 'pwd' } },
    { type: 'text', text, citations: [{ type: 'web_search_result_location', url: 'https://example.com', title: '块级来源' }] },
  ] },
  'chat-completions': { choices: [{ index: 0, finish_reason: 'stop', message: {
    reasoning_content: '这里是 Chat Completions 返回的推理内容。', content: text, refusal: '示例拒绝内容',
    tool_calls: [{ id: 'call', type: 'function', function: { name: 'bash', arguments: '{"command":"pwd"}' } }],
  } }] },
  'gemini-interactions': { status: 'completed', steps: [
    { type: 'thought', summary: [{ type: 'text', text: '这里是 Gemini 返回的推理摘要。' }], signature: 'PRIVATE' },
    { type: 'function_call', id: 'call', name: 'bash', arguments: { command: 'pwd' } },
    { type: 'model_output', content: [{ type: 'text', text, annotations: [citation] }] },
  ] },
}
const patch = '*** Begin Patch\n*** Update File: saved.txt\n@@\n-old\n+new\n*** Delete File: pending.txt\n*** End Patch'
const appendRequests = (protocolId, raw, count) => {
  const next = structuredClone(raw)
  const requests = [{ id: 'tests', name: 'bash', input: { command: 'npm test' } }, { id: 'patch', name: 'apply_patch', input: { patch } }].slice(0, count - 1)
  if (protocolId === 'responses') next.output.splice(next.output.findIndex(block => block.type === 'function_call') + 1, 0,
    ...requests.map(request => ({ type: 'function_call', call_id: request.id, name: request.name, arguments: JSON.stringify(request.input) })))
  if (protocolId === 'anthropic-messages') next.content.splice(next.content.findIndex(block => block.type === 'tool_use') + 1, 0,
    ...requests.map(request => ({ type: 'tool_use', id: request.id, name: request.name, input: request.input })))
  if (protocolId === 'chat-completions') next.choices[0].message.tool_calls.push(...requests.map(request =>
    ({ id: request.id, type: 'function', function: { name: request.name, arguments: JSON.stringify(request.input) } })))
  if (protocolId === 'gemini-interactions') next.steps.splice(next.steps.findIndex(block => block.type === 'function_call') + 1, 0,
    ...requests.map(request => ({ type: 'function_call', id: request.id, name: request.name, arguments: request.input })))
  return next
}
const snapshots = (count, viewRevision, status = 'provisional') => Object.entries(protocols).map(([protocolId, raw]) => ({ envelopeVersion: 1, viewSchemaVersion: 2,
  protocolId, sessionId: 'browser-session', runId: protocolId, viewRevision, status,
  exchanges: [{ id: 'exchange', ...projectNativeExchange(protocolId, appendRequests(protocolId, raw, count)), ...(status === 'provisional' ? { nativeState: {
    type: protocolId === 'responses' ? 'responses.state' : protocolId === 'anthropic-messages' ? 'anthropic.state' : protocolId === 'chat-completions' ? 'chat.state' : 'gemini.state',
    ...(['responses', 'gemini-interactions'].includes(protocolId) ? { status: 'in_progress' } : {}),
  } } : {}) }] }))
const fixtures = snapshots(1, 1), seconds = n => new Date(Date.UTC(2026, 9, 4, 0, 0, n)).toISOString()
const fact = (requestId, call, eventIndex) => ({ exchangeId: 'exchange', requestId, name: call.name, occurrence: 0, eventIndex, modelEventIndex: 0, call })
const facts = stage => [
  fact('call', { id: 'call', name: 'bash', command: 'pwd', state: stage === 4 ? 'completed' : 'running', startedAt: seconds(0),
    ...(stage === 4 ? { finishedAt: seconds(2), exitCode: 0, signal: null, stdout: Array.from({ length: 80 }, (_, index) => `${index + 1}: /disposable/browser/project/<literal>`).join('\n'), stderr: '', truncated: true } : {}) }, 2),
  ...(stage >= 2 ? [fact('tests', { id: 'tests', name: 'bash', command: 'npm test', state: 'failed', startedAt: seconds(2), finishedAt: seconds(5),
    exitCode: 1, signal: null, stdout: '18 tests passed; 1 test failed.', stderr: 'Example test failure; literal <script>text()</script>', truncated: false }, 4)] : []),
  ...(stage >= 3 ? [fact('patch', { id: 'patch', name: 'apply_patch', patch, patchTruncated: true, state: stage === 4 ? 'partial' : 'running', startedAt: seconds(5),
    ...(stage === 4 ? { finishedAt: seconds(7), result: { status: 'partial', changes: [{ kind: 'updated', path: '/disposable/browser/project/saved.txt' }],
      pending: [{ kind: 'delete', path: '/disposable/browser/project/pending.txt' }], diagnostic: { code: 'commit-failed', message: 'Permission denied', path: '/disposable/browser/project/pending.txt' } } } : {}) }, 6)] : []),
]
const stages = [2, 3, 4].map(stage => ({ snapshots: snapshots(Math.min(stage, 3), stage, stage === 4 ? 'committed' : 'provisional'), facts: facts(stage) }))
const scriptJson = value => JSON.stringify(value).replaceAll('<', '\\u003c')
const assets = new Map(harnessAssets.map(asset => [asset.path, asset]))
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>原生内容浏览器验收</title>
<link rel="stylesheet" href="/apps/agent/style.css"><style>
:root{--text:#222;--secondary:#555;--muted:#777;--line:#ddd;--panel:#fff;--hover:#f4f4f4;--danger:#aa453f}
body{font:14px/1.7 system-ui;margin:24px;background:#fafafa;color:var(--text)}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;position:sticky;top:0;background:#fafafa;padding:10px;z-index:1}
#contents{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px} .qa-card{container-type:inline-size;padding:16px;border:1px solid #ddd;border-radius:10px;background:white;min-width:0}
#contents.narrow{grid-template-columns:repeat(auto-fit,320px)} #contents.four{grid-template-columns:repeat(4,minmax(0,1fr))}.qa-card h2{font-size:14px;margin:0 0 12px}
@media(max-width:800px){#contents{grid-template-columns:1fr}}
</style><body data-app-id="agent"><header><strong>四协议工具展示验收</strong><button id="second">追加第二个工具</button><button id="third">追加第三个工具</button><button id="commit">提交终态与工具事件</button><button id="narrow">约 320px 面板</button><button id="four">四分屏</button><button id="detail">详细展示</button><output id="state">流式展示 / 工具待同步</output></header><main id="contents"></main>
<script type="module">
import { getProtocolWebModule } from '/applications/harness/web/protocols/modules.js';
const initial=${scriptJson(fixtures)}, stages=${scriptJson(stages)};
let presentation='compact', current=initial, currentFacts=[], readiness='loading', runStatus='running';
const options=snapshot=>({presentation,toolContext:{runId:snapshot.runId,readiness,runStatus,facts:currentFacts}});
const turns=initial.map(snapshot=>{const turn=getProtocolWebModule(snapshot.protocolId).mount(snapshot,options(snapshot));const card=document.createElement('section');card.className='qa-card';card.dataset.protocol=snapshot.protocolId;const title=document.createElement('h2');title.textContent=snapshot.protocolId;card.append(title,turn.element);document.getElementById('contents').append(card);return turn});
const update=()=>current.forEach((snapshot,index)=>turns[index].update(snapshot,options(snapshot)));
const showStage=index=>{current=stages[index].snapshots;currentFacts=stages[index].facts;readiness='ready';runStatus=index===2?'completed':'running';update();document.getElementById('state').textContent=index===2?'终态 / 长输出、失败、部分补丁':'流式 / '+(index+2)+' 个工具';};
document.getElementById('second').addEventListener('click',()=>showStage(0));
document.getElementById('third').addEventListener('click',()=>showStage(1));
document.getElementById('commit').addEventListener('click',()=>showStage(2));
document.getElementById('narrow').addEventListener('click',()=>{const contents=document.getElementById('contents');contents.classList.remove('four');contents.classList.toggle('narrow')});
document.getElementById('four').addEventListener('click',()=>{const contents=document.getElementById('contents');contents.classList.remove('narrow');contents.classList.toggle('four')});
document.getElementById('detail').addEventListener('click',event=>{presentation=presentation==='compact'?'detail':'compact';event.target.textContent=presentation==='compact'?'详细展示':'紧凑展示';update()});
</script></body></html>`
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(page); return }
    const asset = assets.get(request.url)
    if (!asset) { response.writeHead(404); response.end(); return }
    response.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store' }); response.end(await readFile(asset.file))
  } catch { response.writeHead(500); response.end('Fixture asset unavailable') }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` }) + '\n')
const close = () => server.close()
process.once('SIGINT', close); process.once('SIGTERM', close)

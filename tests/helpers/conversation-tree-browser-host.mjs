/** Disposable, memory-only acceptance surface for the real Session controller and panel. */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { harnessAssets } from '../../dist/applications/harness/assets.js'
import { shellAssets } from '../../dist/host/assets.js'

const sessionId = 'branch-preview-session', projectId = 'branch-preview-project'
const at = minute => new Date(Date.UTC(2026, 9, 4, 1, minute)).toISOString()
const session = { id: sessionId, projectId, agentId: 'assistant', modelId: null, protocolId: 'chat-completions',
  historyMode: 'native-local-v1', archivedAt: null, createdAt: at(0) }
const examples = [
  ['n1', null, '帮我设计一个轻量的读书笔记应用', '可以从三个核心能力开始：收藏书籍、记录摘录、回顾想法。先确定最常用的工作流，再完善页面。'],
  ['n2', 'n1', '给我两个首页方向，先详细展开第一个', '方向一采用书架首页。最近阅读的书放在上方，每本书展示阅读进度，点击进入摘录和笔记。'],
  ['n3', 'n1', '给我两个首页方向，先详细展开第一个', '另一种版本以笔记时间线为首页。先展示最近写下的想法，再按书籍聚合。它更适合经常记录和回顾的用户。'],
  ['n4', 'n2', '书架方向不错，展开添加笔记的流程', '从书籍详情点击“记一笔”，输入摘录和自己的想法。保存后仍停留在当前书籍，便于继续阅读。'],
  ['n15', 'n4', '摘录和想法需要分开填写吗？', '先让用户连续记录，保存时再按用途整理。写作过程尽量保持轻松。'],
  ['n5', 'n15', '输入区如何减少操作？', '把摘录和想法放在同一个输入区。输入完成后再选择分类，避免在写作开始前要求填写多个字段。'],
  ['n6', 'n5', '加入一个快速回顾入口', '首页提供“今日回顾”，每天从已有笔记中选取三条。每条都能直接打开对应书籍，补充新的理解。'],
  ['n7', 'n6', '回顾卡片应该包含什么信息？', '卡片包含书名、摘录、自己的想法和记录日期。卡片下方只保留“展开”和“补充想法”两个动作。'],
  ['n8', 'n7', '小屏幕如何布局？', '小屏幕使用单列卡片。书名和日期共占一行，摘录默认显示四行，较长内容通过展开查看。'],
  ['n16', 'n8', '回顾提醒需要多频繁？', '提醒频率由用户选择，默认保持轻量；打开应用时也可以主动进入回顾。'],
  ['n9', 'n16', '再整理一下空状态', '没有书籍时，提供“添加第一本书”；有书但没有笔记时，展示一条简短示例，并提供“记录第一条笔记”。'],
  ['n10', 'n9', '把这个方向归纳成一个最小可用版本', '最小可用版本包含：\n\n- 书架与书籍详情\n- 一步添加笔记\n- 每日三条回顾\n\n先验证记录和回顾是否足够顺手，再扩展搜索和标签。'],
  ['n11', 'n3', '沿时间线方向继续，如何支持回顾？', '时间线顶部加入“本周回顾”，把这一周的笔记按书籍分组。阅读时可从最新想法向前追溯。'],
  ['n12', 'n11', '用什么指标判断回顾是否有帮助？', '可以观察回顾打开率、补充想法的比例，以及一周内重新打开旧笔记的次数。先通过小规模试用验证。'],
  ['n13', 'n11', '先不做自动回顾，只保留手动筛选', '可以保留按书籍和日期筛选，用户主动选择想回顾的内容。这样第一版的规则更容易理解。'],
  ['n14', null, '换个思路：从阅读目标开始设计', '首页可以围绕阅读目标组织。展示当前目标、正在读的书和下一步行动，再把笔记归入每个目标。'],
]
const nodes = examples.map(([id, parentId, input, output]) => ({ id, sessionId, parentId, input, output, sourceRunId: `run-${id}` }))
const runs = nodes.map((node, index) => ({ id: node.sourceRunId, sessionId, input: node.input, output: node.output,
  status: 'completed', revision: 2, resultNodeId: node.id, history: { kind: 'tree', parentNodeId: node.parentId },
  modelId: null, requestedModelId: null, modelSnapshot: null,
  protocolBinding: { protocolId: 'chat-completions', viewSchemaVersion: 2 }, createdAt: at(index + 1), updatedAt: at(index + 2) }))
runs.push({ id: 'run-in-progress', sessionId, input: '帮我比较每日回顾和每周回顾的取舍', status: 'running', revision: 1,
  history: { kind: 'tree', parentNodeId: 'n6' }, modelId: null, requestedModelId: null, modelSnapshot: null,
  protocolBinding: { protocolId: 'chat-completions', viewSchemaVersion: 2 }, createdAt: at(17), updatedAt: at(17) })
const views = runs.map(run => ({ envelopeVersion: 1, viewSchemaVersion: 2, protocolId: 'chat-completions', sessionId,
  runId: run.id, viewRevision: run.revision, status: run.status === 'running' ? 'provisional' : 'committed',
  exchanges: [{ id: `exchange-${run.id}`, blocks: [{ id: `text-${run.id}`, type: 'chat.content',
    text: run.output ?? '正在整理两种回顾节奏的适用场景…' }] }] }))
const events = Object.fromEntries(runs.map(run => [run.id, [
  { seq: 1, at: run.createdAt, kind: 'model-started' },
  ...(run.status === 'completed' ? [{ seq: 2, at: run.updatedAt, kind: 'terminal' }] : []),
]]))
const scriptJson = value => JSON.stringify(value).replaceAll('<', '\\u003c')
const shellPaths = new Set(['/style.css', '/host/web/http-client.js'])
const assets = new Map([...harnessAssets, ...shellAssets.filter(asset => shellPaths.has(asset.path))].map(asset => [asset.path, asset]))
const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>会话分支预览</title><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/apps/agent/style.css">
<style>
html,body{height:auto;min-height:100%;overflow:auto}body{padding:20px;background:var(--canvas)}
.preview-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:10px;max-width:1280px;margin:0 auto 16px;position:sticky;top:0;padding:10px 0;background:var(--canvas);z-index:2}
.preview-toolbar strong{font-size:14px;margin-right:8px}.preview-toolbar button{font-size:12px;padding:6px 10px;border:1px solid var(--line-strong);border-radius:6px;background:var(--panel)}
.preview-toolbar button[aria-pressed=true]{background:var(--selected)}.preview-toolbar span{font-size:12px;color:var(--secondary)}
#preview-panels{display:grid;grid-template-columns:minmax(0,1fr);gap:8px;max-width:1100px;margin:0 auto;width:100%}
#preview-panels[data-layout=narrow]{width:320px;max-width:320px;margin-left:auto;margin-right:auto}
#preview-panels[data-layout=four]{grid-template-columns:repeat(4,minmax(0,1fr));width:1280px;max-width:none;margin-left:auto;margin-right:auto}
.preview-card{min-width:0;height:700px;border:1px solid var(--line-strong);border-radius:8px;overflow:hidden}.preview-card>.session-pane{height:100%;width:100%}
.preview-description{font-size:12px;line-height:1.8;color:var(--secondary);max-width:1100px;margin:16px auto}.preview-description output{overflow-wrap:anywhere}
@media(max-width:500px){body{padding:12px}.preview-toolbar{position:relative}.preview-card{height:700px}}
</style></head><body data-app-id="agent">
<header class="preview-toolbar"><strong>会话分支预览</strong><button type="button" data-layout="normal" aria-pressed="true">常规</button><button type="button" data-layout="narrow" aria-pressed="false">窄屏 320px</button><button type="button" data-layout="four" aria-pressed="false">四分屏</button><span>${nodes.length} 个成功节点 · 1 个运行中 · 点击分支查看不同路径</span></header>
<main id="preview-panels" data-layout="normal" aria-label="会话样本"></main>
<p class="preview-description">样本保存在当前页面内存中，可以切换分支和输入草稿。发送、重新生成、取消及上传操作会提示此样本仅供展示。<br><output id="preview-position" aria-live="polite"></output></p>
<script type="module">
import { createPendingStore, createSessionController } from '/applications/harness/web/session-client.js';
import { createSessionPanel } from '/applications/harness/web/session-view.js';
const fixture=${scriptJson({ session, nodes, runs, views, events })};
const nodes=new Map(fixture.nodes.map(node=>[node.id,node]));
const runs=new Map(fixture.runs.map(run=>[run.id,run]));
const views=new Map(fixture.views.map(view=>[view.runId,view]));
const notFound=()=>Object.assign(new Error('样本中没有该记录。'),{status:404,code:'not-found'});
const displayOnly=()=>Object.assign(new Error('此样本仅供展示，不会执行、上传或修改任何数据。'),{status:400,code:'preview-only'});
const api=async(url,body,signal)=>{
  if(signal?.aborted)throw new DOMException('Aborted','AbortError');
  if(body!==undefined)throw displayOnly();
  const request=new URL(url,'http://preview.local'),parts=request.pathname.split('/').map(decodeURIComponent);
  let value;
  if(parts[1]==='sessions'&&parts[2]===fixture.session.id){
    if(parts.length===3)value=fixture.session;
    else if(parts[3]==='runs'&&parts.length===4)value=fixture.runs;
    else if(parts[3]==='runs'&&parts[4]==='by-key')throw notFound();
    else if(parts[3]==='nodes'&&parts[5]==='path'){
      if(parts[4]!=='root'&&!nodes.has(parts[4]))throw notFound();
      value=[];let node=nodes.get(parts[4]);while(node){value.unshift(node);node=nodes.get(node.parentId);}
    }else if(parts[3]==='nodes'&&parts.length===4){
      const requested=request.searchParams.get('parentNodeId'),parent=requested==='root'?null:requested;
      const children=fixture.nodes.filter(node=>node.parentId===parent),offset=Number(request.searchParams.get('cursor')??0),limit=2;
      value={nodes:children.slice(offset,offset+limit),...(offset+limit<children.length?{nextCursor:String(offset+limit)}:{})};
    }
  }else if(parts[1]==='runs'){
    const run=runs.get(parts[2]);if(!run)throw notFound();
    if(parts.length===3)value=run;
    else if(parts[3]==='view')value=views.get(run.id);
    else if(parts[3]==='events')value=fixture.events[run.id].filter(event=>event.seq>Number(request.searchParams.get('afterSeq')??0));
  }
  if(value===undefined)throw notFound();
  return structuredClone(value);
};
const host=document.getElementById('preview-panels'),bundles=[],initialNodes=['n10','n12','n13','n6'];
function updatePosition(){document.getElementById('preview-position').textContent=bundles.filter(bundle=>!bundle.card.hidden).map((bundle,index)=>{const state=bundle.controller.snapshot();return '面板 '+(index+1)+'：'+(state.position.viewNodeId??'会话起点')+' · 路径 '+state.path.length+' 轮 · 草稿 '+state.draft.length+' 字';}).join(' ／ ');}
for(let index=0;index<4;index++){
  const memory=new Map(),pending=createPendingStore({getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value)});
  const pane={id:'preview-pane-'+index,sessionId:fixture.session.id,projectId:fixture.session.projectId};
  const card=document.createElement('div');card.className='preview-card';card.hidden=index>0;host.append(card);
  const controller=createSessionController(pane,{api,pending,messageFor:error=>error.message,newId:()=>crypto.randomUUID(),
    hidden:()=>document.hidden||card.hidden,position:{viewNodeId:initialNodes[index]},schedule:(callback,ms)=>window.setTimeout(callback,ms),clear:timer=>window.clearTimeout(timer),missing:()=>{},uploadImage:()=>Promise.reject(displayOnly())});
  const panel=createSessionPanel(pane,'读书笔记 · 分支样本',controller,()=>{for(const bundle of bundles)bundle.panel.element.classList.toggle('active-pane',bundle.controller===controller);},()=>{});
  card.append(panel.element);bundles.push({card,panel,controller});
  controller.attach(()=>{panel.render();updatePosition();});panel.resizeInput();
}
bundles[0].panel.element.classList.add('active-pane');
for(const button of document.querySelectorAll('.preview-toolbar [data-layout]'))button.addEventListener('click',()=>{
  host.dataset.layout=button.dataset.layout;
  for(const choice of document.querySelectorAll('.preview-toolbar [data-layout]'))choice.setAttribute('aria-pressed',String(choice===button));
  bundles.forEach((bundle,index)=>{bundle.card.hidden=button.dataset.layout!=='four'&&index>0;if(!bundle.card.hidden){bundle.panel.render();bundle.panel.resizeInput();}});updatePosition();
});
window.addEventListener('pagehide',()=>{for(const bundle of bundles){bundle.controller.dispose();bundle.panel.dispose();}},{once:true});
</script></body></html>`
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://127.0.0.1').pathname
    if (path === '/') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(page); return }
    const asset = assets.get(path)
    if (!asset) { response.writeHead(404); response.end(); return }
    response.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store' }); response.end(await readFile(asset.file))
  } catch { response.writeHead(500); response.end('Fixture asset unavailable') }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` }) + '\n')
const close = () => server.close()
process.once('SIGINT', close); process.once('SIGTERM', close)

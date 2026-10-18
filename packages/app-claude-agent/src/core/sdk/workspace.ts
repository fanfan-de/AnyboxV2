import type { ElicitationRequest, Options, Query, SDKControlGetContextUsageResponse, SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { claudeAgentError } from '../domain.js'
import type { ContextUsage, ElicitationView, SessionInspection, SessionInspectionResult, SessionOptions } from '../workspace.js'
import { object } from '../workspace.js'
import { readCapabilities } from './capabilities.js'
import { blockView } from './translate.js'
import type { HistoryMessageView } from '../view.js'
import { readAccountUsage } from './account.js'

const count = (value: number) => Number.isFinite(value) && value >= 0 ? value : 0
export function contextView(raw: SDKControlGetContextUsageResponse, full = false): ContextUsage {
  return { schemaVersion: 1, model: raw.model.slice(0, 200), totalTokens: count(raw.totalTokens), maxTokens: count(raw.maxTokens), percentage: Math.min(100, count(raw.percentage)), estimated: !full,
    ...(full ? {details:[...raw.memoryFiles.slice(0,100).map(x=>({group:'记忆文件',name:x.path.slice(0,4096),tokens:count(x.tokens)})),...raw.mcpTools.slice(0,200).map(x=>({group:'MCP 工具',name:`${x.serverName} / ${x.name}`.slice(0,500),tokens:count(x.tokens)})),...raw.agents.slice(0,100).map(x=>({group:'子 Agent',name:x.agentType.slice(0,200),tokens:count(x.tokens)})),...(raw.systemPromptSections??[]).slice(0,100).map(x=>({group:'系统提示',name:x.name.slice(0,200),tokens:count(x.tokens)})),...(raw.skills?.skillFrontmatter??[]).slice(0,100).map(x=>({group:'技能',name:x.name.slice(0,200),tokens:count(x.tokens)}))]} : {}),
    categories: raw.categories.slice(0, 100).map(item => ({ name: item.name.slice(0, 200), tokens: count(item.tokens), kind: item.kind })) }
}
export function nativeOptions(options: SessionOptions | undefined): Partial<Options> {
  if (!options) return {}
  return { ...(options.maxBudgetUsd === null ? {} : { maxBudgetUsd: options.maxBudgetUsd }), ...(options.maxTurns === null ? {} : { maxTurns: options.maxTurns }),
    ...(options.fallbackModel ? { fallbackModel: options.fallbackModel } : {}),
    ...(options.checkpointing ? { enableFileCheckpointing: true, extraArgs: { 'replay-user-messages': null } } : {}),
    ...(Object.keys(options.mcpServers).length ? { mcpServers: Object.fromEntries(Object.entries(options.mcpServers).map(([name, server]) => [name, server.type === 'stdio' ? { ...server, args: [...server.args] } : { ...server }])) } : {}) }
}
export async function inspectQuery(query: Query, input: SessionInspection): Promise<SessionInspectionResult> {
  switch (input.action) {
    case 'account': return readAccountUsage(query)
    case 'context': return contextView(await query.getContextUsage({ detail: input.detail ?? 'summary' }), input.detail === 'full')
    case 'file': {
      const file = await query.readFile(input.path, { maxBytes: 384 * 1024, encoding: 'base64' })
      if (!file) throw claudeAgentError('file-unavailable', 404, '文件不存在、无读取权限或执行设备未返回内容。')
      const bytes=Buffer.from(file.contents,'base64'), extension=file.absPath.split('.').at(-1)?.toLowerCase(), mime=extension==='png'?'image/png':extension==='jpg'||extension==='jpeg'?'image/jpeg':extension==='gif'?'image/gif':extension==='webp'?'image/webp':extension==='pdf'?'application/pdf':null
      if(mime){if(!file.truncated) {const {verifyAttachment}=await import('../attachments.js');verifyAttachment(mime,bytes)} return {path:file.absPath.slice(0,4096),contents:file.contents,encoding:'base64',mime,truncated:file.truncated===true}}
      let contents:string;try{contents=new TextDecoder('utf-8',{fatal:true}).decode(bytes,{stream:file.truncated===true})}catch{throw claudeAgentError('file-unsupported',400,'此文件不是 UTF-8 文本或支持预览的图片/PDF。')}
      if(contents.includes('\0'))throw claudeAgentError('file-unsupported',400,'不支持预览此二进制文件。')
      return {path:file.absPath.slice(0,4096),contents:contents.slice(0,128*1024),encoding:'utf-8',mime:'text/plain',truncated:file.truncated===true||contents.length>128*1024}
    }
    case 'rewind': {
      const result = await query.rewindFiles(input.messageId, { dryRun: input.dryRun })
      return { canRewind: result.canRewind, error: result.error?.slice(0, 4000) ?? null, files: (result.filesChanged ?? []).slice(0, 2000).map(path => path.slice(0, 4096)),
        insertions: count(result.insertions ?? 0), deletions: count(result.deletions ?? 0), skippedLinks: count(result.skippedLinks ?? 0) }
    }
    case 'mcp-connect': return readCapabilities(query, 'project', 'default')
  }
}
/** Only supported primitive form schemas cross the boundary. Answers are never saved in application history. */
export function elicitationView(request: ElicitationRequest): Omit<ElicitationView, 'id' | 'threadId'> {
  const mode = request.mode ?? 'form'
  let url: string | null = null
  if (mode === 'url') {
    if (!request.url || request.url.length > 8192) throw claudeAgentError('elicitation-unsupported', 400)
    const parsed = new URL(request.url ?? '')
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw claudeAgentError('elicitation-unsupported', 400)
    url = parsed.href
  }
  const schema = request.requestedSchema, properties = object(schema?.properties) ? schema.properties : {}, required = Array.isArray(schema?.required) ? schema.required : []
  if (mode === 'form' && (Object.keys(properties).length > 30 || schema?.type !== 'object')) throw claudeAgentError('elicitation-unsupported', 400)
  const fields: ElicitationView['fields'][number][] = Object.entries(properties).map(([name, raw]) => {
    if (!object(raw) || !['string', 'number', 'integer', 'boolean'].includes(String(raw.type)) || name.length > 200 || ['__proto__', 'constructor', 'prototype'].includes(name)) throw claudeAgentError('elicitation-unsupported', 400)
    if (raw.enum !== undefined && (!Array.isArray(raw.enum) || raw.enum.length > 100 || raw.enum.some(value => typeof value !== 'string' || value.length > 1000))) throw claudeAgentError('elicitation-unsupported', 400)
    return { name, title: typeof raw.title === 'string' ? raw.title.slice(0, 200) : name, type: raw.type as 'string' | 'number' | 'integer' | 'boolean', required: required.includes(name), ...(Array.isArray(raw.enum) ? { choices: raw.enum as string[] } : {}) }
  })
  if (JSON.stringify(fields).length > 32768) throw claudeAgentError('elicitation-unsupported', 400)
  return { serverName: request.serverName.slice(0, 256), message: request.message.slice(0, 8000), mode, url, fields }
}
/** Native child transcripts include user tool-result frames; do not apply the main-thread filter. */
export function subagentMessages(raw: readonly SessionMessage[]): HistoryMessageView[] {
  return raw.flatMap(message => {
    if (message.type !== 'assistant' && message.type !== 'user') return []
    const content = object(message.message) ? message.message.content : undefined
    return [{ id: message.uuid, role: message.type, blocks: typeof content === 'string' ? [blockView({ type: 'text', text: content })] : Array.isArray(content) ? content.map(blockView) : [] }]
  })
}

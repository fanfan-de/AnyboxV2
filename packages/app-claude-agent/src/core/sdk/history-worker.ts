import { historyMessages } from './translate.js'
import { subagentMessages } from './workspace.js'
import { pathToFileURL } from 'node:url'
import { getSessionInfo, getSessionMessages, listSessions, listSubagents, getSubagentMessages, forkSession, renameSession, tagSession, deleteSession } from '@anthropic-ai/claude-agent-sdk'

/**
 * Child entry: reads the Claude environment's session files off the main server process and prints JSON.
 * Commands: `messages <sessionId> [dir]`, `sessions <limit>` (interactive sessions across all projects, newest first),
 * `info <sessionId> [dir]`. Only runs when executed directly.
 */
async function run(command: string | undefined, args: readonly string[]): Promise<unknown> {
  switch (command) {
    case 'native-sessions': return (await listSessions({dir:args[0],includeProgrammatic:true,limit:Number(args[1])+51})).slice(Number(args[1])).map(x=>({sessionId:x.sessionId,title:(x.customTitle??x.summary??x.firstPrompt??x.sessionId).slice(0,200),updatedAt:new Date(x.lastModified).toISOString()}))
    case 'page': {const all=await getSessionMessages(args[0]!,{dir:args[1]});const offset=Number(args[2])<0?Math.max(0,all.length-100):Number(args[2]);return {messages:historyMessages(all.slice(offset,offset+100)),nextOffset:offset+Math.min(100,Math.max(0,all.length-offset)),previousOffset:offset>0?Math.max(0,offset-100):null,hasMore:offset+100<all.length}}
    case 'subagents': return listSubagents(args[0]!, { dir: args[1] })
    case 'subagent-messages': {const raw=await getSubagentMessages(args[0]!, args[2]!, { dir: args[1], offset: Number(args[3]), limit: 101 });return {messages:subagentMessages(raw.slice(0,100)),hasMore:raw.length>100}}
    case 'rename': await renameSession(args[0]!, args[2]!, { dir: args[1] }); return {}
    case 'tag': await tagSession(args[0]!, args[2] || null, { dir: args[1] }); return {}
    case 'fork': return forkSession(args[0]!, { dir: args[1], title: args[2], ...(args[3] ? { upToMessageId: args[3] } : {}) })
    case 'delete': await deleteSession(args[0]!, { dir: args[1] }); return {}
    case 'messages': {
      const [sessionId, dir] = args
      if (!sessionId) throw new Error('session id required')
      return historyMessages(await getSessionMessages(sessionId, dir ? { dir } : {}))
    }
    case 'sessions': {
      const limit = Number(args[0])
      if (!Number.isInteger(limit) || limit <= 0) throw new Error('session limit required')
      const sessions = await listSessions({ includeProgrammatic: false, limit })
      return sessions.map(session => ({ sessionId: session.sessionId, cwd: session.cwd ?? null, lastModified: session.lastModified }))
    }
    case 'info': {
      const [sessionId, dir] = args
      if (!sessionId) throw new Error('session id required')
      const info = await getSessionInfo(sessionId, dir ? { dir } : {})
      return info ? { customTitle: info.customTitle ?? null, summary: info.summary ?? null, firstPrompt: info.firstPrompt ?? null } : null
    }
    default: throw new Error('unknown history command')
  }
}
async function main() {
  const [command, ...args] = process.argv.slice(2)
  const value = await run(command, args)
  await new Promise<void>((resolve, reject) => process.stdout.write(JSON.stringify(value), error => error ? reject(error) : resolve()))
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(error => {
  process.exitCode = 1
  process.stderr.write(`${error instanceof Error ? error.message : 'history read failed'}\n`)
})

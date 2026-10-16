import { pathToFileURL } from 'node:url'
import { getSessionInfo, getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk'

/**
 * Child entry: reads the Claude environment's session files off the main server process and prints JSON.
 * Commands: `messages <sessionId> [dir]`, `sessions <limit>` (interactive sessions across all projects, newest first),
 * `info <sessionId> [dir]`. Only runs when executed directly.
 */
async function run(command: string | undefined, args: readonly string[]): Promise<unknown> {
  switch (command) {
    case 'messages': {
      const [sessionId, dir] = args
      if (!sessionId) throw new Error('session id required')
      return getSessionMessages(sessionId, dir ? { dir } : {})
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

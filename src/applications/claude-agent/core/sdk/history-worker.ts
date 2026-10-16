import { pathToFileURL } from 'node:url'
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk'

/**
 * Child entry: reads one transcript off the main server process and prints the SDK's messages as JSON.
 * Arguments: session id, project directory. Only runs when executed directly.
 */
async function main() {
  const [sessionId, dir] = process.argv.slice(2)
  if (!sessionId) throw new Error('session id required')
  const messages = await getSessionMessages(sessionId, dir ? { dir } : {})
  await new Promise<void>((resolve, reject) => process.stdout.write(JSON.stringify(messages), error => error ? reject(error) : resolve()))
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch(error => {
  process.exitCode = 1
  process.stderr.write(`${error instanceof Error ? error.message : 'history read failed'}\n`)
})

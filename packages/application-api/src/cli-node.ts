/** Node transport adapter; no Nya, storage, credential or application runtime imports. */
import type { Writable } from 'node:stream'
import { cliExit, cliFailure, runApplicationCli } from './cli.js'
import type { ApplicationCliRegistration, CliExitCode, CliIo, CliRunConfig } from './cli.js'

const write = (stream: Writable, text: string): Promise<void> => new Promise((resolve, reject) => {
  stream.write(text, error => error ? reject(cliFailure('output-unavailable', 'Cannot write CLI output')) : resolve())
})

export function createNodeCliIo(signal: AbortSignal): CliIo {
  return { stdin: process.stdin, stdout: text => write(process.stdout, text), stderr: text => write(process.stderr, text),
    env: process.env, cwd: process.cwd(), signal,
    ...(process.stdin.isTTY && process.stderr.isTTY ? { readSecret: async (prompt: string) => {
      const input = process.stdin, wasRaw = input.isRaw, wasPaused = input.isPaused()
      await write(process.stderr, prompt)
      try {
        input.setRawMode(true); input.resume()
        return await new Promise<string>((resolve, reject) => {
          let value = ''
          const cleanup = () => { input.off('data', onData); input.off('end', onEnd); input.off('error', onError); signal.removeEventListener('abort', onAbort) }
          const finish = (error?: Error) => { cleanup(); error ? reject(error) : resolve(value) }
          const onAbort = () => finish(cliFailure('cancelled', 'Token input cancelled', cliExit.cancelled))
          const onEnd = () => finish(cliFailure('token-input', 'Token input ended', cliExit.usage))
          const onError = () => finish(cliFailure('token-input', 'Token input failed', cliExit.usage))
          const onData = (chunk: Buffer) => {
            for (const character of chunk.toString('utf8')) {
              if (character === '\u0003' || character === '\u0004') { onAbort(); return }
              if (character === '\r' || character === '\n') { finish(); return }
              if (character === '\u007f' || character === '\b') value = value.slice(0, -1)
              else if (character >= ' ' && value.length < 16384) value += character
              else { onError(); return }
            }
          }
          input.on('data', onData); input.once('end', onEnd); input.once('error', onError)
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
        })
      } finally { input.setRawMode(wasRaw); if (wasPaused) input.pause(); await write(process.stderr, '\n') }
    } } : {}),
  }
}

export async function runNodeCli(args: readonly string[], registrations: readonly ApplicationCliRegistration[], config: CliRunConfig): Promise<CliExitCode> {
  const controller = new AbortController()
  const stop = () => controller.abort()
  const outputError = () => { /* Write callbacks report errors through the CLI error boundary. */ }
  process.stdout.on('error', outputError); process.stderr.on('error', outputError)
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try { return await runApplicationCli(args, registrations, createNodeCliIo(controller.signal), config) }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); process.stdout.off('error', outputError); process.stderr.off('error', outputError) }
}

#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { runNodeCli } from '@anybox/application-api/cli-node'
import { harnessCliRegistration } from '../cli/registration.js'

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const version = (createRequire(import.meta.url)('../../package.json') as { version: string }).version
  process.exitCode = await runNodeCli(args, [harnessCliRegistration], { name: 'anybox-harness', version, application: 'harness' })
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) void main().catch(() => {
  process.exitCode = 1; process.stderr.write('Harness CLI could not complete\n')
})

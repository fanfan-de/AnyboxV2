import type { ApplicationCliRegistration, CliCommand, CliOption } from '@anybox/application-api/cli'

const string = (name: string, description: string, required = false): CliOption => ({ name, description, type: 'string', required })
const flag = (name: string, description: string): CliOption => ({ name, description, type: 'boolean' })
const id = (name: string) => ({ name, description: `${name} identity`, required: true })
export const harnessCliCommand: CliCommand = {
  name: 'harness', description: 'Anybox Harness client for an explicitly configured, already running server',
  options: [string('target', 'Use this saved target instead of the selected target')],
  commands: [
    { name: 'target', description: 'Manage private CLI connection configuration', commands: [
      { name: 'add', description: 'Check and save a new target; token uses hidden input or stdin', arguments: [id('name')], options: [string('endpoint', 'HTTP(S) server origin', true), flag('token-stdin', 'Read the token from stdin (one line)')] },
      { name: 'list', description: 'List targets without displaying tokens or contacting servers' },
      { name: 'use', description: 'Select a saved target', arguments: [id('name')] },
      { name: 'check', description: 'Check the saved target authentication and fixed instance', arguments: [{ name: 'name', description: 'Target name; defaults to selected target' }] },
      { name: 'remove', description: 'Remove a target and its saved token', arguments: [id('name')] },
    ] },
    ...['agents', 'models', 'projects'].map(name => ({ name, description: `Query ${name}`, commands: [{ name: 'list', description: `List ${name} on the target server` }] })),
    { name: 'session', description: 'Query or create sessions', commands: [
      { name: 'list', description: 'List active sessions in a project', options: [string('project', 'Project ID', true)] },
      { name: 'show', description: 'Show a session', arguments: [id('session-id')] },
      { name: 'create', description: 'Create a session (not retried automatically)', options: [string('project', 'Project ID', true), string('agent', 'Agent ID', true), string('model', 'Optional model configuration ID')] },
    ] },
    { name: 'run', description: 'Submit, query and observe runs', commands: [
      { name: 'start', description: 'Start once; disconnecting the CLI leaves the run active', arguments: [id('session-id')], options: [
        string('parent', 'Explicit parent node ID, or root for null', true), string('request-id', 'Stable idempotency key; preserve for run find', true),
        string('input', 'Prompt text; alternatively use --stdin'), flag('stdin', 'Read prompt text from stdin'),
        string('model', 'Optional model configuration ID'), flag('detach', 'Return after acceptance'),
      ] },
      { name: 'show', description: 'Show a run snapshot', arguments: [id('run-id')] },
      { name: 'watch', description: 'Watch snapshots using SSE hints and authoritative queries', arguments: [id('run-id')] },
      { name: 'cancel', description: 'Request cancellation; use watch to observe actual exit', arguments: [id('run-id')] },
      { name: 'find', description: 'Find the original run after an unknown submission outcome', arguments: [id('session-id')], options: [string('request-id', 'Original idempotency key', true)] },
    ] },
  ],
}
export const harnessCliRegistration: ApplicationCliRegistration = {
  contractVersion: 1, appId: 'agent', command: harnessCliCommand,
  load: () => import('./commands.js'),
}

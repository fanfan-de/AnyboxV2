/** CLI v1: metadata is safe to import without loading an application's runtime. */
export type CliJson = null | boolean | number | string | readonly CliJson[] | { readonly [key: string]: CliJson }
export function isCliObject(value: CliJson): value is { readonly [key: string]: CliJson } {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
export const cliExit = Object.freeze({ ok: 0, failure: 1, usage: 2, authentication: 3, notFound: 4,
  conflict: 5, unavailable: 6, unknownOutcome: 7, runFailed: 8, cancelled: 130 })
export type CliExitCode = typeof cliExit[keyof typeof cliExit]
export interface CliOption {
  readonly name: string
  readonly description: string
  readonly type: 'string' | 'boolean'
  readonly required?: boolean
}
export interface CliArgument { readonly name: string; readonly description: string; readonly required?: boolean }
export interface CliCommand {
  readonly name: string
  readonly description: string
  readonly options?: readonly CliOption[]
  readonly arguments?: readonly CliArgument[]
  readonly commands?: readonly CliCommand[]
}
export interface CliInvocation {
  /** Includes the registered application command. */
  readonly path: readonly string[]
  readonly arguments: readonly string[]
  readonly options: Readonly<Record<string, string | boolean>>
}
export interface CliIo {
  readonly stdin: AsyncIterable<Uint8Array | string>
  readonly stdout: (text: string) => Promise<void>
  readonly stderr: (text: string) => Promise<void>
  readonly env: Readonly<Record<string, string | undefined>>
  readonly cwd: string
  readonly signal: AbortSignal
  /** Provided only when a terminal can disable echo. Must restore terminal state on exit. */
  readonly readSecret?: (prompt: string) => Promise<string>
}
export interface CliContext extends CliIo {
  readonly json: boolean
  /** JSON mode emits one versioned envelope per line; human mode uses the supplied text. */
  readonly emit: (data: CliJson, text?: string, type?: 'result' | 'request' | 'accepted' | 'snapshot') => Promise<void>
}
export interface CliModule {
  /** Resolves only after all resources owned by this invocation have exited. */
  execute(invocation: CliInvocation, context: CliContext): Promise<CliExitCode | void>
}
export interface ApplicationCliRegistration {
  readonly contractVersion: 1
  readonly appId: string
  readonly command: CliCommand
  readonly load: () => Promise<CliModule>
}
export interface CliFailure extends Error { readonly cliFailure: true; readonly code: string; readonly exitCode: CliExitCode; readonly details?: CliJson }
export function cliFailure(code: string, message: string, exitCode: CliExitCode = cliExit.failure, details?: CliJson): CliFailure {
  return Object.assign(new Error(message), { cliFailure: true as const, code, exitCode, details })
}
export function isCliFailure(error: unknown): error is CliFailure {
  return error instanceof Error && 'cliFailure' in error && error.cliFailure === true
}
const usageFailure = (message: string) => cliFailure('invalid-arguments', message, cliExit.usage)
const word = /^[a-z][a-z0-9-]*$/
const globals: readonly CliOption[] = [
  { name: 'json', type: 'boolean', description: 'Emit CLI v1 NDJSON envelopes' },
  { name: 'help', type: 'boolean', description: 'Show metadata without loading execution code' },
]

/** Validate a trusted composition once, including option collisions inherited by descendants. */
export function registerApplicationClis(registrations: readonly ApplicationCliRegistration[], reserved: readonly string[] = []): readonly ApplicationCliRegistration[] {
  const names = new Set(['help', 'completion', ...reserved]), appIds = new Set<string>()
  function validate(command: CliCommand, inherited: ReadonlySet<string>) {
    if (!word.test(command.name) || !command.description.trim()) throw new TypeError('Invalid CLI command metadata')
    const options = new Set(inherited)
    for (const option of command.options ?? []) {
      if (!word.test(option.name) || options.has(option.name) || !['string', 'boolean'].includes(option.type) || !option.description.trim()) throw new TypeError('Invalid or duplicate CLI option')
      options.add(option.name)
    }
    if (command.commands?.length && command.arguments?.length) throw new TypeError('CLI groups cannot have positional arguments')
    let optional = false
    const argumentNames = new Set<string>()
    for (const argument of command.arguments ?? []) {
      if (!word.test(argument.name) || argumentNames.has(argument.name) || optional && argument.required) throw new TypeError('Invalid CLI arguments')
      optional ||= !argument.required
      argumentNames.add(argument.name)
    }
    const children = new Set<string>()
    for (const child of command.commands ?? []) {
      if (children.has(child.name)) throw new TypeError('Duplicate CLI child command')
      children.add(child.name); validate(child, options)
    }
  }
  for (const registration of registrations) {
    if (registration.contractVersion !== 1 || !registration.appId || appIds.has(registration.appId) || names.has(registration.command.name) || typeof registration.load !== 'function') throw new TypeError('Invalid or duplicate CLI registration')
    names.add(registration.command.name); appIds.add(registration.appId)
    validate(registration.command, new Set([...globals.map(option => option.name), 'version']))
  }
  // Capture metadata so a later mutation by the caller cannot alter dispatch after validation.
  const freezeCommand = (command: CliCommand): CliCommand => Object.freeze({ ...command,
    options: Object.freeze((command.options ?? []).map(option => Object.freeze({ ...option }))),
    arguments: Object.freeze((command.arguments ?? []).map(argument => Object.freeze({ ...argument }))),
    commands: Object.freeze((command.commands ?? []).map(freezeCommand)),
  })
  return Object.freeze(registrations.map(registration => Object.freeze({ ...registration, command: freezeCommand(registration.command) })))
}

export interface ParsedCli { readonly command: CliCommand; readonly invocation: CliInvocation; readonly help: boolean; readonly json: boolean; readonly version: boolean; readonly options: readonly CliOption[] }
export interface CliRunConfig {
  readonly name?: string
  readonly version: string
  readonly description?: string
  /** Mount one registered app at a standalone binary's root; execution retains its canonical path. */
  readonly application?: string
}
export function parseCli(args: readonly string[], root: CliCommand): ParsedCli {
  let command = root, literal = false
  const path: string[] = [], positionals: string[] = [], options: Record<string, string | boolean> = Object.create(null)
  const available: CliOption[] = [...globals, { name: 'version', type: 'boolean', description: 'Show CLI version' }, ...root.options ?? []]
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!
    if (!literal && token === '--') { literal = true; continue }
    if (!literal && (token.startsWith('-') && token !== '-')) {
      const normalized = token === '-h' ? '--help' : token
      const match = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/s.exec(normalized)
      const option = match && available.find(option => option.name === match[1])
      // Never reflect raw arguments: a user may accidentally pass a secret as an option.
      if (!option || Object.hasOwn(options, option.name)) throw usageFailure('Unknown or repeated option; use --help')
      if (option.type === 'boolean') {
        if (match![2] !== undefined) throw usageFailure('Boolean options do not accept values')
        options[option.name] = true
      } else {
        const value = match![2] ?? args[++index]
        if (value === undefined || value === '' || (match![2] === undefined && value.startsWith('--'))) throw usageFailure(`Option --${option.name} requires a value`)
        options[option.name] = value
      }
    } else if (command.commands?.length && !literal) {
      const child = command.commands.find(child => child.name === token)
      if (!child) throw usageFailure('Unknown command; use --help')
      command = child; path.push(child.name); available.push(...child.options ?? [])
    } else positionals.push(token)
  }
  const help = options.help === true, version = options.version === true
  if (!help && !version) {
    if (positionals.length > (command.arguments?.length ?? 0) || (command.arguments ?? []).some((arg, i) => arg.required && positionals[i] === undefined)) throw usageFailure('Missing or extra positional arguments; use --help')
    for (const option of available) if (option.required && options[option.name] === undefined) throw usageFailure(`Option --${option.name} is required`)
  }
  return { command, invocation: { path, arguments: positionals, options }, help, json: options.json === true, version, options: available }
}

export function cliHelp(name: string, parsed: ParsedCli): string {
  const command = parsed.command
  return `Usage: ${[name, ...parsed.invocation.path, ...(command.commands?.length ? ['<command>'] : []), ...(command.arguments ?? []).map(arg => arg.required ? `<${arg.name}>` : `[${arg.name}]`)].join(' ')} [options]\n${command.description}\n` +
    (command.commands?.length ? '\nCommands:\n' + command.commands.map(child => `  ${child.name.padEnd(22)} ${child.description}\n`).join('') : '') +
    '\nOptions:\n' + parsed.options.map(option => `  --${option.name}${option.type === 'string' ? ' <value>' : ''}${option.required ? ' (required)' : ''}  ${option.description}\n`).join('')
}

export async function runApplicationCli(args: readonly string[], registrations: readonly ApplicationCliRegistration[], io: CliIo,
  config: CliRunConfig): Promise<CliExitCode> {
  const name = config.name ?? 'anybox'
  let json = args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--')).includes('--json')
  const emit = async (data: CliJson, text?: string, type: 'result' | 'request' | 'accepted' | 'snapshot' = 'result') => {
    await io.stdout(json ? JSON.stringify({ schemaVersion: 1, type, data }) + '\n' : (text ?? JSON.stringify(data, null, 2)) + '\n')
  }
  try {
    const registry = registerApplicationClis(registrations)
    const mounted = config.application ? registry.find(registration => registration.command.name === config.application) : undefined
    if (config.application && !mounted) throw new TypeError('Standalone CLI application is not registered')
    const root: CliCommand = mounted?.command ?? { name: 'anybox', description: config.description ?? 'Anybox application commands', commands: registry.map(registration => registration.command) }
    if (args[0] === 'completion') {
      const words = args.slice(1).filter(token => token !== '--json')
      if (words.some(token => token.startsWith('-'))) throw usageFailure('Completion expects a command path')
      const parsed = parseCli([...words, '--help'], root)
      const candidates = [...(parsed.command.commands ?? []).map(child => child.name), ...parsed.options.map(option => `--${option.name}`)]
      await emit(candidates, candidates.join('\n')); return cliExit.ok
    }
    const parsed = parseCli(args[0] === 'help' ? [...args.slice(1), '--help'] : args, root)
    json = parsed.json
    if (parsed.version) { await emit({ name, version: config.version }, `${name} ${config.version}`); return cliExit.ok }
    if (parsed.help || parsed.command.commands?.length || !parsed.invocation.path.length) {
      await emit({ path: parsed.invocation.path, command: parsed.command as unknown as CliJson, options: parsed.options as unknown as CliJson }, cliHelp(name, parsed)); return cliExit.ok
    }
    io.signal.throwIfAborted()
    const registration = mounted ?? registry.find(registration => registration.command.name === parsed.invocation.path[0])!
    const module = await registration.load()
    io.signal.throwIfAborted()
    const invocation = mounted ? { ...parsed.invocation, path: [mounted.command.name, ...parsed.invocation.path] } : parsed.invocation
    const code = await module.execute(invocation, { ...io, json, emit }) ?? cliExit.ok
    if (!Object.values(cliExit).includes(code)) throw new TypeError('Invalid CLI exit code')
    return code
  } catch (error) {
    const failure = io.signal.aborted ? cliFailure('cancelled', 'CLI invocation cancelled', cliExit.cancelled)
      : isCliFailure(error) ? error : cliFailure('internal-error', 'CLI invocation failed')
    const output = { code: failure.code, message: failure.message, exitCode: failure.exitCode, ...(failure.details === undefined ? {} : { details: failure.details }) }
    await io.stderr(json ? JSON.stringify({ schemaVersion: 1, type: 'error', error: output }) + '\n' : `${failure.code}: ${failure.message}\n`)
    return failure.exitCode
  }
}

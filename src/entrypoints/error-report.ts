/** One process log entry for a failure: the error, then every AggregateError member and `cause` link on its own indented line. */
export function describeError(error: unknown, depth = 0): string {
  const indent = '  '.repeat(depth)
  if (depth > 6) return `${indent}…`
  if (!(error instanceof Error)) return `${indent}${String(error)}`
  const lines = [`${indent}${error.name}: ${error.message}`]
  if (error instanceof AggregateError) for (const member of error.errors) lines.push(describeError(member, depth + 1))
  if (error.cause !== undefined) lines.push(`${indent}caused by`, describeError(error.cause, depth + 1))
  return lines.join('\n')
}

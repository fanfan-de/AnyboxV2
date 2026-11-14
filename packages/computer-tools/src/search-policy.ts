/** Search exclusions are capability policy, independent of project/session storage. */
export function excludedPath(path: string): boolean {
  const parts = path.split('/')
  return parts.some((part, index) => ['.git', '.hg', '.svn', 'node_modules', '.pnpm-store', '.venv', 'venv'].includes(part) ||
    (parts[index - 1] === '.yarn' && ['cache', 'unplugged'].includes(part)))
}

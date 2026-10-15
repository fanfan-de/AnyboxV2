/** Execute the same Node fixture through the platform's actual default shell. */
export function nodeCommand(script, bash = false) {
  const windowsShell = process.platform === 'win32' && !bash
  const quote = value => windowsShell ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`
  const code = `eval(Buffer.from('${Buffer.from(script).toString('base64')}','base64').toString())`
  const executable = bash && process.platform === 'win32' ? process.execPath.replaceAll('\\', '/') : process.execPath
  return `${windowsShell ? '& ' : ''}${quote(executable)} -e ${quote(code)}`
}

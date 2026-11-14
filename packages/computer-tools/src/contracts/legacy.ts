import type { ToolDefinition } from '@anybox/tool-api'

export const bashToolDefinition: ToolDefinition = Object.freeze({
  name: 'bash',
  description: 'Run a Bash command in the current project directory. The command has the application user\'s filesystem and network access.',
  parameters: Object.freeze({
    type: 'object',
    properties: Object.freeze({ command: Object.freeze({ type: 'string', description: 'Bash command to execute' }) }),
    required: Object.freeze(['command']),
    additionalProperties: false,
  }),
})

export const applyPatchToolDefinition: ToolDefinition = Object.freeze({
  name: 'apply_patch',
  description: 'Use this tool for precise UTF-8 text file edits. Use *** Begin Patch / *** End Patch with *** Add File:, *** Update File:, or *** Delete File: headers. An update may include *** Move to:. Add-file lines start with +; update hunks start with @@ (optionally followed by an exact anchor) and use space, -, and + lines for context, removal, and addition. *** End of File anchors a hunk at EOF. Context must match exactly and uniquely. Example:\n*** Begin Patch\n*** Add File: hello.txt\n+Hello\n*** End Patch\nRelative paths use the current project directory; absolute paths and parent-directory paths use the application user\'s filesystem permissions. All files are checked first, then committed in order. A failure or cancellation may leave completed changes; inspect changes and pending before retrying.',
  parameters: Object.freeze({
    type: 'object',
    properties: Object.freeze({ patch: Object.freeze({ type: 'string', description: 'Complete patch text, including Begin Patch and End Patch markers' }) }),
    required: Object.freeze(['patch']),
    additionalProperties: false,
  }),
})

// What a tool call does, by tool name across Claude Code, GitHub Copilot CLI and VS Code Chat: which ones change or
// read files, run shell commands or commit. Shared by the session parser (for search filters) and the insights panel.
// No imports, so it can be used from anywhere and unit-tested with plain Node.

const WRITE_TOOLS = new Set(['write', 'create', 'create_file', 'copilot_createfile']);
const EDIT_TOOLS = new Set([
  'edit',
  'multiedit',
  'notebookedit',
  'str_replace',
  'apply_patch',
  'insert',
  'copilot_editfile',
  'copilot_replacestring',
  'copilot_multireplacestring',
  'copilot_insertedit',
  'copilot_applypatch',
]);
const READ_TOOLS = new Set(['read', 'view', 'read_file', 'copilot_readfile']);
const SHELL_TOOLS = new Set(['bash', 'powershell', 'shell', 'run_in_terminal', 'copilot_runinterminal']);

export type FileAccess = 'write' | 'edit' | 'read';

/** Kind of file access a tool call is, or undefined when it isn't one. */
export function fileAccess(name: string, input: Record<string, unknown> | undefined): FileAccess | undefined {
  const n = name.toLowerCase();
  if (n === 'str_replace_editor') {
    const cmd = input?.command;
    return cmd === 'view' ? 'read' : cmd === 'create' ? 'write' : 'edit';
  }
  if (WRITE_TOOLS.has(n)) {
    return 'write';
  }
  if (EDIT_TOOLS.has(n)) {
    return 'edit';
  }
  if (READ_TOOLS.has(n)) {
    return 'read';
  }
  return undefined;
}

/** The file a tool call names. */
export function filePathOf(input: Record<string, unknown> | undefined): string | undefined {
  for (const key of ['file_path', 'notebook_path', 'filePath', 'path']) {
    const v = input?.[key];
    if (typeof v === 'string' && v.trim()) {
      return v.trim();
    }
  }
  return undefined;
}

export const isShellTool = (name: string) => SHELL_TOOLS.has(name.toLowerCase());

/** A shell command that runs `git commit`. */
export const isCommitCommand = (command: string) => /\bgit\b[^|;&\n]*\bcommit\b/.test(command);

/** `[main 1a2b3c4] Subject` and `[main (root-commit) 1a2b3c4] Subject`, as git commit prints them. */
export const COMMIT_LINE = /^\[([^\s\]]+)(?: \([^)]*\))? ([0-9a-f]{7,40})\] (.+)$/gm;

/**
 * The subject of the message a `git commit` command passes inline: `-m "…"` or a heredoc (`-F - <<'EOF'`).
 * Undefined when the message comes from elsewhere (an editor, a file).
 */
export function commitSubject(command: string): string | undefined {
  const m = /\bcommit\b[^\n]*?(?:-m|--message)[ =](?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/.exec(command);
  if (m) {
    const msg = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
    return msg.split('\n')[0].trim() || undefined;
  }
  const h = /\bcommit\b[^\n]*<<-?\s*['"]?(\w+)['"]?[^\n]*\n([\s\S]*)/.exec(command);
  if (h) {
    const first = h[2].split('\n').find((l) => l.trim());
    return first && first.trim() !== h[1] ? first.trim() : undefined;
  }
  return undefined;
}

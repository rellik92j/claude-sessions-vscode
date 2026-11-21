// What a session did, gathered from its transcript for the transcript's side panel: files changed and read, commits,
// pull requests, skills and slash commands, subagents, web lookups and tool use.
// No VS Code imports here so it can be unit-tested with plain Node.

import { TranscriptEntry, TranscriptPart } from './sessionParser';

type ToolPart = Extract<TranscriptPart, { kind: 'tool_use' }>;

export interface FileTouch {
  path: string;
  /** Times a tool changed it (edits and writes) or read it. */
  count: number;
  /** A tool created or overwrote it whole, rather than editing part of it. */
  written?: boolean;
}

export interface Commit {
  hash: string;
  branch: string;
  subject: string;
}

export interface SessionInsights {
  changed: FileTouch[];
  read: FileTouch[];
  commits: Commit[];
  /** Subjects of commits made quietly (`git commit -q`), whose hashes the log doesn't show. */
  unresolvedCommits: string[];
  /** Pull request URLs that `gh pr create` printed. */
  pullRequests: string[];
  /** Skills Claude loaded with the Skill tool, with how often. */
  skills: { name: string; count: number }[];
  /** Slash commands typed as prompts ("/model", "/start-change …"), by name. */
  commands: { name: string; count: number }[];
  subagents: { type: string; description: string }[];
  web: { kind: 'fetch' | 'search'; text: string }[];
  /** MCP servers whose tools were called, with call counts. */
  mcpServers: { name: string; count: number }[];
  tools: { name: string; count: number; failed: number }[];
  /** The user's prompts in order, for jumping around the transcript; `index` is the entry's position. */
  prompts: { index: number; text: string }[];
  failedTools: number;
}

const WRITE_TOOLS = new Set(['write', 'create', 'create_file', 'copilot_createfile']);
const EDIT_TOOLS = new Set(['edit', 'multiedit', 'notebookedit', 'str_replace', 'apply_patch', 'insert', 'copilot_editfile', 'copilot_replacestring', 'copilot_insertedit', 'copilot_applypatch']);
const READ_TOOLS = new Set(['read', 'view', 'read_file', 'copilot_readfile']);
const SHELL_TOOLS = new Set(['bash', 'powershell', 'shell', 'run_in_terminal', 'copilot_runinterminal']);

/** `[main 1a2b3c4] Subject` and `[main (root-commit) 1a2b3c4] Subject`, as git commit prints them. */
const COMMIT_LINE = /^\[([^\s\]]+)(?: \([^)]*\))? ([0-9a-f]{7,40})\] (.+)$/gm;
const PR_URL = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/g;

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

function filePath(args: Record<string, string> | undefined): string | undefined {
  const p = args?.file_path ?? args?.notebook_path ?? args?.filePath ?? args?.path;
  return p?.trim() || undefined;
}

/** Kind of file access a tool call is, or undefined when it isn't one. */
function fileAccess(t: ToolPart): 'write' | 'edit' | 'read' | undefined {
  const name = t.name.toLowerCase();
  if (name === 'str_replace_editor') {
    const cmd = t.args?.command;
    return cmd === 'view' ? 'read' : cmd === 'create' ? 'write' : 'edit';
  }
  if (WRITE_TOOLS.has(name)) {
    return 'write';
  }
  if (EDIT_TOOLS.has(name)) {
    return 'edit';
  }
  if (READ_TOOLS.has(name)) {
    return 'read';
  }
  return undefined;
}

function bump<T extends { count: number }>(map: Map<string, T>, key: string, make: () => T): T {
  let v = map.get(key);
  if (!v) {
    v = make();
    map.set(key, v);
  }
  v.count++;
  return v;
}

const byCount = <T extends { count: number }>(a: T, b: T) => b.count - a.count;

export function collectInsights(entries: TranscriptEntry[]): SessionInsights {
  const changed = new Map<string, FileTouch>();
  const read = new Map<string, FileTouch>();
  const commits = new Map<string, Commit>();
  const pullRequests = new Set<string>();
  const unresolved = new Set<string>();
  const skills = new Map<string, { name: string; count: number }>();
  const commands = new Map<string, { name: string; count: number }>();
  const mcp = new Map<string, { name: string; count: number }>();
  const tools = new Map<string, { name: string; count: number; failed: number }>();
  const subagents: SessionInsights['subagents'] = [];
  const web: SessionInsights['web'] = [];
  const prompts: SessionInsights['prompts'] = [];
  let failedTools = 0;

  entries.forEach((e, index) => {
    if (e.role === 'user') {
      const text = e.parts.map((p) => (p.kind === 'text' ? p.text : '')).join(' ').trim();
      const cmd = /^\/([\w:.-]+)/.exec(text);
      if (cmd) {
        bump(commands, cmd[1], () => ({ name: `/${cmd[1]}`, count: 0 }));
      }
      if (text) {
        prompts.push({ index, text });
      }
      return;
    }
    for (const p of e.parts) {
      if (p.kind !== 'tool_use') {
        continue;
      }
      const name = p.name.toLowerCase();
      const failed = !!p.result?.isError;
      const tool = bump(tools, p.name, () => ({ name: p.name, count: 0, failed: 0 }));
      if (failed) {
        tool.failed++;
        failedTools++;
      }
      const mcpServer = /^mcp__(.+?)__/.exec(p.name)?.[1];
      if (mcpServer) {
        const label = mcpServer.replace(/^claude_ai_|^plugin_/, '').replace(/_/g, ' ');
        bump(mcp, label, () => ({ name: label, count: 0 }));
      }

      const access = fileAccess(p);
      const file = access && !failed ? filePath(p.args) : undefined;
      if (file && access) {
        const target = access === 'read' ? read : changed;
        const touch = bump<FileTouch>(target, file, () => ({ path: file, count: 0 }));
        if (access === 'write') {
          touch.written = true;
        }
      }

      if (name === 'skill' && p.args?.skill) {
        const skill = p.args.skill;
        bump(skills, skill, () => ({ name: skill, count: 0 }));
      } else if ((name === 'agent' || name === 'task') && (p.args?.description || p.args?.subagent_type)) {
        subagents.push({ type: p.args?.subagent_type || 'general-purpose', description: p.args?.description ?? '' });
      } else if ((name === 'webfetch' || name === 'web_fetch' || name === 'fetch') && p.args?.url) {
        web.push({ kind: 'fetch', text: p.args.url });
      } else if (name === 'websearch' && p.args?.query) {
        web.push({ kind: 'search', text: p.args.query });
      } else if (SHELL_TOOLS.has(name) && p.result && !failed) {
        const command = p.args?.command ?? '';
        if (/\bgit\b[^|;&\n]*\bcommit\b/.test(command)) {
          let found = false;
          for (const m of p.result.text.matchAll(COMMIT_LINE)) {
            commits.set(m[2], { branch: m[1], hash: m[2], subject: m[3].trim() });
            found = true;
          }
          // `git commit -q` prints nothing; the caller can look the subject up in the repository.
          const subject = found ? undefined : commitSubject(command);
          if (subject) {
            unresolved.add(subject);
          }
        }
        if (/\bgh\s+pr\s+create\b/.test(command)) {
          for (const url of p.result.text.match(PR_URL) ?? []) {
            pullRequests.add(url);
          }
        }
      }
    }
  });

  // A file read and then changed is listed once, under changed.
  for (const key of changed.keys()) {
    read.delete(key);
  }
  return {
    changed: [...changed.values()],
    read: [...read.values()].sort(byCount),
    commits: [...commits.values()],
    unresolvedCommits: [...unresolved].filter((subj) => ![...commits.values()].some((c) => c.subject === subj)),
    pullRequests: [...pullRequests],
    skills: [...skills.values()].sort(byCount),
    commands: [...commands.values()].sort(byCount),
    subagents,
    web,
    mcpServers: [...mcp.values()].sort(byCount),
    tools: [...tools.values()].sort(byCount),
    prompts,
    failedTools,
  };
}

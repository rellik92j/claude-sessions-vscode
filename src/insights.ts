// What a session did, gathered from its transcript for the transcript's side panel: files changed and read, commits,
// pull requests, the todo list, skills and slash commands, subagents, web lookups, tool use and each prompt's cost.
// No VS Code imports here so it can be unit-tested with plain Node.

import { TranscriptEntry, TranscriptPart, TurnStats } from './sessionParser';
import { COMMIT_LINE, commitSubject, fileAccess, filePathOf, isCommitCommand, isShellTool } from './tools';

export { commitSubject } from './tools';

type ToolPart = Extract<TranscriptPart, { kind: 'tool_use' }>;

export interface FileTouch {
  path: string;
  /** Times a tool changed it (edits and writes) or read it. */
  count: number;
  /** A tool created or overwrote it whole, rather than editing part of it. */
  written?: boolean;
  /** The replaced and replacement text of each edit, in order (truncated like the transcript's diffs). */
  edits?: { before: string; after: string }[];
}

export interface Commit {
  hash: string;
  branch: string;
  subject: string;
}

export type TodoStatus = 'pending' | 'active' | 'done';

export interface Todo {
  text: string;
  status: TodoStatus;
}

export interface SessionInsights {
  changed: FileTouch[];
  read: FileTouch[];
  commits: Commit[];
  /** Subjects of commits made quietly (`git commit -q`), whose hashes the log doesn't show. */
  unresolvedCommits: string[];
  /** Pull request URLs that `gh pr create` printed. */
  pullRequests: string[];
  /** The todo list as the session last left it. */
  todos: Todo[];
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
  prompts: { index: number; text: string; turn?: TurnStats }[];
  failedTools: number;
}

const PR_URL = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/g;

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

function todoStatus(value: unknown): TodoStatus {
  const s = String(value ?? '').toLowerCase().replace(/[\s_-]/g, '');
  return s === 'completed' || s === 'done' || s === 'x' ? 'done' : s === 'inprogress' || s === 'active' ? 'active' : 'pending';
}

function parseJsonArray(text: string | undefined): any[] | undefined {
  if (!text) {
    return undefined;
  }
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Keeps the todo list current through the tools that write one: Claude Code's TodoWrite (the whole list each time) and
 * TaskCreate/TaskUpdate (one task at a time), Copilot CLI's update_todo (a markdown checklist) and VS Code Chat's
 * todo list tool.
 */
class TodoTracker {
  private list: Todo[] = [];
  private readonly tasks = new Map<string, Todo>();
  private nextTask = 1;

  add(t: ToolPart): void {
    const name = t.name.toLowerCase();
    const args = t.args ?? {};
    if (name === 'todowrite') {
      const todos = parseJsonArray(args.todos);
      if (todos) {
        this.tasks.clear();
        this.list = todos.filter((x) => x && typeof x.content === 'string').map((x) => ({ text: x.content, status: todoStatus(x.status) }));
      }
    } else if (name === 'taskcreate' && args.subject) {
      const id = /#(\d+)/.exec(t.result?.text ?? '')?.[1] ?? String(this.nextTask);
      this.nextTask = Math.max(this.nextTask, Number(id) + 1);
      const todo: Todo = { text: args.subject, status: 'pending' };
      this.tasks.set(id, todo);
      this.list.push(todo);
    } else if (name === 'taskupdate' && args.taskId) {
      const todo = this.tasks.get(args.taskId);
      if (todo) {
        if (args.status === 'deleted') {
          this.list = this.list.filter((x) => x !== todo);
          this.tasks.delete(args.taskId);
        } else {
          todo.status = args.status ? todoStatus(args.status) : todo.status;
          todo.text = args.subject || todo.text;
        }
      }
    } else if (name === 'update_todo' && args.todos) {
      const items = [...args.todos.matchAll(/^\s*[-*]\s*\[([ xX~-])\]\s*(.+)$/gm)];
      if (items.length) {
        this.list = items.map((m) => ({ text: m[2].trim(), status: m[1].toLowerCase() === 'x' ? 'done' : m[1] === ' ' ? 'pending' : 'active' }));
      }
    } else if (/todo/.test(name)) {
      const todos = parseJsonArray(args.todoList);
      if (todos) {
        this.list = todos.filter((x) => x && typeof x.title === 'string').map((x) => ({ text: x.title, status: todoStatus(x.status) }));
      }
    }
  }

  get todos(): Todo[] {
    return this.list.map((t) => ({ ...t }));
  }
}

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
  const todos = new TodoTracker();
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
        prompts.push({ index, text, turn: e.turn });
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
      if (!failed) {
        todos.add(p);
      }

      const access = fileAccess(p.name, p.args);
      const file = access && !failed ? filePathOf(p.args) : undefined;
      if (file && access) {
        const target = access === 'read' ? read : changed;
        const touch = bump<FileTouch>(target, file, () => ({ path: file, count: 0 }));
        if (access === 'write') {
          touch.written = true;
        }
        if (p.diff) {
          (touch.edits ??= []).push(p.diff);
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
      } else if (isShellTool(name) && p.result && !failed) {
        const command = p.args?.command ?? '';
        if (isCommitCommand(command)) {
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
    todos: todos.todos,
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

/**
 * The session's edits of one file as a unified-diff-style document, for when there is no repository to compare
 * against. Each edit is a hunk of the replaced and replacement text; whole-file writes are noted, not shown.
 */
export function editsAsDiff(file: FileTouch): string {
  const lines = [`--- ${file.path} (before the session's edits)`, `+++ ${file.path} (after)`];
  if (file.written) {
    lines.push('', '# The session wrote this file whole; its full content is not kept in the log.');
  }
  (file.edits ?? []).forEach((edit, i) => {
    lines.push(`@@ edit ${i + 1} of ${file.edits!.length} @@`);
    for (const l of edit.before.split('\n')) {
      lines.push(`-${l}`);
    }
    for (const l of edit.after.split('\n')) {
      lines.push(`+${l}`);
    }
  });
  return lines.join('\n') + '\n';
}

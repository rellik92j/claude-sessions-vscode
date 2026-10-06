// Builds the first prompt for "Continue in New Session": a short handoff describing where an earlier session left off.
// No VS Code imports, so it can be unit-tested with plain Node.

import * as path from 'path';
import { isInside } from './format';
import { classifyUserContent, records, SessionInfo } from './sessionParser';

export interface HandoffFacts {
  lastPrompt?: string;
  lastReply?: string;
  /** Files changed with Claude's edit tools, oldest first. Edits made through shell commands are not seen. */
  modified: string[];
  /** Files read but not modified, oldest first. */
  read: string[];
  /** Unfinished items from the latest TodoWrite, if the session used one. */
  todos: { content: string; status: string }[];
}

const MODIFY_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Collects what the handoff needs from a session log (main thread only, like the transcript). */
export function collectHandoffFacts(text: string): HandoffFacts {
  const facts: HandoffFacts = { modified: [], read: [], todos: [] };
  // Insertion order follows first use; re-adding moves a file to the end so the most recent ones survive the cap.
  const modified = new Set<string>();
  const read = new Set<string>();
  const touch = (set: Set<string>, file: string) => {
    set.delete(file);
    set.add(file);
  };
  // Everything Claude wrote since the last prompt: a finished turn ends with its summary, but an interrupted one may
  // end on a one-line "Now tests.", so the whole turn is kept (and clipped from the front later).
  let turn: string[] = [];
  for (const r of records(text)) {
    if (!r || typeof r !== 'object' || r.isSidechain || r.isMeta || r.isCompactSummary) {
      continue;
    }
    const content = r.message?.content;
    if (r.type === 'user') {
      const c = classifyUserContent(content);
      if (c.kind === 'prompt') {
        facts.lastPrompt = c.text;
        turn = [];
      }
      continue;
    }
    if (r.type !== 'assistant' || !Array.isArray(content)) {
      continue;
    }
    for (const p of content) {
      if (p?.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
        turn.push(p.text.trim());
      } else if (p?.type === 'tool_use') {
        const file = p.input?.file_path ?? p.input?.notebook_path;
        if (typeof file === 'string' && file) {
          if (MODIFY_TOOLS.has(p.name)) {
            touch(modified, file);
          } else if (p.name === 'Read') {
            touch(read, file);
          }
        }
        if (p.name === 'TodoWrite' && Array.isArray(p.input?.todos)) {
          facts.todos = p.input.todos
            .filter((t: any) => t && typeof t.content === 'string' && t.status !== 'completed')
            .map((t: any) => ({ content: t.content, status: String(t.status ?? 'pending') }));
        }
      }
    }
  }
  facts.lastReply = turn.length ? turn.join('\n\n') : undefined;
  facts.modified = [...modified];
  facts.read = [...read].filter((f) => !modified.has(f));
  return facts;
}

/** Windows allows ~32k characters on a command line and the handoff is passed as an argument; stay well under. */
export const MAX_HANDOFF = 8000;

interface Limits {
  text: number;
  files: number;
}

// Tried in order until the handoff fits.
const LIMITS: Limits[] = [
  { text: 2000, files: 30 },
  { text: 1200, files: 15 },
  { text: 600, files: 8 },
];

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? t.slice(0, max).trimEnd() + ' […]' : t;
}

/** Keeps the end, where a turn's conclusion is. */
function clipStart(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? '[…] ' + t.slice(t.length - max).trimStart() : t;
}

/**
 * Project files relative to the project folder, newest last. Files outside it (scratch files, temp output) are only
 * counted, since they rarely matter to the next session and their long paths crowd out the ones that do.
 */
function fileList(files: string[], cwd: string | undefined, max: number): string {
  const inside = cwd ? files.filter((f) => isInside(f, cwd)) : files;
  const shown = inside.slice(-max).map((f) => `- ${(cwd && path.relative(cwd, f)) || f}`);
  const earlier = inside.length - shown.length;
  const outside = files.length - inside.length;
  return [
    earlier > 0 ? `- … ${earlier} earlier` : '',
    ...shown,
    outside > 0 ? `- … and ${outside} outside the project` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The prompt that starts the new session. It ends by asking Claude to summarise and wait, because the CLI sends a
 * prompt given on the command line straight away.
 */
export function buildHandoff(session: SessionInfo, facts: HandoffFacts, cwd: string | undefined, gitStatus?: string): string {
  for (const lim of LIMITS) {
    const text = render(session, facts, cwd, gitStatus, lim);
    if (text.length <= MAX_HANDOFF) {
      return text;
    }
  }
  return clip(render(session, facts, cwd, gitStatus, LIMITS[LIMITS.length - 1]), MAX_HANDOFF - 10);
}

function render(session: SessionInfo, f: HandoffFacts, cwd: string | undefined, gitStatus: string | undefined, lim: Limits): string {
  const about = [`"${session.title}"`, session.gitBranch && `on branch ${session.gitBranch}`, session.prUrl && `PR ${session.prUrl}`]
    .filter(Boolean)
    .join(', ');
  const out = [
    `I'm continuing work from an earlier Claude Code session (${about}). This is a handoff of where it left off.`,
  ];
  if (f.lastPrompt) {
    out.push(`## My last request\n${clip(f.lastPrompt, lim.text)}`);
  }
  if (f.lastReply) {
    out.push(`## Your last reply\n${clipStart(f.lastReply, lim.text)}`);
  }
  if (f.todos.length) {
    out.push(`## Unfinished to-dos\n${f.todos.slice(0, lim.files).map((t) => `- [${t.status}] ${t.content}`).join('\n')}`);
  }
  if (f.modified.length) {
    out.push(`## Files changed with edit tools\n${fileList(f.modified, cwd, lim.files)}`);
  }
  if (f.read.length) {
    out.push(`## Files read\n${fileList(f.read, cwd, lim.files)}`);
  }
  const status = gitStatus?.trim();
  if (status) {
    const lines = status.split(/\r?\n/);
    const shown = lines.slice(0, lim.files * 2);
    const more = lines.length - shown.length;
    out.push(`## Working tree now (git status)\n\`\`\`\n${shown.join('\n')}${more > 0 ? `\n… ${more} more` : ''}\n\`\`\``);
  }
  out.push(
    `The full earlier transcript is at ${session.filePath} (session ${session.id}) if you need more detail.\n\n` +
      'Before changing anything, briefly summarise where things stand and what you think the next step is, then wait for my instruction.',
  );
  return out.join('\n\n');
}

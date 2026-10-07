// Builds the first prompt for "Continue in New Session": a short handoff describing where an earlier session left off.
// No VS Code imports, so it can be unit-tested with plain Node.

import * as os from 'os';
import * as path from 'path';
import { isInside } from './format';
import { classifyUserContent, records, SessionInfo } from './sessionParser';

export interface HandoffFacts {
  lastPrompt?: string;
  /** The prompt before the last one, which gives a short last prompt ("yes, ship it") its subject. */
  previousPrompt?: string;
  lastReply?: string;
  /** True when lastReply is the whole last turn (its final message was too short to stand alone), so keep its end. */
  replyIsWholeTurn?: boolean;
  /** Files changed with Claude's edit tools, oldest first. Edits made through shell commands are not seen. */
  modified: string[];
  /** Files read but not modified, oldest first. */
  read: string[];
  /** Unfinished items from the latest TodoWrite, if the session used one. */
  todos: { content: string; status: string }[];
  /** Skills Claude invoked or the user typed as /name (plugin skills as "plugin:skill"), in first-use order. */
  skills: string[];
  /** MCP servers (connectors, plugin servers) whose tools the session called, as their tool prefix "mcp__<server>". */
  mcpServers: string[];
}

const MODIFY_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** A final message shorter than this ("Now tests.") is probably an interrupted turn, so the whole turn is used. */
const MIN_FINAL_REPLY = 200;

/** A last prompt shorter than this gets the prompt before it too. */
const SHORT_PROMPT = 300;

/** How Claude Code opens the message that loads a skill, whether Claude invoked it or the user typed /name. */
const SKILL_LOAD = /^Base directory for this skill:/;

function contentText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  const first = Array.isArray(content) ? content.find((p) => p?.type === 'text') : undefined;
  return typeof first?.text === 'string' ? first.text : '';
}

/** Collects what the handoff needs from a session log (main thread only, like the transcript). */
export function collectHandoffFacts(text: string): HandoffFacts {
  const facts: HandoffFacts = { modified: [], read: [], todos: [], skills: [], mcpServers: [] };
  const skills = new Set<string>();
  const mcpServers = new Set<string>();
  // Insertion order follows first use; re-adding moves a file to the end so the most recent ones survive the cap.
  const modified = new Set<string>();
  const read = new Set<string>();
  const touch = (set: Set<string>, file: string) => {
    set.delete(file);
    set.add(file);
  };
  // The reply is the turn's final message (the text after its last tool call), which is what the user read. An
  // interrupted turn may end on a one-line "Now tests.", so the whole turn is kept too as a fallback.
  let turn: string[] = [];
  let final: string[] = [];
  const newPrompt = (prompt: string) => {
    facts.previousPrompt = facts.lastPrompt;
    facts.lastPrompt = prompt;
    turn = [];
    final = [];
  };
  // A slash command the user typed ("/ship-change looks good"). It is a skill, and so a request, only if the next
  // record loads a skill; built-ins like /effort or /clear load nothing.
  let command: string | undefined;
  for (const r of records(text)) {
    if (!r || typeof r !== 'object' || r.isSidechain || r.isCompactSummary) {
      continue;
    }
    const content = r.message?.content;
    if (r.isMeta) {
      if (command && r.type === 'user' && !r.sourceToolUseID && SKILL_LOAD.test(contentText(content))) {
        skills.add(command.split(/\s/)[0].replace(/^\//, ''));
        newPrompt(command);
      }
      command = undefined;
      continue;
    }
    if (r.type === 'user') {
      const c = classifyUserContent(content);
      command = c.kind === 'command' ? c.text : undefined;
      if (c.kind === 'prompt') {
        newPrompt(c.text);
      }
      continue;
    }
    command = undefined;
    if (r.type !== 'assistant' || !Array.isArray(content)) {
      continue;
    }
    for (const p of content) {
      if (p?.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
        turn.push(p.text.trim());
        final.push(p.text.trim());
      } else if (p?.type === 'tool_use') {
        final = [];
        if (p.name === 'Skill' && typeof p.input?.skill === 'string' && p.input.skill) {
          skills.add(p.input.skill.replace(/^\//, ''));
        }
        const server = typeof p.name === 'string' && /^mcp__(.+?)__/.exec(p.name)?.[1];
        if (server) {
          mcpServers.add(`mcp__${server}`);
        }
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
  const finalText = final.join('\n\n');
  const turnText = turn.join('\n\n');
  if (finalText.length >= MIN_FINAL_REPLY || (finalText && finalText === turnText)) {
    facts.lastReply = finalText;
  } else if (turnText) {
    facts.lastReply = turnText;
    facts.replyIsWholeTurn = true;
  }
  facts.skills = [...skills];
  facts.mcpServers = [...mcpServers];
  facts.modified = [...modified];
  facts.read = [...read].filter((f) => !modified.has(f));
  return facts;
}

/** Windows allows ~32k characters on a command line and the handoff is passed as an argument; stay well under. */
export const MAX_HANDOFF = 16000;

interface Limits {
  text: number;
  files: number;
}

// Tried in order until the handoff fits.
const LIMITS: Limits[] = [
  { text: 4000, files: 30 },
  { text: 2500, files: 15 },
  { text: 1200, files: 8 },
];

function clip(text: string, max: number, more = ' […]'): string {
  const t = text.trim();
  return t.length > max ? t.slice(0, max).trimEnd() + more : t;
}

/** Keeps the end, where a turn's conclusion is. */
function clipStart(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? '[…] ' + t.slice(t.length - max).trimStart() : t;
}

/**
 * Scratch files, temp output and Claude Code's saved tool output: the earlier session's own working files, of no use
 * to the next one.
 */
function isScratch(file: string): boolean {
  return (
    isInside(file, os.tmpdir()) || /[\\/]Temp[\\/]claude[\\/]|[\\/]tool-results[\\/]/i.test(file) || file.startsWith('/tmp/')
  );
}

/**
 * Project files relative to the project folder, newest last, then files under ~/.claude (memory, plans, skills), which
 * the next session may need. Scratch files are left out, and anything else outside the project is only counted.
 */
function fileList(files: string[], cwd: string | undefined, max: number): string {
  const home = os.homedir();
  const claudeDir = path.join(home, '.claude');
  const inside = cwd ? files.filter((f) => isInside(f, cwd)) : files;
  const rest = files.filter((f) => !inside.includes(f) && !isScratch(f));
  const claude = rest.filter((f) => isInside(f, claudeDir));
  const shown = inside.slice(-max).map((f) => `- ${(cwd && path.relative(cwd, f)) || f}`);
  const earlier = inside.length - shown.length;
  const other = rest.length - claude.length;
  return [
    earlier > 0 ? `- … ${earlier} earlier` : '',
    ...shown,
    ...claude.slice(-max).map((f) => `- ~${path.sep}${path.relative(home, f)}`),
    other > 0 ? `- … and ${other} other file${other === 1 ? '' : 's'} outside the project` : '',
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
    if (f.previousPrompt && f.lastPrompt.trim().length < SHORT_PROMPT) {
      out.push(`## The request before that\n${clip(f.previousPrompt, lim.text / 2)}`);
    }
  }
  if (f.lastReply) {
    const reply = f.replyIsWholeTurn ? clipStart(f.lastReply, lim.text) : clip(f.lastReply, lim.text, ' […] (rest in the transcript)');
    out.push(`## Your last reply\n${reply}`);
  }
  if (f.todos.length) {
    out.push(`## Unfinished to-dos\n${f.todos.slice(0, lim.files).map((t) => `- [${t.status}] ${t.content}`).join('\n')}`);
  }
  const used = [
    f.skills?.length ? `- Skills: ${f.skills.slice(0, lim.files).join(', ')}` : '',
    f.mcpServers?.length ? `- Connectors and MCP servers (tool prefixes): ${f.mcpServers.slice(0, lim.files).join(', ')}` : '',
  ].filter(Boolean);
  if (used.length) {
    out.push(`## Skills and connectors used\n${used.join('\n')}`);
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

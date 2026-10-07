// Builds the first prompt for "Continue in New Session": a short handoff describing where an earlier session left off.
// No VS Code imports, so it can be unit-tested with plain Node.

import * as os from 'os';
import * as path from 'path';
import { isInside } from './format';
import { classifyUserContent, records, SessionInfo, TranscriptEntry } from './sessionParser';
import { SessionSource, SOURCES, sourceOf } from './sources';

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
  /**
   * Where the session saved a handoff the user asked for ("save a handoff.md", a handoff skill): files and published
   * URLs, oldest first, so the last is the latest.
   */
  handoffNotes?: string[];
}

const MODIFY_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** A final message shorter than this ("Now tests.") is probably an interrupted turn, so the whole turn is used. */
const MIN_FINAL_REPLY = 200;

/** A last prompt shorter than this gets the prompt before it too. */
const SHORT_PROMPT = 300;

/** How Claude Code opens the message that loads a skill, whether Claude invoked it or the user typed /name. */
const SKILL_LOAD = /^Base directory for this skill:/;

/**
 * A prompt asking for a handoff to be written: "create and save a handoff.md for this session", "write a hand-off
 * doc", "/handoff". Merely talking about handoffs ("does the handoff list files?") doesn't count.
 */
const HANDOFF_REQUEST =
  /\b(?:create|write|save|make|generate|produce|draft|prepare|update|store|put together)\b[^.?!\n]{0,80}\bhand-?(?:off|over)s?\b|\bhand-?(?:off|over)s?(?:\.md\b|\s+(?:doc|document|notes?|file|summary)\b)|^\/\S*hand-?(?:off|over)/i;

/** A skill that writes a handoff, by its name. */
const HANDOFF_SKILL = /hand-?(?:off|over)/i;

/** Notes, not code: a handoff turn may touch other files, but only these are the handoff. */
function isNotesFile(file: string): boolean {
  return /^\.(?:md|markdown|txt|rst|org|adoc)$/i.test(path.extname(file));
}

/** Tools that publish a page and answer with its URL: Artifact, and connector tools that create or update a doc. */
function isPublishTool(name: string, input: any): boolean {
  if (name === 'Artifact') {
    return !input?.action || input.action === 'publish';
  }
  const action = /^mcp__.+?__(.+)$/.exec(name)?.[1] ?? '';
  return /create|publish|write|update|batch|upload|page|doc/i.test(action) && !/read|get|list|search|query|fetch|guide/i.test(action);
}

/** A path argument, optionally quoted. */
const ARG = `(["']?)([^\\s"'|;&<>]+)`;

/**
 * Files a shell command writes: redirections ("cat > notes.md <<EOF"), tee, Out-File / Set-Content / Add-Content, and
 * the destination of a copy or move. Paths with variables are skipped; relative ones are resolved against `cwd`.
 */
export function shellWrites(command: string, cwd?: string): string[] {
  // A heredoc's or here-string's body is text, not commands: "=> x" or "a > b" in a script being written is no write.
  command = command
    .replace(/<<-?\s*(["']?)(\w+)\1([^\n]*)\n[\s\S]*?(?:\n\s*\2\s*(?=\n|$)|$)/g, '<<$2$3')
    .replace(/@(["'])\r?\n[\s\S]*?(?:\r?\n\1@|$)/g, '@$1$1@');
  const found: string[] = [];
  const add = (target: string | undefined, source?: string) => {
    if (!target || target.startsWith('-') || /[$`%]/.test(target) || /^(?:\/dev\/null|nul|&\d)$/i.test(target)) {
      return;
    }
    let file = target.replace(/^~(?=[\\/]|$)/, os.homedir());
    // Git Bash on Windows writes C:\ as /c/.
    if (/^\/[a-z]\//i.test(file) && cwd && /^[A-Za-z]:/.test(cwd)) {
      file = `${file[1].toUpperCase()}:\\${file.slice(3)}`;
    }
    // A copy into a folder keeps its name.
    if (source && (/[\\/]$/.test(file) || (!path.extname(file) && path.extname(source)))) {
      file = path.join(file, path.basename(source));
    }
    const absolute = path.isAbsolute(file) || /^[A-Za-z]:/.test(file);
    found.push(cwd && !absolute ? path.join(cwd, file) : path.normalize(file));
  };
  const each = (re: RegExp, f: (m: RegExpExecArray) => void) => {
    for (let m = re.exec(command); m; m = re.exec(command)) {
      f(m);
    }
  };
  each(new RegExp(`(?<![0-9&>=-])>>?\\s*${ARG}\\1`, 'g'), (m) => add(m[2]));
  each(new RegExp(`\\btee\\s+(?:-a\\s+)?${ARG}\\1`, 'g'), (m) => add(m[2]));
  each(/\b(?:Out-File|Set-Content|Add-Content)\b([^|;\n]*)/gi, (m) => {
    const named = new RegExp(`-(?:FilePath|LiteralPath|Path)\\s+${ARG}\\1`, 'i').exec(m[1]);
    add(named?.[2] ?? new RegExp(`^\\s+${ARG}\\1`).exec(m[1])?.[2]);
  });
  each(new RegExp(`\\b(?:cp|mv|copy|move|Copy-Item|Move-Item)\\s+(?:-\\S+\\s+)*${ARG}\\1\\s+${ARG}\\3`, 'gi'), (m) => add(m[4], m[2]));
  each(new RegExp(`\\b(?:Copy-Item|Move-Item)\\b[^|;\\n]*?-Path\\s+${ARG}\\1[^|;\\n]*?-Destination\\s+${ARG}\\3`, 'gi'), (m) =>
    add(m[4], m[2]),
  );
  return [...new Set(found)];
}

/** The first URL in a tool's result, which is where a publish says the page went. */
function firstUrl(text: string): string | undefined {
  return /https?:\/\/[^\s"'<>)\]]+/.exec(text)?.[0]?.replace(/[.,]+$/, '');
}

/**
 * Follows a handoff the user asked for. A turn whose prompt asks for one, or that runs a handoff skill, is a handoff
 * turn: the notes files it writes and the pages it publishes are the handoff. Later copies (the same file name) count
 * too wherever they go, since a handoff is often saved in more than one place.
 */
class HandoffTracker {
  private readonly notes = new Set<string>();
  private readonly names = new Set<string>();
  active = false;

  prompt(text: string) {
    this.active = HANDOFF_REQUEST.test(text.trim());
  }

  skill(name: string) {
    this.active ||= HANDOFF_SKILL.test(name);
  }

  file(file: string) {
    if (!isNotesFile(file) || /[\\/]tool-results[\\/]/i.test(file)) {
      return;
    }
    const name = path.basename(file).toLowerCase();
    if (this.active || this.names.has(name)) {
      this.names.add(name);
      this.add(file);
    }
  }

  url(url: string | undefined) {
    if (url && this.active) {
      this.add(url);
    }
  }

  private add(note: string) {
    this.notes.delete(note);
    this.notes.add(note);
  }

  get list(): string[] {
    return [...this.notes];
  }
}

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
  const handoff = new HandoffTracker();
  // Publish calls made in a handoff turn, waiting for the result that names their URL.
  const publishes = new Set<string>();
  for (const r of records(text)) {
    if (!r || typeof r !== 'object' || r.isSidechain || r.isCompactSummary) {
      continue;
    }
    const content = r.message?.content;
    if (r.isMeta) {
      if (command && r.type === 'user' && !r.sourceToolUseID && SKILL_LOAD.test(contentText(content))) {
        skills.add(command.split(/\s/)[0].replace(/^\//, ''));
        newPrompt(command);
        handoff.prompt(command);
        handoff.skill(command.split(/\s/)[0]);
      }
      command = undefined;
      continue;
    }
    if (r.type === 'user') {
      const c = classifyUserContent(content);
      command = c.kind === 'command' ? c.text : undefined;
      if (c.kind === 'prompt') {
        newPrompt(c.text);
        handoff.prompt(c.text);
      }
      for (const p of Array.isArray(content) ? content : []) {
        if (p?.type === 'tool_result' && publishes.delete(p.tool_use_id)) {
          const out = typeof p.content === 'string' ? p.content : Array.isArray(p.content) ? p.content.map((c: unknown) => contentText([c])).join('\n') : '';
          handoff.url(firstUrl(out));
        }
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
          handoff.skill(p.input.skill);
        }
        if (handoff.active && typeof p.id === 'string' && typeof p.name === 'string' && isPublishTool(p.name, p.input)) {
          publishes.add(p.id);
        }
        if ((p.name === 'Bash' || p.name === 'PowerShell') && typeof p.input?.command === 'string') {
          shellWrites(p.input.command, typeof r.cwd === 'string' ? r.cwd : undefined).forEach((f) => handoff.file(f));
        }
        const server = typeof p.name === 'string' && /^mcp__(.+?)__/.exec(p.name)?.[1];
        if (server) {
          mcpServers.add(`mcp__${server}`);
        }
        const file = p.input?.file_path ?? p.input?.notebook_path;
        if (typeof file === 'string' && file) {
          if (MODIFY_TOOLS.has(p.name)) {
            touch(modified, file);
            handoff.file(file);
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
  facts.handoffNotes = handoff.list;
  return facts;
}

/** Tool names (Claude Code's, Copilot CLI's, VS Code Chat's) that change or read a file. */
const MODIFY_TOOL = /edit|write|create|replace|patch|insert/i;
const SHELL_TOOL = /bash|powershell|shell|terminal|run_?in/i;
const READ_TOOL = /read|view/i;
/** Keys a tool's input names its file by. */
const FILE_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'filename', 'file'];

/** The file a tool call worked on: from its input, or failing that its description ("Read c:/repo/a.ts"). */
function toolFile(input: string, hint: string | undefined): string | undefined {
  try {
    const parsed = JSON.parse(input);
    for (const key of FILE_KEYS) {
      if (typeof parsed?.[key] === 'string' && parsed[key]) {
        return parsed[key];
      }
    }
  } catch {
    // Not JSON.
  }
  const m = hint && /^(?:Read|Reading|Edited|Editing|Created|Creating|Viewed|Viewing)\s+(\S+?)[,.]?(?:\s|$)/.exec(hint);
  return m && (path.isAbsolute(m[1]) || /^[A-Za-z]:[\\/]/.test(m[1])) ? path.normalize(m[1]) : undefined;
}

/**
 * The same facts from a parsed transcript, for tools whose logs collectHandoffFacts doesn't read (GitHub Copilot CLI,
 * VS Code Chat). Files come from the tool calls, relative ones resolved against `cwd`; skills and to-dos aren't
 * recorded the same way, so they stay empty.
 */
export function collectTranscriptFacts(entries: TranscriptEntry[], cwd?: string): HandoffFacts {
  const facts: HandoffFacts = { modified: [], read: [], todos: [], skills: [], mcpServers: [] };
  const mcpServers = new Set<string>();
  const modified = new Set<string>();
  const read = new Set<string>();
  const touch = (set: Set<string>, file: string) => {
    set.delete(file);
    set.add(file);
  };
  let turn: string[] = [];
  let final: string[] = [];
  const handoff = new HandoffTracker();
  for (const e of entries) {
    if (e.role === 'user') {
      const text = e.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('\n').trim();
      if (text) {
        handoff.prompt(text);
        facts.previousPrompt = facts.lastPrompt;
        facts.lastPrompt = text;
        turn = [];
        final = [];
      }
      continue;
    }
    if (e.role !== 'assistant') {
      continue;
    }
    for (const p of e.parts) {
      if (p.kind === 'text' && p.text.trim()) {
        turn.push(p.text.trim());
        final.push(p.text.trim());
      } else if (p.kind === 'tool_use') {
        final = [];
        const server = /^mcp__(.+?)__/.exec(p.name)?.[1];
        if (server) {
          mcpServers.add(`mcp__${server}`);
        }
        const named = toolFile(p.input, p.hint);
        const file = named && cwd && !path.isAbsolute(named) ? path.join(cwd, named) : named;
        if (file && MODIFY_TOOL.test(p.name)) {
          touch(modified, file);
          handoff.file(file);
        } else if (file && READ_TOOL.test(p.name)) {
          touch(read, file);
        } else if (SHELL_TOOL.test(p.name)) {
          shellWrites(shellCommand(p.input) ?? '', cwd).forEach((f) => handoff.file(f));
        }
        if (handoff.active && p.result && !p.result.isError && isPublishTool(p.name, undefined)) {
          handoff.url(firstUrl(p.result.text));
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
  facts.mcpServers = [...mcpServers];
  facts.modified = [...modified];
  facts.read = [...read].filter((f) => !modified.has(f));
  facts.handoffNotes = handoff.list;
  return facts;
}

/** The command line of a shell tool call's input. */
function shellCommand(input: string): string | undefined {
  try {
    const parsed = JSON.parse(input);
    return typeof parsed?.command === 'string' ? parsed.command : undefined;
  } catch {
    return undefined;
  }
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
 * The prompt that starts the new session in `target` (by default the session's own tool). It ends by asking for a
 * summary and a wait, because the CLIs send a prompt given on the command line straight away.
 */
export function buildHandoff(
  session: SessionInfo,
  facts: HandoffFacts,
  cwd: string | undefined,
  gitStatus?: string,
  target: SessionSource = sourceOf(session),
): string {
  for (const lim of LIMITS) {
    const text = render(session, facts, cwd, gitStatus, lim, target);
    if (text.length <= MAX_HANDOFF) {
      return text;
    }
  }
  return clip(render(session, facts, cwd, gitStatus, LIMITS[LIMITS.length - 1], target), MAX_HANDOFF - 10);
}

function render(
  session: SessionInfo,
  f: HandoffFacts,
  cwd: string | undefined,
  gitStatus: string | undefined,
  lim: Limits,
  target: SessionSource,
): string {
  const about = [`"${session.title}"`, session.gitBranch && `on branch ${session.gitBranch}`, session.prUrl && `PR ${session.prUrl}`]
    .filter(Boolean)
    .join(', ');
  const from = SOURCES[sourceOf(session)].label;
  // Across tools the new assistant didn't write the earlier replies, so they aren't "yours".
  const sameTool = target === sourceOf(session);
  const out = [`I'm continuing work from an earlier ${from} session (${about}). This is a handoff of where it left off.`];
  // Saved wherever I asked, scratch or outside the project included, so shown in full and ahead of everything else.
  const notes = (f.handoffNotes ?? []).slice(-lim.files);
  const latest = notes[notes.length - 1];
  if (latest) {
    const older = notes.slice(0, -1).reverse();
    out.push(
      '## Read first: handoff notes\n' +
        'At my request, that session wrote handoff notes to brief you. They say more than this summary, so read them before anything else:\n\n' +
        `    ${latest}` +
        (older.length
          ? `\n\nOther copies, newest first. Use the first that opens if the one above can't be read:\n${older.map((n) => `- ${n}`).join('\n')}`
          : ''),
    );
  }
  if (f.lastPrompt) {
    out.push(`## My last request\n${clip(f.lastPrompt, lim.text)}`);
    if (f.previousPrompt && f.lastPrompt.trim().length < SHORT_PROMPT) {
      out.push(`## The request before that\n${clip(f.previousPrompt, lim.text / 2)}`);
    }
  }
  if (f.lastReply) {
    const reply = f.replyIsWholeTurn ? clipStart(f.lastReply, lim.text) : clip(f.lastReply, lim.text, ' […] (rest in the transcript)');
    out.push(`## ${sameTool ? 'Your last reply' : `${SOURCES[sourceOf(session)].assistant}'s last reply`}\n${reply}`);
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
  const changed = f.modified.filter((m) => !notes.includes(m));
  if (changed.length) {
    out.push(`## Files changed with edit tools\n${fileList(changed, cwd, lim.files)}`);
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
      (latest ? 'First read the handoff notes named at the top. Then, before changing anything, ' : 'Before changing anything, ') +
      'briefly summarise where things stand and what you think the next step is, then wait for my instruction.',
  );
  return out.join('\n\n');
}

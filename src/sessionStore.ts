import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parseCopilotSession } from './copilotCliParser';
import { parseSession, SessionInfo, SessionSource } from './sessionParser';
import { parseChatSession } from './vscodeChatParser';

export function defaultProjectsDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(configDir, 'projects');
}

/** Where GitHub Copilot CLI keeps its state, sessions under session-state/. */
export function defaultCopilotDir(): string {
  return process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
}

/** VS Code's (and VS Code Insiders') user data folders, which hold the chat sessions. */
export function defaultVsCodeUserDirs(): string[] {
  const home = os.homedir();
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return ['Code', 'Code - Insiders'].map((name) => path.join(base, name, 'User'));
}

/** Folders of the sources besides Claude Code; a source without a folder isn't read. */
export interface SourceRoots {
  copilotDir?: string;
  vscodeUserDirs?: string[];
}

/** A session log found on disk, before parsing. */
interface LogFile {
  source: SessionSource;
  filePath: string;
  id: string;
  /** Claude Code: the encoded project folder name. */
  projectDir?: string;
  /** Copilot CLI: workspace.yaml beside the log. */
  sidecar?: string;
  /** VS Code Chat: the folder of the workspace the chat belongs to. */
  cwd?: string;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  /** Signature of the other files the session depends on (subagent logs, workspace.yaml). */
  extra: string;
  info: SessionInfo;
}

/** The session's subagent logs and a signature that changes when any of them does. */
async function subagentLogs(dir: string): Promise<{ files: string[]; signature: string }> {
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.jsonl')).sort();
  } catch {
    return { files: [], signature: '' };
  }
  const files: string[] = [];
  const parts: string[] = [];
  for (const n of names) {
    try {
      const st = await fs.stat(path.join(dir, n));
      files.push(path.join(dir, n));
      parts.push(`${n}:${st.mtimeMs}:${st.size}`);
    } catch {
      // Deleted between readdir and stat.
    }
  }
  return { files, signature: parts.join('|') };
}

async function readdirSafe(dir: string) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

const isChatLog = (name: string) => name.endsWith('.jsonl') || name.endsWith('.json');

/** The folder a VS Code workspace storage folder belongs to, from its workspace.json; undefined for remote or multi-root. */
async function workspaceFolder(storageDir: string): Promise<string | undefined> {
  try {
    const folder = JSON.parse(await fs.readFile(path.join(storageDir, 'workspace.json'), 'utf8'))?.folder;
    // VS Code writes Windows drive letters in lower case; Claude Code and Copilot CLI write them in upper case.
    return typeof folder === 'string' && folder.startsWith('file:')
      ? fileURLToPath(folder).replace(/^[a-z]:/, (d) => d.toUpperCase())
      : undefined;
  } catch {
    return undefined;
  }
}

/** Chat logs in one folder; when a chat exists as both .json (older) and .jsonl, the .jsonl is current. */
async function chatLogs(dir: string, cwd: string | undefined): Promise<LogFile[]> {
  const byId = new Map<string, LogFile>();
  for (const e of await readdirSafe(dir)) {
    if (!e.isFile() || !isChatLog(e.name)) {
      continue;
    }
    const id = e.name.replace(/\.jsonl?$/, '');
    if (!byId.has(id) || e.name.endsWith('.jsonl')) {
      byId.set(id, { source: 'vscode-chat', filePath: path.join(dir, e.name), id, cwd });
    }
  }
  return [...byId.values()];
}

const PARSE_CONCURRENCY = 8;

/**
 * Scans the session folders of every source and keeps parsed sessions cached by file mtime/size, so refreshes only
 * re-read changed logs.
 */
export class SessionStore {
  private cache = new Map<string, CacheEntry>();
  /** VS Code workspace storage folders that hold chats, with their folders; found again only after `rescan()`. */
  private chatDirs: { dir: string; cwd?: string }[] | undefined;

  constructor(
    public projectsDir: string,
    public roots: SourceRoots = {},
  ) {}

  setProjectsDir(dir: string): void {
    if (dir !== this.projectsDir) {
      this.projectsDir = dir;
      this.cache.clear();
    }
  }

  setRoots(roots: SourceRoots): void {
    if (JSON.stringify(roots) !== JSON.stringify(this.roots)) {
      this.roots = roots;
      this.cache.clear();
      this.chatDirs = undefined;
    }
  }

  /** Looks for new chat folders on the next load (a chat was created or deleted somewhere). */
  rescan(): void {
    this.chatDirs = undefined;
  }

  async load(): Promise<SessionInfo[]> {
    const files = (await Promise.all([this.claudeLogs(), this.copilotLogs(), this.vscodeChatLogs()])).flat();

    const results: SessionInfo[] = [];
    const seen = new Set<string>();
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const f = files[next++];
        seen.add(f.filePath);
        const info = await this.loadOne(f);
        if (info) {
          results.push(info);
        }
      }
    };
    await Promise.all(Array.from({ length: PARSE_CONCURRENCY }, worker));

    for (const key of this.cache.keys()) {
      if (!seen.has(key)) {
        this.cache.delete(key);
      }
    }
    return results.sort((a, b) => sortTime(b) - sortTime(a));
  }

  /** Only top-level <sessionId>.jsonl files; subfolders hold subagent logs and tool output. */
  private async claudeLogs(): Promise<LogFile[]> {
    const projectDirs = (await readdirSafe(this.projectsDir)).filter((e) => e.isDirectory()).map((e) => e.name);
    const files: LogFile[] = [];
    await Promise.all(
      projectDirs.map(async (projectDir) => {
        for (const e of await readdirSafe(path.join(this.projectsDir, projectDir))) {
          if (e.isFile() && e.name.endsWith('.jsonl')) {
            files.push({
              source: 'claude',
              filePath: path.join(this.projectsDir, projectDir, e.name),
              projectDir,
              id: e.name.slice(0, -'.jsonl'.length),
            });
          }
        }
      }),
    );
    return files;
  }

  /** session-state/<id>/events.jsonl with workspace.yaml beside it, or an older flat session-state/<id>.jsonl. */
  private async copilotLogs(): Promise<LogFile[]> {
    if (!this.roots.copilotDir) {
      return [];
    }
    const stateDir = path.join(this.roots.copilotDir, 'session-state');
    const files: LogFile[] = [];
    await Promise.all(
      (await readdirSafe(stateDir)).map(async (e) => {
        if (e.isFile() && e.name.endsWith('.jsonl')) {
          files.push({ source: 'copilot-cli', filePath: path.join(stateDir, e.name), id: e.name.slice(0, -'.jsonl'.length) });
        } else if (e.isDirectory()) {
          const dir = path.join(stateDir, e.name);
          // A session opened with nothing typed yet has no events.jsonl.
          try {
            await fs.access(path.join(dir, 'events.jsonl'));
          } catch {
            return;
          }
          files.push({ source: 'copilot-cli', filePath: path.join(dir, 'events.jsonl'), id: e.name, sidecar: path.join(dir, 'workspace.yaml') });
        }
      }),
    );
    return files;
  }

  /** <user>/workspaceStorage/<hash>/chatSessions/ and <user>/globalStorage/emptyWindowChatSessions/. */
  private async vscodeChatLogs(): Promise<LogFile[]> {
    const userDirs = this.roots.vscodeUserDirs ?? [];
    if (!userDirs.length) {
      return [];
    }
    if (!this.chatDirs) {
      const found: { dir: string; cwd?: string }[] = [];
      await Promise.all(
        userDirs.map(async (userDir) => {
          found.push({ dir: path.join(userDir, 'globalStorage', 'emptyWindowChatSessions') });
          const storage = path.join(userDir, 'workspaceStorage');
          await Promise.all(
            (await readdirSafe(storage)).map(async (e) => {
              const dir = path.join(storage, e.name, 'chatSessions');
              if (e.isDirectory() && (await readdirSafe(dir)).length) {
                found.push({ dir, cwd: await workspaceFolder(path.join(storage, e.name)) });
              }
            }),
          );
        }),
      );
      this.chatDirs = found;
    }
    return (await Promise.all(this.chatDirs.map((d) => chatLogs(d.dir, d.cwd)))).flat();
  }

  private async loadOne(f: LogFile): Promise<SessionInfo | undefined> {
    try {
      const stat = await fs.stat(f.filePath);
      const subagents =
        f.source === 'claude' ? await subagentLogs(path.join(path.dirname(f.filePath), f.id, 'subagents')) : undefined;
      const sidecar = f.sidecar ? await fs.stat(f.sidecar).catch(() => undefined) : undefined;
      const extra = subagents?.signature ?? (sidecar ? `${sidecar.mtimeMs}:${sidecar.size}` : '');
      const cached = this.cache.get(f.filePath);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.extra === extra) {
        return cached.info;
      }
      const text = await fs.readFile(f.filePath, 'utf8');
      let info: SessionInfo;
      if (f.source === 'copilot-cli') {
        const yaml = f.sidecar ? await fs.readFile(f.sidecar, 'utf8').catch(() => undefined) : undefined;
        info = parseCopilotSession(text, f.filePath, f.id, yaml);
      } else if (f.source === 'vscode-chat') {
        info = parseChatSession(text, f.filePath, f.id, f.cwd);
      } else {
        const logs = await Promise.all(subagents!.files.map((p) => fs.readFile(p, 'utf8').catch(() => '')));
        info = parseSession(text, f.filePath, f.projectDir ?? '', f.id, logs);
      }
      // Fall back to file mtime when the log has no timestamped messages.
      info.lastTime ??= stat.mtimeMs;
      info.startTime ??= stat.birthtimeMs || stat.mtimeMs;
      this.cache.set(f.filePath, { mtimeMs: stat.mtimeMs, size: stat.size, extra, info });
      return info;
    } catch {
      return undefined;
    }
  }
}

export function sortTime(s: SessionInfo): number {
  return s.lastTime ?? s.startTime ?? 0;
}

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { parseSession, SessionInfo } from './sessionParser';

export function defaultProjectsDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(configDir, 'projects');
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  /** Names, mtimes and sizes of the subagent logs, which count toward the session's usage. */
  subagents: string;
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

const PARSE_CONCURRENCY = 8;

/** Scans the projects dir and keeps parsed sessions cached by file mtime/size, so refreshes only re-read changed logs. */
export class SessionStore {
  private cache = new Map<string, CacheEntry>();

  constructor(public projectsDir: string) {}

  setProjectsDir(dir: string): void {
    if (dir !== this.projectsDir) {
      this.projectsDir = dir;
      this.cache.clear();
    }
  }

  async load(): Promise<SessionInfo[]> {
    let projectDirs: string[];
    try {
      const entries = await fs.readdir(this.projectsDir, { withFileTypes: true });
      projectDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }

    // Only top-level <sessionId>.jsonl files; subfolders hold subagent logs and tool output.
    const files: { filePath: string; projectDir: string; id: string }[] = [];
    await Promise.all(
      projectDirs.map(async (projectDir) => {
        try {
          const entries = await fs.readdir(path.join(this.projectsDir, projectDir), { withFileTypes: true });
          for (const e of entries) {
            if (e.isFile() && e.name.endsWith('.jsonl')) {
              files.push({
                filePath: path.join(this.projectsDir, projectDir, e.name),
                projectDir,
                id: e.name.slice(0, -'.jsonl'.length),
              });
            }
          }
        } catch {
          // Unreadable folder; skip.
        }
      }),
    );

    const results: SessionInfo[] = [];
    const seen = new Set<string>();
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const f = files[next++];
        seen.add(f.filePath);
        const info = await this.loadOne(f.filePath, f.projectDir, f.id);
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

  private async loadOne(filePath: string, projectDir: string, id: string): Promise<SessionInfo | undefined> {
    try {
      const stat = await fs.stat(filePath);
      const subagents = await subagentLogs(path.join(path.dirname(filePath), id, 'subagents'));
      const cached = this.cache.get(filePath);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.subagents === subagents.signature) {
        return cached.info;
      }
      const text = await fs.readFile(filePath, 'utf8');
      const logs = await Promise.all(subagents.files.map((f) => fs.readFile(f, 'utf8').catch(() => '')));
      const info = parseSession(text, filePath, projectDir, id, logs);
      // Fall back to file mtime when the log has no timestamped messages.
      info.lastTime ??= stat.mtimeMs;
      info.startTime ??= stat.birthtimeMs || stat.mtimeMs;
      this.cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, subagents: subagents.signature, info });
      return info;
    } catch {
      return undefined;
    }
  }
}

export function sortTime(s: SessionInfo): number {
  return s.lastTime ?? s.startTime ?? 0;
}

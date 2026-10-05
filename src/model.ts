import * as path from 'path';
import * as vscode from 'vscode';
import { DATE_BUCKETS, dateBucket, isInside, normalizePath } from './format';
import { decodeProjectDir, matchText, SessionInfo, TextMatch } from './sessionParser';
import { SessionStore, sortTime } from './sessionStore';

export type GroupBy = 'project' | 'date';

export interface SessionGroup {
  key: string;
  kind: GroupBy;
  label: string;
  /** Full folder path for project groups. */
  path?: string;
  expanded: boolean;
  sessions: SessionInfo[];
}

export function projectPath(s: SessionInfo): string {
  return s.cwd ?? decodeProjectDir(s.projectDir);
}

export function workspaceFolderPaths(): string[] {
  return vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
}

/** Holds the loaded sessions plus the view options (grouping, filters) shared by the sidebar and commands. */
export class SessionModel {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  private sessions: SessionInfo[] = [];
  private loading: Promise<void> | undefined;
  private reloadQueued = false;
  private loaded = false;

  groupBy: GroupBy = 'project';
  workspaceOnly = false;
  hideEmpty = true;

  constructor(private readonly store: SessionStore) {}

  get allSessions(): SessionInfo[] {
    return this.sessions;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  find(id: string): SessionInfo | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  /** Re-reads session logs (only changed files are re-parsed). Coalesces overlapping calls. */
  async reload(): Promise<void> {
    if (this.loading) {
      this.reloadQueued = true;
      return this.loading;
    }
    this.loading = (async () => {
      do {
        this.reloadQueued = false;
        this.sessions = await this.store.load();
        this.loaded = true;
        this.emitter.fire();
      } while (this.reloadQueued);
    })().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  /** Notifies listeners without re-reading files (options changed). */
  refreshView(): void {
    this.emitter.fire();
  }

  visibleSessions(): SessionInfo[] {
    let list = this.sessions;
    if (this.hideEmpty) {
      list = list.filter((s) => s.promptCount > 0 || s.assistantCount > 0 || s.titleSource !== 'none');
    }
    if (this.workspaceOnly) {
      const folders = workspaceFolderPaths();
      list = list.filter((s) => folders.some((f) => isInside(projectPath(s), f)));
    }
    return list;
  }

  /** Which search tokens each visible session's transcript contains, keyed by session id (sessions with no hits omitted). */
  searchTranscripts(tokens: string[]): Record<string, TextMatch> {
    const hits: Record<string, TextMatch> = {};
    if (!tokens.length) {
      return hits;
    }
    for (const s of this.visibleSessions()) {
      const m = matchText(s.searchText, tokens);
      if (m.found.length) {
        hits[s.id] = m;
      }
    }
    return hits;
  }

  groups(): SessionGroup[] {
    const visible = this.visibleSessions();
    return this.groupBy === 'date' ? groupByDate(visible) : groupByProject(visible);
  }
}

function groupByProject(sessions: SessionInfo[]): SessionGroup[] {
  const groups = new Map<string, { path: string; sessions: SessionInfo[] }>();
  for (const s of sessions) {
    const p = projectPath(s);
    const key = normalizePath(p);
    let g = groups.get(key);
    if (!g) {
      g = { path: p, sessions: [] };
      groups.set(key, g);
    }
    g.sessions.push(s);
  }
  const folders = workspaceFolderPaths();
  // Sessions arrive sorted newest-first, so group order follows each project's latest activity.
  return [...groups.entries()].map(([key, g], i) => ({
    key: `project:${key}`,
    kind: 'project',
    label: path.basename(g.path) || g.path,
    path: g.path,
    expanded: i === 0 || folders.some((f) => isInside(g.path, f)),
    sessions: g.sessions,
  }));
}

function groupByDate(sessions: SessionInfo[]): SessionGroup[] {
  const now = Date.now();
  const buckets = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const b = dateBucket(sortTime(s), now);
    const list = buckets.get(b) ?? [];
    list.push(s);
    buckets.set(b, list);
  }
  return DATE_BUCKETS.filter((b) => buckets.has(b)).map((b, i) => ({
    key: `date:${b}`,
    kind: 'date',
    label: b,
    expanded: i < 2,
    sessions: buckets.get(b)!,
  }));
}

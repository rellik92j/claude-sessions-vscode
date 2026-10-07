import * as path from 'path';
import * as vscode from 'vscode';
import { DATE_BUCKETS, dateBucket, isInside, normalizePath } from './format';
import { evaluate, Query, snippet, sourceAllowed } from './query';
import { SessionInfo } from './sessionParser';
import { SessionStore, sortTime } from './sessionStore';
import { isClaude, NO_FOLDER, sessionFolder, sessionKey, SessionSource, SOURCE_IDS, sourceOf } from './sources';

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

export interface SearchHit {
  session: SessionInfo;
  /** Matching passage from the transcript, when the match isn't visible otherwise. */
  snippet?: string;
}

/** The folder a session was started in; '' when unknown (only possible outside Claude Code). */
export const projectPath = sessionFolder;

/** Display name of a session's folder. */
export function projectName(p: string): string {
  return p ? path.basename(p) || p : NO_FOLDER;
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
  /** Sources the sidebar shows; seeded from the sources setting, changed by its chips. */
  sources: ReadonlySet<SessionSource> = new Set(SOURCE_IDS);

  constructor(private readonly store: SessionStore) {}

  get allSessions(): SessionInfo[] {
    return this.sessions;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  /** By session key; a bare id also works, preferring a Claude Code session. */
  find(key: string): SessionInfo | undefined {
    return (
      this.sessions.find((s) => sessionKey(s) === key) ??
      this.sessions.find((s) => s.id === key && isClaude(s)) ??
      this.sessions.find((s) => s.id === key)
    );
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

  /**
   * Sessions the sidebar shows. `workspaceOnly` overrides the sidebar's Workspace filter and `sources` its source
   * chips (undefined: every source).
   */
  visibleSessions(workspaceOnly = this.workspaceOnly, sources: ReadonlySet<SessionSource> | undefined = this.sources): SessionInfo[] {
    let list = this.sessions;
    if (sources) {
      list = list.filter((s) => sources.has(sourceOf(s)));
    }
    if (this.hideEmpty) {
      // A Claude Code session renamed before its first prompt is kept; an untouched chat with a title is not.
      list = list.filter((s) => s.promptCount > 0 || s.assistantCount > 0 || (isClaude(s) && s.titleSource !== 'none'));
    }
    if (workspaceOnly) {
      const folders = workspaceFolderPaths();
      list = list.filter((s) => {
        const p = projectPath(s);
        return !!p && folders.some((f) => isInside(p, f));
      });
    }
    return list;
  }

  /** Sessions per source among those the sidebar's other filters let through, for the source chips. */
  sourceCounts(): Record<SessionSource, number> {
    const counts = Object.fromEntries(SOURCE_IDS.map((id) => [id, 0])) as Record<SessionSource, number>;
    for (const s of this.visibleSessions(this.workspaceOnly, undefined)) {
      counts[sourceOf(s)]++;
    }
    return counts;
  }

  /** Sources with any sessions at all, so the sidebar only offers chips that do something. */
  presentSources(): SessionSource[] {
    const seen = new Set(this.sessions.map(sourceOf));
    return SOURCE_IDS.filter((id) => seen.has(id));
  }

  /**
   * Visible sessions matching the query in what the caller shows for them (`shownText`) or in their transcript.
   * A snippet is included when the shown text alone doesn't explain the match.
   */
  search(q: Query, shownText: (s: SessionInfo) => string): SearchHit[] {
    const hits: SearchHit[] = [];
    for (const s of this.visibleSessions()) {
      if (!sourceAllowed(q, sourceOf(s))) {
        continue;
      }
      const shown = shownText(s);
      if (evaluate(q, [shown, s.searchText])) {
        hits.push({ session: s, snippet: evaluate(q, [shown]) ? undefined : snippet(s.searchText, q) });
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
    label: projectName(g.path),
    path: g.path || undefined,
    expanded: i === 0 || (!!g.path && folders.some((f) => isInside(g.path, f))),
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

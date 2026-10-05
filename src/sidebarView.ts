import { randomBytes } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { normalizePath } from './format';
import { GroupBy, projectPath, SessionModel } from './model';
import { parseQuery } from './query';
import { SessionInfo } from './sessionParser';
import { sortTime } from './sessionStore';

/** What a session card needs; kept small because the whole list is posted to the webview on every change. */
export interface CardData {
  id: string;
  title: string;
  agent?: string;
  excerpt?: string;
  project: string;
  projectPath: string;
  hue: number;
  branch?: string;
  lastTime: number;
  startTime?: number;
  prompts: number;
  peers: number;
  model?: string;
  prNumber?: number;
  prRepository?: string;
}

export function hueFor(text: string): number {
  let h = 0;
  for (const ch of normalizePath(text)) {
    h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return h % 360;
}

export function toCard(s: SessionInfo): CardData {
  const p = projectPath(s);
  let title = s.title;
  // Agent-team titles are "<agent> — <topic>"; the card shows the agent as a chip instead.
  if (s.agentName && title.startsWith(`${s.agentName} — `)) {
    title = title.slice(s.agentName.length + 3);
  }
  // Show the latest prompt under the title, unless the title already is that prompt.
  const flat = (t: string) => t.replace(/<\/?pasted_content\b[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const titleStem = flat(title).replace(/…$/, '');
  const excerpt = [s.lastPrompt, s.firstPrompt].find((p) => p && !flat(p).startsWith(titleStem));
  return {
    id: s.id,
    title,
    agent: s.agentName,
    excerpt: excerpt ? flat(excerpt).slice(0, 240) : undefined,
    project: path.basename(p) || p,
    projectPath: p,
    hue: hueFor(p),
    branch: s.gitBranch,
    lastTime: sortTime(s),
    startTime: s.startTime,
    prompts: s.promptCount,
    peers: s.peerMessageCount,
    model: s.model,
    prNumber: s.prUrl ? s.prNumber : undefined,
    prRepository: s.prRepository,
  };
}

/** The card text a search matches against (besides the transcript). */
function cardText(c: CardData): string {
  return (
    [c.title, c.excerpt, c.project, c.branch, c.agent, c.model, c.prNumber && `#${c.prNumber}`]
      .filter(Boolean)
      // NUL between fields so a phrase can't match across two of them.
      .join('\0')
  );
}

const PAGE_COMMANDS: Record<string, string> = {
  resume: 'claudeSessions.resume',
  openTranscript: 'claudeSessions.openTranscript',
  openInClaudeCode: 'claudeSessions.openInClaudeCode',
  openPr: 'claudeSessions.openPr',
  copyId: 'claudeSessions.copyId',
};

export class SidebarView implements vscode.WebviewViewProvider {
  static readonly viewId = 'claudeSessions.list';
  private view: vscode.WebviewView | undefined;
  private ready = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly model: SessionModel,
    private readonly setOption: (key: 'groupBy' | 'currentWorkspaceOnly', value: unknown) => Thenable<void>,
    private readonly hasClaudeCode: () => boolean,
  ) {
    model.onDidChange(() => this.postState());
  }

  get visible(): boolean {
    return !!this.view?.visible;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    const codicons = vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist');
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [codicons, media] };
    view.webview.html = this.html(view.webview, codicons, media);
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.model.reload();
      }
    });
    view.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
    });
  }

  focusSearch(): void {
    this.view?.show(false);
    this.view?.webview.postMessage({ type: 'focusSearch' });
  }

  postState(): void {
    if (!this.view || !this.ready) {
      return;
    }
    const groups = this.model.groups().map((g) => ({
      key: g.key,
      kind: g.kind,
      label: g.label,
      path: g.path,
      hue: g.path ? hueFor(g.path) : 0,
      expanded: g.expanded,
      sessions: g.sessions.map(toCard),
    }));
    const total = groups.reduce((n, g) => n + g.sessions.length, 0);
    this.view.description = total ? String(total) : undefined;
    this.view.webview.postMessage({
      type: 'state',
      loaded: this.model.isLoaded,
      groupBy: this.model.groupBy,
      workspaceOnly: this.model.workspaceOnly,
      hasClaudeCode: this.hasClaudeCode(),
      hiddenByFilter: this.model.workspaceOnly && total === 0 && this.model.allSessions.length > 0,
      total,
      groups,
    });
  }

  private onMessage(msg: any): void {
    switch (msg?.type) {
      case 'ready':
        this.ready = true;
        this.postState();
        break;
      case 'run': {
        const command = PAGE_COMMANDS[msg.command];
        const session = typeof msg.id === 'string' ? this.model.find(msg.id) : undefined;
        if (command && session) {
          // openTranscript also gets the current search words to highlight, and whether to keep it in its own tab.
          vscode.commands.executeCommand(
            command,
            session,
            ...(msg.command === 'openTranscript' ? [msg.highlight, msg.keepOpen === true] : []),
          );
        }
        break;
      }
      case 'setGroupBy':
        if (msg.value === 'project' || msg.value === 'date') {
          this.setOption('groupBy', msg.value as GroupBy);
        }
        break;
      case 'setWorkspaceOnly':
        this.setOption('currentWorkspaceOnly', !!msg.value);
        break;
      case 'refresh':
        this.model.reload();
        break;
      case 'search': {
        // Searching happens in the extension host (transcript text never goes to the webview); it gets back the
        // matching ids, snippets for transcript-only matches, and the words to highlight.
        const query = typeof msg.query === 'string' ? msg.query : '';
        const q = parseQuery(query);
        const snippets: Record<string, string> = {};
        const ids: string[] = [];
        for (const hit of this.model.search(q, (s) => cardText(toCard(s)))) {
          ids.push(hit.session.id);
          if (hit.snippet) {
            snippets[hit.session.id] = hit.snippet;
          }
        }
        this.view?.webview.postMessage({ type: 'searchResults', query, ids, snippets, highlight: q.highlight });
        break;
      }
    }
  }

  private html(webview: vscode.Webview, codicons: vscode.Uri, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    const uri = (base: vscode.Uri, file: string) => webview.asWebviewUri(vscode.Uri.joinPath(base, file));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri(codicons, 'codicon.css')}">
<link rel="stylesheet" href="${uri(media, 'sidebar.css')}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${uri(media, 'sidebar.js')}"></script>
</body>
</html>`;
  }
}

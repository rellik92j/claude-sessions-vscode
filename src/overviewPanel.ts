import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { isInside } from './format';
import { projectPath, SessionModel, workspaceFolderPaths } from './model';
import { buildOverview, OVERVIEW_RANGES, OverviewRange, projectKey } from './overview';

/** Which projects the overview covers: those in the open workspace folders, all, or a pick. */
type Scope = 'workspace' | 'all' | 'pick';
const SCOPES: Scope[] = ['workspace', 'all', 'pick'];

/** The overview: one editor tab summarising all sessions, kept current as logs change. */
export class OverviewPanel {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private range: OverviewRange = 30;
  private scope: Scope = 'workspace';
  /** Keys of the picked projects, for the 'pick' scope. */
  private projects: string[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly model: SessionModel,
  ) {
    model.onDidChange(() => this.postState());
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const codicons = vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist');
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('claudeSessions.overview', 'Claude Sessions Overview', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [codicons, media],
    });
    panel.iconPath = new vscode.ThemeIcon('dashboard');
    this.panel = panel;
    this.ready = false;
    panel.webview.html = this.html(panel.webview, codicons, media);
    panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.ready = false;
    });
    if (!this.model.isLoaded) {
      this.model.reload();
    }
  }

  private postState(): void {
    if (!this.panel || !this.ready) {
      return;
    }
    // The overview has its own project filter, so it ignores the sidebar's Workspace filter.
    const sessions = this.model.visibleSessions(false);
    const folders = workspaceFolderPaths();
    const workspaceKeys = [
      ...new Set(sessions.filter((s) => folders.some((f) => isInside(projectPath(s), f))).map(projectKey)),
    ];
    const known = new Set(sessions.map(projectKey));
    let scope = this.scope;
    // With no folder open there is no workspace to show, and a pick whose projects have all gone shows everything.
    if ((scope === 'workspace' && !folders.length) || (scope === 'pick' && !this.projects.some((k) => known.has(k)))) {
      scope = 'all';
    }
    const filter = scope === 'workspace' ? workspaceKeys : scope === 'pick' ? this.projects : undefined;
    this.panel.webview.postMessage({
      type: 'state',
      loaded: this.model.isLoaded,
      scope,
      hasWorkspace: folders.length > 0,
      workspaceName: vscode.workspace.name,
      workspaceKeys,
      overview: buildOverview(sessions, this.range, Date.now(), filter),
    });
  }

  private onMessage(msg: any): void {
    switch (msg?.type) {
      case 'ready':
      case 'setFilters':
        if (OVERVIEW_RANGES.includes(msg.range)) {
          this.range = msg.range;
        }
        if (SCOPES.includes(msg.scope)) {
          this.scope = msg.scope;
        }
        if (Array.isArray(msg.projects)) {
          this.projects = msg.projects.filter((k: unknown): k is string => typeof k === 'string');
        }
        this.ready = true;
        this.postState();
        break;
      case 'refresh':
        this.model.reload();
        break;
      case 'openTranscript': {
        const session = typeof msg.id === 'string' ? this.model.find(msg.id) : undefined;
        if (session) {
          vscode.commands.executeCommand('claudeSessions.openTranscript', session);
        }
        break;
      }
      case 'revealFolder':
        if (typeof msg.projectPath === 'string') {
          vscode.commands.executeCommand('claudeSessions.revealFolder', { projectPath: msg.projectPath });
        }
        break;
    }
  }

  private html(webview: vscode.Webview, codicons: vscode.Uri, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
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
<link rel="stylesheet" href="${uri(media, 'overview.css')}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${uri(media, 'overview.js')}"></script>
</body>
</html>`;
  }
}

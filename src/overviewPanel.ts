import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { SessionModel } from './model';
import { buildOverview, OVERVIEW_RANGES, OverviewRange } from './overview';

/** The overview: one editor tab summarising all sessions, kept current as logs change. */
export class OverviewPanel {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private range: OverviewRange = 30;
  /** Keys of the projects to include; empty for all. */
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
    this.panel.webview.postMessage({
      type: 'state',
      loaded: this.model.isLoaded,
      workspaceOnly: this.model.workspaceOnly,
      overview: buildOverview(this.model.visibleSessions(), this.range, Date.now(), this.projects),
    });
  }

  private onMessage(msg: any): void {
    switch (msg?.type) {
      case 'ready':
      case 'setFilters':
        if (OVERVIEW_RANGES.includes(msg.range)) {
          this.range = msg.range;
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
      case 'showAll':
        vscode.commands.executeCommand('claudeSessions.showAll');
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

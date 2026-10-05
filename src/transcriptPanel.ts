import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { escapeHtml, formatDateTime } from './format';
import { renderMarkdown } from './markdown';
import { projectPath } from './model';
import { parseTranscript, SessionInfo, TranscriptEntry, TranscriptPart } from './sessionParser';

type ToolPart = Extract<TranscriptPart, { kind: 'tool_use' }>;

/** One webview per session; re-opening a session focuses its existing panel. */
export class TranscriptPanels {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  /** Search words to highlight per session, from the search that opened it. */
  private readonly highlights = new Map<string, string[]>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly hasClaudeCode: () => boolean,
  ) {}

  /** Opens the transcript; `highlight` words are marked and the page opens at the first match. */
  async open(session: SessionInfo, highlight: string[] = []): Promise<void> {
    this.highlights.set(session.id, highlight);
    const existing = this.panels.get(session.id);
    if (existing) {
      existing.reveal();
      await this.render(existing, session);
      return;
    }
    const panel = vscode.window.createWebviewPanel('claudeSessions.transcript', session.title, vscode.ViewColumn.Active, {
      enableScripts: true,
      enableFindWidget: true,
      retainContextWhenHidden: true,
      localResourceRoots: [this.codiconsUri, this.mediaUri],
    });
    const claudeCode = vscode.extensions.getExtension('anthropic.claude-code');
    panel.iconPath = claudeCode
      ? vscode.Uri.joinPath(claudeCode.extensionUri, 'resources', 'claude-logo.svg')
      : new vscode.ThemeIcon('comment-discussion');
    this.panels.set(session.id, panel);
    panel.onDidDispose(() => {
      this.panels.delete(session.id);
      this.highlights.delete(session.id);
    });
    panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg?.command) {
        case 'resume':
        case 'openInClaudeCode':
        case 'copyId':
        case 'openRawFile':
        case 'openPr':
          vscode.commands.executeCommand(`claudeSessions.${msg.command}`, session);
          break;
        case 'copyText':
          if (typeof msg.text === 'string') {
            await vscode.env.clipboard.writeText(msg.text);
            vscode.window.setStatusBarMessage('Copied to clipboard', 2000);
          }
          break;
        case 'refresh':
          this.render(panel, session);
          break;
      }
    });
    await this.render(panel, session);
  }

  private get codiconsUri() {
    return vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist');
  }

  private get mediaUri() {
    return vscode.Uri.joinPath(this.extensionUri, 'media');
  }

  private async render(panel: vscode.WebviewPanel, session: SessionInfo): Promise<void> {
    let entries: TranscriptEntry[];
    try {
      entries = parseTranscript(await fs.readFile(session.filePath, 'utf8'));
    } catch (err) {
      vscode.window.showErrorMessage(`Could not read session log: ${(err as Error).message}`);
      return;
    }
    const showThinking = vscode.workspace.getConfiguration('claudeSessions').get<boolean>('showThinking', false);
    const webview = panel.webview;
    panel.title = session.title;
    webview.html = buildHtml(session, entries, {
      showThinking,
      highlight: this.highlights.get(session.id) ?? [],
      hasClaudeCode: this.hasClaudeCode(),
      cspSource: webview.cspSource,
      codiconCss: webview.asWebviewUri(vscode.Uri.joinPath(this.codiconsUri, 'codicon.css')).toString(),
      css: webview.asWebviewUri(vscode.Uri.joinPath(this.mediaUri, 'transcript.css')).toString(),
      js: webview.asWebviewUri(vscode.Uri.joinPath(this.mediaUri, 'transcript.js')).toString(),
    });
  }
}

interface HtmlOptions {
  showThinking: boolean;
  /** Search words for transcript.js to mark. */
  highlight?: string[];
  hasClaudeCode: boolean;
  cspSource: string;
  codiconCss: string;
  css: string;
  js: string;
}

const CLAUDE_MARK = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><g stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 3.5v17M3.5 12h17M6 6l12 12M18 6L6 18"/></g></svg>`;

const TOOL_ICONS: Record<string, string> = {
  bash: 'terminal',
  powershell: 'terminal-powershell',
  read: 'file',
  write: 'new-file',
  edit: 'edit',
  multiedit: 'edit',
  notebookedit: 'notebook',
  grep: 'search',
  glob: 'file-submodule',
  webfetch: 'globe',
  websearch: 'globe',
  task: 'hubot',
  agent: 'hubot',
  todowrite: 'checklist',
  skill: 'sparkle',
  sendmessage: 'send',
  artifact: 'preview',
};

function toolIcon(name: string): string {
  const key = name.toLowerCase();
  if (TOOL_ICONS[key]) {
    return TOOL_ICONS[key];
  }
  if (key.startsWith('mcp__')) {
    return 'plug';
  }
  return 'tools';
}

function toolLabel(name: string): string {
  // mcp__server__tool -> server › tool
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1].replace(/^claude_ai_|^plugin_/, '').replace(/_/g, ' ')} › ${m[2].replace(/_/g, ' ')}` : name;
}

function time(ts: string | undefined): string {
  if (!ts) {
    return '';
  }
  const t = Date.parse(ts);
  if (Number.isNaN(t)) {
    return '';
  }
  const short = new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `<time title="${escapeHtml(formatDateTime(t))}">${escapeHtml(short)}</time>`;
}

function dayKey(ts: string | undefined): string | undefined {
  if (!ts) {
    return undefined;
  }
  const t = Date.parse(ts);
  return Number.isNaN(t) ? undefined : new Date(t).toDateString();
}

function dayLabel(ts: string): string {
  const d = new Date(Date.parse(ts));
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) {
    return 'Today';
  }
  if (d.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function lineCount(text: string): number {
  return text ? text.split('\n').length : 0;
}

function renderTool(p: ToolPart): string {
  const status = !p.result
    ? '<i class="codicon codicon-circle-large-outline status pending" title="No result recorded"></i>'
    : p.result.isError
      ? '<i class="codicon codicon-error status error" title="Failed"></i>'
      : '<i class="codicon codicon-check status ok" title="Succeeded"></i>';
  const input = p.diff
    ? `<div class="pane-label">Change</div><div class="diff"><pre class="del">${escapeHtml(p.diff.before)}</pre><pre class="add">${escapeHtml(p.diff.after)}</pre></div>`
    : `<div class="pane-label">Input</div><pre>${escapeHtml(p.input)}</pre>`;
  const output = p.result
    ? `<div class="pane-label">${p.result.isError ? 'Error' : 'Output'} <span>${lineCount(p.result.text)} lines</span></div><pre class="${p.result.isError ? 'error' : ''}">${escapeHtml(p.result.text || '(empty)')}</pre>`
    : '';
  return `
    <details class="tool${p.result?.isError ? ' failed' : ''}">
      <summary>
        <i class="codicon codicon-${toolIcon(p.name)} tool-icon"></i>
        <span class="tool-name">${escapeHtml(toolLabel(p.name))}</span>
        ${p.hint ? `<span class="tool-hint">${escapeHtml(p.hint)}</span>` : '<span class="tool-hint"></span>'}
        ${status}
      </summary>
      <div class="tool-body">${input}${output}</div>
    </details>`;
}

function renderParts(parts: TranscriptPart[], role: 'assistant' | 'user' | 'peer', showThinking: boolean): string {
  const out: string[] = [];
  let tools: ToolPart[] = [];
  const flushTools = () => {
    if (!tools.length) {
      return;
    }
    const failed = tools.filter((t) => t.result?.isError).length;
    out.push(`
      <div class="tool-group">
        <div class="tool-group-head"><i class="codicon codicon-tools"></i>${tools.length} tool call${tools.length === 1 ? '' : 's'}${failed ? ` <span class="failed-count">· ${failed} failed</span>` : ''}</div>
        ${tools.map(renderTool).join('')}
      </div>`);
    tools = [];
  };
  for (const p of parts) {
    if (p.kind === 'tool_use') {
      tools.push(p);
      continue;
    }
    flushTools();
    if (p.kind === 'text') {
      out.push(`<div class="md">${renderMarkdown(p.text, role === 'assistant' ? 'assistant' : 'user')}</div>`);
    } else if (p.kind === 'thinking' && showThinking) {
      out.push(`<details class="thinking"><summary><i class="codicon codicon-lightbulb"></i>Thinking</summary><div class="md">${renderMarkdown(p.text)}</div></details>`);
    } else if (p.kind === 'tool_result') {
      out.push(`<details class="tool"><summary><i class="codicon codicon-output tool-icon"></i><span class="tool-name">Tool result</span><span class="tool-hint"></span></summary><div class="tool-body"><pre>${escapeHtml(p.text)}</pre></div></details>`);
    }
  }
  flushTools();
  return out.join('');
}

function initials(name: string): string {
  const words = name.split(/[\s\-_]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase();
}

function renderEntry(e: TranscriptEntry, showThinking: boolean): string {
  if (e.role === 'system') {
    const text = e.parts.map((p) => ('text' in p ? p.text : '')).join(' ');
    return `<div class="divider system"><span><i class="codicon codicon-fold"></i>${escapeHtml(text)}</span></div>`;
  }
  if (e.role === 'user') {
    const body = renderParts(e.parts, 'user', showThinking);
    return body
      ? `<div class="msg user"><div class="msg-meta">You ${time(e.timestamp)}</div><div class="bubble">${body}</div></div>`
      : '';
  }
  if (e.role === 'peer') {
    const first = e.parts[0];
    const from = first?.kind === 'text' ? first.from ?? 'Another session' : 'Another session';
    return `
      <div class="msg peer">
        <div class="avatar peer-avatar" title="${escapeHtml(from)}">${escapeHtml(initials(from))}</div>
        <div class="msg-main">
          <div class="msg-meta"><strong>${escapeHtml(from)}</strong><span class="pill">session message</span>${time(e.timestamp)}</div>
          <div class="peer-card">${renderParts(e.parts, 'peer', showThinking)}</div>
        </div>
      </div>`;
  }
  const body = renderParts(e.parts, 'assistant', showThinking);
  if (!body) {
    return '';
  }
  const role = e.role === 'tool' ? 'Tools' : 'Claude';
  return `
    <div class="msg assistant">
      <div class="avatar claude-avatar">${CLAUDE_MARK}</div>
      <div class="msg-main">
        <div class="msg-meta"><strong>${role}</strong>${time(e.timestamp)}</div>
        ${body}
      </div>
    </div>`;
}

export function buildHtml(session: SessionInfo, entries: TranscriptEntry[], o: HtmlOptions): string {
  const nonce = randomBytes(16).toString('base64');
  const proj = projectPath(session);
  const chips = [
    `<span class="chip" title="${escapeHtml(proj)}"><i class="codicon codicon-folder"></i>${escapeHtml(path.basename(proj) || proj)}</span>`,
    session.gitBranch ? `<span class="chip"><i class="codicon codicon-git-branch"></i>${escapeHtml(session.gitBranch)}</span>` : '',
    session.agentName ? `<span class="chip agent"><i class="codicon codicon-hubot"></i>${escapeHtml(session.agentName)}</span>` : '',
    `<span class="chip" title="Started ${escapeHtml(formatDateTime(session.startTime))}"><i class="codicon codicon-calendar"></i>${escapeHtml(formatDateTime(session.lastTime))}</span>`,
    `<span class="chip"><i class="codicon codicon-comment"></i>${session.promptCount} prompt${session.promptCount === 1 ? '' : 's'}</span>`,
    session.model ? `<span class="chip"><i class="codicon codicon-sparkle"></i>${escapeHtml(session.model)}</span>` : '',
    session.prUrl
      ? `<button class="chip pr" data-cmd="openPr" title="${escapeHtml(session.prUrl)}"><i class="codicon codicon-git-pull-request"></i>${escapeHtml(session.prRepository ?? 'PR')}#${session.prNumber ?? ''}</button>`
      : '',
  ].join('');

  const body: string[] = [];
  let lastDay: string | undefined;
  for (const e of entries) {
    const day = dayKey(e.timestamp);
    if (day && day !== lastDay && e.timestamp) {
      body.push(`<div class="divider day"><span>${escapeHtml(dayLabel(e.timestamp))}</span></div>`);
      lastDay = day;
    }
    body.push(renderEntry(e, o.showThinking));
  }
  const conversation = body.filter(Boolean).join('\n');
  const toolCount = entries.reduce((n, e) => n + e.parts.filter((p) => p.kind === 'tool_use').length, 0);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${o.cspSource}; font-src ${o.cspSource}; img-src ${o.cspSource} data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${o.codiconCss}">
<link rel="stylesheet" href="${o.css}">
<title>${escapeHtml(session.title)}</title>
</head>
<body${o.highlight?.length ? ` data-highlight="${escapeHtml(JSON.stringify(o.highlight))}"` : ''}>
<nav class="topbar">
  <div class="topbar-title"><span class="claude-dot">${CLAUDE_MARK}</span><span>${escapeHtml(session.title)}</span></div>
  <div class="topbar-actions">
    <button class="btn primary" data-cmd="resume" title="Resume this session with the Claude Code CLI"><i class="codicon codicon-play"></i><span>Resume</span></button>
    ${o.hasClaudeCode ? '<button class="btn" data-cmd="openInClaudeCode" title="Open in the Claude Code chat"><i class="codicon codicon-comment-discussion"></i><span>Open in chat</span></button>' : ''}
    <button class="icon-btn" data-cmd="refresh" title="Reload"><i class="codicon codicon-refresh"></i></button>
    <button class="icon-btn" data-cmd="copyId" title="Copy session ID"><i class="codicon codicon-copy"></i></button>
    <button class="icon-btn" data-cmd="openRawFile" title="Open raw JSONL"><i class="codicon codicon-json"></i></button>
  </div>
</nav>
<header class="hero">
  <h1>${escapeHtml(session.title)}</h1>
  <div class="chips">${chips}</div>
  ${
    toolCount
      ? `<label class="switch"><input type="checkbox" id="show-tools" checked><span class="track"><span class="thumb"></span></span>Show ${toolCount} tool call${toolCount === 1 ? '' : 's'}</label>`
      : ''
  }
</header>
<main class="conversation">
${conversation || '<div class="empty"><i class="codicon codicon-comment-discussion"></i><p>This session has no messages yet.</p></div>'}
</main>
<button class="fab" id="jump" title="Jump to latest"><i class="codicon codicon-arrow-down"></i></button>
<script nonce="${nonce}" src="${o.js}"></script>
</body>
</html>`;
}

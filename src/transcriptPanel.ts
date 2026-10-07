import { randomBytes } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { escapeHtml, formatDateTime, formatTokens, formatUsd } from './format';
import { renderMarkdown } from './markdown';
import { projectName, projectPath, SessionModel } from './model';
import { parseCopilotTranscript } from './copilotCliParser';
import { parseTranscript, SessionInfo, TranscriptEntry, TranscriptPart } from './sessionParser';
import { parseChatTranscript } from './vscodeChatParser';
import { isClaude, NO_FOLDER, sessionKey, SourceInfo, SOURCES, sourceOf } from './sources';
import { UsageSummary } from './usage';

type ToolPart = Extract<TranscriptPart, { kind: 'tool_use' }>;

/** A transcript tab and what it currently shows; the preview tab switches sessions, so this is mutable. */
interface TranscriptTab {
  panel: vscode.WebviewPanel;
  session: SessionInfo;
  /** Search words to highlight, from the search that opened it. */
  highlight: string[];
  preview: boolean;
}

/**
 * Like VS Code's preview editors: by default every transcript opens in one shared preview tab that is replaced by the
 * next one opened. "Keep open" (or double-clicking the card) turns it into a regular tab that stays. A session that
 * already has a regular tab is just focused.
 */
export class TranscriptPanels {
  /** Regular (kept) tabs by session key. */
  private readonly pinned = new Map<string, TranscriptTab>();
  private preview: TranscriptTab | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly hasClaudeCode: () => boolean,
    private readonly model: SessionModel,
  ) {}

  /**
   * Opens the transcript; `highlight` words are marked and the page opens at the first match.
   * `keepOpen` opens it in (or turns the preview into) a regular tab instead of the preview tab.
   */
  async open(session: SessionInfo, highlight: string[] = [], keepOpen = false): Promise<void> {
    const usePreview = !keepOpen && vscode.workspace.getConfiguration('claudeSessions').get<boolean>('reuseTranscriptTab', true);
    const key = sessionKey(session);
    let tab = this.pinned.get(key);
    if (!tab && this.preview && sessionKey(this.preview.session) === key) {
      tab = this.preview;
      if (!usePreview) {
        this.promote(tab);
      }
    }
    if (!tab && usePreview && this.preview) {
      tab = this.preview;
    }
    if (tab) {
      tab.session = session;
      tab.highlight = highlight;
      tab.panel.reveal();
      await this.render(tab);
      return;
    }
    tab = this.create(session, highlight, usePreview);
    await this.render(tab);
  }

  private create(session: SessionInfo, highlight: string[], preview: boolean): TranscriptTab {
    const panel = vscode.window.createWebviewPanel('claudeSessions.transcript', session.title, vscode.ViewColumn.Active, {
      enableScripts: true,
      enableFindWidget: true,
      retainContextWhenHidden: true,
      localResourceRoots: [this.codiconsUri, this.mediaUri],
    });
    const tab: TranscriptTab = { panel, session, highlight, preview };
    if (preview) {
      this.preview = tab;
    } else {
      this.pinned.set(sessionKey(session), tab);
    }
    panel.onDidDispose(() => {
      if (this.preview === tab) {
        this.preview = undefined;
      } else if (this.pinned.get(sessionKey(tab.session)) === tab) {
        this.pinned.delete(sessionKey(tab.session));
      }
    });
    panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg?.command) {
        case 'resume':
        case 'continueInNewSession':
        case 'continueInNewSessionWithModel':
        case 'openInClaudeCode':
        case 'copyId':
        case 'openRawFile':
        case 'openPr':
          vscode.commands.executeCommand(`claudeSessions.${msg.command}`, tab.session);
          break;
        case 'copyText':
          if (typeof msg.text === 'string') {
            await vscode.env.clipboard.writeText(msg.text);
            vscode.window.setStatusBarMessage('Copied to clipboard', 2000);
          }
          break;
        case 'refresh':
          // Re-read the log first so the stats are current too.
          await this.model.reload();
          tab.session = this.model.find(sessionKey(tab.session)) ?? tab.session;
          this.render(tab);
          break;
        case 'keepOpen':
          if (tab.preview) {
            this.promote(tab);
            this.render(tab);
          }
          break;
      }
    });
    return tab;
  }

  /** Turns the preview tab into a regular tab; the next transcript opened gets a new preview tab. */
  private promote(tab: TranscriptTab): void {
    if (this.preview === tab) {
      this.preview = undefined;
    }
    tab.preview = false;
    this.pinned.set(sessionKey(tab.session), tab);
  }

  private get codiconsUri() {
    return vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist');
  }

  private get mediaUri() {
    return vscode.Uri.joinPath(this.extensionUri, 'media');
  }

  private async render(tab: TranscriptTab): Promise<void> {
    const { panel, session } = tab;
    // The preview tab switches sessions, and with them sources.
    const claudeCode = vscode.extensions.getExtension('anthropic.claude-code');
    panel.iconPath =
      isClaude(session) && claudeCode
        ? vscode.Uri.joinPath(claudeCode.extensionUri, 'resources', 'claude-logo.svg')
        : new vscode.ThemeIcon(isClaude(session) ? 'comment-discussion' : SOURCES[sourceOf(session)].icon);
    let entries: TranscriptEntry[];
    try {
      entries = readTranscript(session, await fs.readFile(session.filePath, 'utf8'));
    } catch (err) {
      vscode.window.showErrorMessage(`Could not read session log: ${(err as Error).message}`);
      return;
    }
    const showThinking = vscode.workspace.getConfiguration('claudeSessions').get<boolean>('showThinking', false);
    const webview = panel.webview;
    panel.title = session.title;
    webview.html = buildHtml(session, entries, {
      showThinking,
      highlight: tab.highlight,
      preview: tab.preview,
      hasClaudeCode: this.hasClaudeCode(),
      cspSource: webview.cspSource,
      codiconCss: webview.asWebviewUri(vscode.Uri.joinPath(this.codiconsUri, 'codicon.css')).toString(),
      css: webview.asWebviewUri(vscode.Uri.joinPath(this.mediaUri, 'transcript.css')).toString(),
      js: webview.asWebviewUri(vscode.Uri.joinPath(this.mediaUri, 'transcript.js')).toString(),
    });
  }
}

/** The session's log as transcript entries, read with the parser for its source. */
function readTranscript(session: SessionInfo, text: string): TranscriptEntry[] {
  switch (sourceOf(session)) {
    case 'copilot-cli':
      return parseCopilotTranscript(text);
    case 'vscode-chat':
      return parseChatTranscript(text);
    default:
      return parseTranscript(text);
  }
}

interface HtmlOptions {
  showThinking: boolean;
  /** Search words for transcript.js to mark. */
  highlight?: string[];
  /** Shown in the shared preview tab: offer "Keep open". */
  preview?: boolean;
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
  // GitHub Copilot CLI and VS Code Chat.
  view: 'file',
  create: 'new-file',
  str_replace: 'edit',
  str_replace_editor: 'edit',
  apply_patch: 'edit',
  shell: 'terminal',
  run_in_terminal: 'terminal',
  report_intent: 'lightbulb',
  update_todo: 'checklist',
  fetch: 'globe',
  web_fetch: 'globe',
  think: 'lightbulb',
};

/** VS Code Chat tool ids carry a prefix ("copilot_readFile"); the rest names the action. */
const TOOL_WORDS: [RegExp, string][] = [
  [/read|view|open/i, 'file'],
  [/create|new/i, 'new-file'],
  [/edit|replace|insert|patch/i, 'edit'],
  [/terminal|run|exec|shell/i, 'terminal'],
  [/search|find|grep/i, 'search'],
  [/fetch|web/i, 'globe'],
  [/todo/i, 'checklist'],
];

function toolIcon(name: string): string {
  const key = name.toLowerCase();
  if (TOOL_ICONS[key]) {
    return TOOL_ICONS[key];
  }
  if (key.startsWith('mcp__')) {
    return 'plug';
  }
  if (key.startsWith('copilot_') || key.startsWith('vscode_')) {
    return TOOL_WORDS.find(([re]) => re.test(key))?.[1] ?? 'tools';
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

/** The assistant's avatar: Claude's mark, or the source's codicon. */
function assistantMark(source: SourceInfo): string {
  return source.id === 'claude' ? CLAUDE_MARK : `<i class="codicon codicon-${source.icon}"></i>`;
}

function renderEntry(e: TranscriptEntry, showThinking: boolean, source: SourceInfo): string {
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
  const role = e.role === 'tool' ? 'Tools' : source.assistant;
  return `
    <div class="msg assistant">
      <div class="avatar ${source.id === 'claude' ? 'claude-avatar' : 'source-avatar'}">${assistantMark(source)}</div>
      <div class="msg-main">
        <div class="msg-meta"><strong>${role}</strong>${time(e.timestamp)}</div>
        ${body}
      </div>
    </div>`;
}

const CONTEXT_WARN = 0.8;

/** Context, prompt cache, cost and token tiles, with the cost broken down by token type underneath. */
function renderStats(u: UsageSummary): string {
  const tiles: string[] = [];
  if (u.context) {
    const fill = u.context.tokens / u.context.limit;
    tiles.push(`
      <div class="stat${fill >= CONTEXT_WARN ? ' warn' : ''}">
        <div class="stat-label"><i class="codicon codicon-pie-chart"></i>Context</div>
        <div class="stat-value">${formatTokens(u.context.tokens)}<span> / ${formatTokens(u.context.limit)}</span></div>
        <div class="meter"><span data-fill="${fill.toFixed(4)}"></span></div>
        <div class="stat-sub">${Math.round(fill * 100)}% full at the last request</div>
      </div>`);
  }
  if (u.cache) {
    const expires = u.cache.lastRequest + u.cache.ttlMs;
    const ttl = u.cache.ttlMs >= 3_600_000 ? '1-hour' : '5-minute';
    tiles.push(`
      <div class="stat cache" data-expires="${expires}" title="Claude Code caches the conversation so the next request reads it at a fraction of the input price. Each request refreshes the ${ttl} timer; after it lapses, resuming writes the whole context to the cache again.">
        <div class="stat-label"><i class="codicon codicon-watch"></i>Prompt cache</div>
        <div class="stat-value" data-cache-value></div>
        <div class="stat-sub"><span data-cache-sub></span> · ${ttl} cache</div>
      </div>`);
  }
  tiles.push(`
    <div class="stat">
      <div class="stat-label"><i class="codicon codicon-credit-card"></i>Cost at API prices</div>
      <div class="stat-value">${formatUsd(u.cost)}</div>
      <div class="stat-sub">${u.requests} request${u.requests === 1 ? '' : 's'}${u.subagentCost >= 0.01 ? ` · ${formatUsd(u.subagentCost)} subagents` : ''}</div>
    </div>`);
  const t = u.tokens;
  const input = t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead;
  tiles.push(`
    <div class="stat">
      <div class="stat-label"><i class="codicon codicon-symbol-numeric"></i>Tokens</div>
      <div class="stat-value">${formatTokens(input)}<span> in</span> · ${formatTokens(t.output)}<span> out</span></div>
      <div class="stat-sub">${input ? Math.round((t.cacheRead / input) * 100) : 0}% of input read from cache</div>
    </div>`);

  const rows: [string, number | undefined, number][] = [
    ['Input', t.input, u.costs.input],
    ['Cache writes, 5 minutes', t.cacheWrite5m, u.costs.cacheWrite5m],
    ['Cache writes, 1 hour', t.cacheWrite1h, u.costs.cacheWrite1h],
    ['Cache reads', t.cacheRead, u.costs.cacheRead],
    ['Output', t.output, u.costs.output],
    ['Web searches', undefined, u.costs.webSearch],
  ];
  const table = rows
    .filter(([, tokens, cost]) => (tokens ?? 0) > 0 || cost > 0)
    .map(
      ([label, tokens, cost]) =>
        `<tr><td>${label}</td><td>${tokens === undefined ? '' : tokens.toLocaleString()}</td><td>${formatUsd(cost)}</td></tr>`,
    )
    .join('');
  const unpriced = u.unpriced.length
    ? ` No price is known for ${u.unpriced.map(escapeHtml).join(', ')}, so its tokens are counted but not costed.`
    : '';
  return `
    <div class="stats">${tiles.join('')}</div>
    <details class="cost-breakdown">
      <summary>Cost breakdown</summary>
      <table>
        <thead><tr><th></th><th>Tokens</th><th>Cost</th></tr></thead>
        <tbody>${table}</tbody>
        <tfoot><tr><td>Total</td><td></td><td>${formatUsd(u.cost)}</td></tr></tfoot>
      </table>
      <p class="note">Estimated from the token counts in the session log at Claude API list prices, subagents included. On a Pro or Max plan you aren't billed per token, so this shows what the session would cost through the API.${unpriced}</p>
    </details>`;
}

/**
 * One-line version of the stats for the sticky top bar, shown once the full tiles scroll out of view.
 * Clicking it goes back to the top, where the tiles and the cost breakdown are.
 */
function renderStatsStrip(session: SessionInfo, toolCount: number): string {
  const u = session.usage;
  const items: string[] = [];
  if (session.model) {
    items.push(`<span><i class="codicon codicon-sparkle"></i>${escapeHtml(session.model)}${u?.effort ? ` · ${escapeHtml(u.effort)}` : ''}</span>`);
  }
  if (u?.context) {
    const fill = u.context.tokens / u.context.limit;
    items.push(
      `<span class="${fill >= CONTEXT_WARN ? 'warn' : ''}" title="Context window at the last request"><i class="codicon codicon-pie-chart"></i>${formatTokens(u.context.tokens)} / ${formatTokens(u.context.limit)} · ${Math.round(fill * 100)}%</span>`,
    );
  }
  if (u?.cache) {
    items.push(`<span class="cache" data-expires="${u.cache.lastRequest + u.cache.ttlMs}" title="Prompt cache"><i class="codicon codicon-watch"></i><span data-cache-short></span></span>`);
  }
  if (u) {
    const t = u.tokens;
    items.push(`<span title="Cost at Claude API prices"><i class="codicon codicon-credit-card"></i>${formatUsd(u.cost)}</span>`);
    items.push(
      `<span title="Tokens in and out"><i class="codicon codicon-symbol-numeric"></i>${formatTokens(t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead)} in · ${formatTokens(t.output)} out</span>`,
    );
  }
  if (!items.length && !toolCount) {
    return '';
  }
  const toggle = toolCount
    ? `<label class="switch"><input type="checkbox" data-tools-toggle><span class="track"><span class="thumb"></span></span>Tool calls</label>`
    : '';
  return `<div class="topbar-stats"><button class="strip-stats" id="to-top" title="Back to the top">${items.join('')}</button>${toggle}</div>`;
}

export function buildHtml(session: SessionInfo, entries: TranscriptEntry[], o: HtmlOptions): string {
  const nonce = randomBytes(16).toString('base64');
  const proj = projectPath(session);
  const source = SOURCES[sourceOf(session)];
  const claude = source.id === 'claude';
  const chips = [
    claude ? '' : `<span class="chip"><i class="codicon codicon-${source.icon}"></i>${escapeHtml(source.label)}</span>`,
    `<span class="chip" title="${escapeHtml(proj || NO_FOLDER)}"><i class="codicon codicon-folder"></i>${escapeHtml(projectName(proj))}</span>`,
    session.gitBranch ? `<span class="chip"><i class="codicon codicon-git-branch"></i>${escapeHtml(session.gitBranch)}</span>` : '',
    session.agentName ? `<span class="chip agent"><i class="codicon codicon-hubot"></i>${escapeHtml(session.agentName)}</span>` : '',
    `<span class="chip" title="Started ${escapeHtml(formatDateTime(session.startTime))}"><i class="codicon codicon-calendar"></i>${escapeHtml(formatDateTime(session.lastTime))}</span>`,
    `<span class="chip"><i class="codicon codicon-comment"></i>${session.promptCount} prompt${session.promptCount === 1 ? '' : 's'}</span>`,
    session.model
      ? `<span class="chip"${session.usage?.effort ? ' title="Model and effort of the last request"' : ''}><i class="codicon codicon-sparkle"></i>${escapeHtml(session.model)}${session.usage?.effort ? ` · ${escapeHtml(session.usage.effort)}` : ''}</span>`
      : '',
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
    body.push(renderEntry(e, o.showThinking, source));
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
  <div class="topbar-title"><span class="${claude ? 'claude-dot' : 'source-dot'}">${assistantMark(source)}</span><span>${escapeHtml(session.title)}</span></div>
  <div class="topbar-actions">
    <button class="btn primary" data-cmd="resume" title="${escapeHtml(source.resumeTitle)}"><i class="codicon codicon-${source.id === 'vscode-chat' ? 'chat-sparkle' : 'play'}"></i><span>${escapeHtml(source.resumeLabel)}</span></button>
    ${
      claude
        ? `<button class="btn" data-cmd="continueInNewSession" title="Start a new Claude Code CLI session with a handoff of where this one left off"><i class="codicon codicon-arrow-circle-right"></i><span>Continue in new session</span></button>
    <button class="icon-btn" data-cmd="continueInNewSessionWithModel" title="Continue in a new session with a different model or effort…"><i class="codicon codicon-chevron-down"></i></button>`
        : ''
    }
    ${claude && o.hasClaudeCode ? '<button class="btn" data-cmd="openInClaudeCode" title="Open in the Claude Code chat"><i class="codicon codicon-comment-discussion"></i><span>Open in chat</span></button>' : ''}
    ${o.preview ? '<button class="btn" data-cmd="keepOpen" title="This tab is reused for the next transcript you open. Keep this one in its own tab."><i class="codicon codicon-pinned"></i><span>Keep open</span></button>' : ''}
    <button class="icon-btn" data-cmd="refresh" title="Reload"><i class="codicon codicon-refresh"></i></button>
    <button class="icon-btn" data-cmd="copyId" title="Copy session ID"><i class="codicon codicon-copy"></i></button>
    <button class="icon-btn" data-cmd="openRawFile" title="Open the raw session log"><i class="codicon codicon-json"></i></button>
  </div>
  ${renderStatsStrip(session, toolCount)}
</nav>
<header class="hero">
  <h1>${escapeHtml(session.title)}</h1>
  <div class="chips">${chips}</div>
  ${session.usage ? renderStats(session.usage) : ''}
  ${
    toolCount
      ? `<label class="switch"><input type="checkbox" id="show-tools" data-tools-toggle checked><span class="track"><span class="thumb"></span></span>Show ${toolCount} tool call${toolCount === 1 ? '' : 's'}</label>`
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

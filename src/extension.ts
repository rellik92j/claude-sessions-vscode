import { execFile } from 'child_process';
import { existsSync, statSync } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { formatRelative, isInside } from './format';
import { buildHandoff, collectHandoffFacts, collectTranscriptFacts } from './handoff';
import { GroupBy, projectName, projectPath, SessionModel, workspaceFolderPaths } from './model';
import { isEmptyQuery, parseQuery } from './query';
import { SessionInfo, SessionSource } from './sessionParser';
import { defaultCopilotDir, defaultProjectsDir, defaultVsCodeUserDirs, SessionStore, SourceRoots, sortTime } from './sessionStore';
import { isClaude, sessionKey, SOURCE_IDS, SOURCES, sourceOf, toSources } from './sources';
import { parseTranscriptFor } from './transcripts';
import { OverviewPanel } from './overviewPanel';
import { SidebarView } from './sidebarView';
import { TranscriptPanels } from './transcriptPanel';

const CONFIG = 'claudeSessions';
const CLAUDE_CODE_EXTENSION = 'anthropic.claude-code';

function config() {
  return vscode.workspace.getConfiguration(CONFIG);
}

function projectsDir(): string {
  return config().get<string>('projectsDir')?.trim() || defaultProjectsDir();
}

/** Folders of GitHub Copilot CLI and VS Code Chat sessions, from the settings or the defaults. */
function sourceRoots(): SourceRoots {
  const vscodeUserDir = config().get<string>('vscodeUserDir')?.trim();
  return {
    copilotDir: config().get<string>('copilotDir')?.trim() || defaultCopilotDir(),
    vscodeUserDirs: vscodeUserDir ? [vscodeUserDir] : defaultVsCodeUserDirs(),
  };
}

const hasClaudeCode = () => !!vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION);

/** Matches the Claude Code extension's "Open in Terminal": a terminal tab in the editor area with the Claude logo. */
function claudeTerminalOptions(name: string, cwd: string | undefined, iconPath?: vscode.TerminalOptions['iconPath']): vscode.TerminalOptions {
  const inEditor = config().get<string>('terminalLocation', 'editor') === 'editor';
  const claudeCode = vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION);
  return {
    name,
    cwd,
    iconPath:
      iconPath ??
      (claudeCode
        ? vscode.Uri.joinPath(claudeCode.extensionUri, 'resources', 'claude-logo.svg')
        : new vscode.ThemeIcon('comment-discussion')),
    location: inEditor ? { viewColumn: vscode.ViewColumn.Beside } : vscode.TerminalLocation.Panel,
  };
}

/** The command that resumes a CLI session (Claude Code or GitHub Copilot CLI). */
function resumeCommand(session: SessionInfo): string {
  const command = isClaude(session)
    ? config().get<string>('claudeCommand', 'claude') || 'claude'
    : config().get<string>('copilotCommand', 'copilot') || 'copilot';
  return `${command} --resume ${session.id}`;
}

/**
 * VS Code's own address for a chat stored in a workspace: vscode-chat-session://local/<base64url session id>. Opening it
 * shows the chat in an editor, but only in the window whose workspace the chat belongs to.
 */
function chatSessionUri(id: string): vscode.Uri {
  const encoded = Buffer.from(id, 'utf8').toString('base64url');
  return vscode.Uri.from({ scheme: 'vscode-chat-session', authority: 'local', path: `/${encoded}` });
}

/**
 * The claudeCommand setting as executable + leading arguments, for starting the CLI directly. A value that is an
 * existing path is kept whole (it may contain spaces); otherwise it is split on whitespace ("npx claude").
 */
function claudeCommandParts(): string[] {
  const command = (config().get<string>('claudeCommand', 'claude') || 'claude').trim();
  return existsSync(command) ? [command] : command.split(/\s+/);
}

/** `git status --short --branch` in the folder, or undefined when it isn't a repository or git isn't available. */
function gitStatus(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['status', '--short', '--branch'], { cwd, timeout: 5000, windowsHide: true }, (err, stdout) =>
      resolve(err ? undefined : stdout),
    );
  });
}

export function activate(context: vscode.ExtensionContext): void {
  const store = new SessionStore(projectsDir(), sourceRoots());
  const model = new SessionModel(store);
  const transcripts = new TranscriptPanels(context.extensionUri, hasClaudeCode, model);
  const overview = new OverviewPanel(context.extensionUri, model);

  /**
   * Commands receive a SessionInfo (from the transcript page or quick pick), a webview context
   * object with a sessionId (right-click in the sidebar), or nothing (command palette).
   */
  const toSession = (arg: unknown): SessionInfo | undefined => {
    if (arg && typeof arg === 'object') {
      if ('filePath' in arg && 'id' in arg) {
        return arg as SessionInfo;
      }
      if ('sessionKey' in arg && typeof arg.sessionKey === 'string') {
        return model.find(arg.sessionKey);
      }
      if ('sessionId' in arg && typeof arg.sessionId === 'string') {
        return model.find(arg.sessionId);
      }
    }
    return undefined;
  };

  const setConfig = (key: string, value: unknown) =>
    config().update(key, value, vscode.ConfigurationTarget.Global);

  const sidebar = new SidebarView(context.extensionUri, model, setConfig, hasClaudeCode);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarView.viewId, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const applyConfig = () => {
    model.groupBy = config().get<GroupBy>('groupBy', 'project');
    model.workspaceOnly = config().get<boolean>('currentWorkspaceOnly', false);
    model.hideEmpty = config().get<boolean>('hideEmptySessions', true);
  };
  // The sources setting is the default; the sidebar's chips change the model's copy until the setting changes again.
  const applySources = () => {
    model.sources = new Set(toSources(config().get<unknown>('sources')));
  };
  applySources();
  const updateClaudeCodeContext = () =>
    vscode.commands.executeCommand('setContext', 'claudeSessions.hasClaudeCode', hasClaudeCode());
  updateClaudeCodeContext();
  applyConfig();

  // File watching: re-parse only the logs that changed, debounced because active sessions write constantly.
  let watchers: vscode.FileSystemWatcher[] = [];
  let debounce: NodeJS.Timeout | undefined;
  const scheduleReload = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => model.reload(), 1500);
  };
  // A new or deleted chat may be in a workspace folder the store hasn't seen holding chats.
  const scheduleRescan = () => {
    store.rescan();
    scheduleReload();
  };
  const watch = () => {
    watchers.forEach((w) => w.dispose());
    const patterns: [string, string][] = [[store.projectsDir, '*/*.jsonl']];
    if (store.roots.copilotDir) {
      const stateDir = path.join(store.roots.copilotDir, 'session-state');
      patterns.push([stateDir, '*/{events.jsonl,workspace.yaml}'], [stateDir, '*.jsonl']);
    }
    for (const userDir of store.roots.vscodeUserDirs ?? []) {
      patterns.push([userDir, 'workspaceStorage/*/chatSessions/*'], [userDir, 'globalStorage/emptyWindowChatSessions/*']);
    }
    watchers = patterns.map(([base, glob]) => {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), glob));
      w.onDidCreate(scheduleRescan);
      w.onDidChange(scheduleReload);
      w.onDidDelete(scheduleRescan);
      return w;
    });
  };
  watch();

  context.subscriptions.push(
    { dispose: () => watchers.forEach((w) => w.dispose()) },
    { dispose: () => clearTimeout(debounce) },
    vscode.extensions.onDidChange(() => {
      updateClaudeCodeContext();
      model.refreshView();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => model.refreshView()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(CONFIG)) {
        return;
      }
      applyConfig();
      if (e.affectsConfiguration(`${CONFIG}.sources`)) {
        applySources();
      }
      if (
        e.affectsConfiguration(`${CONFIG}.projectsDir`) ||
        e.affectsConfiguration(`${CONFIG}.copilotDir`) ||
        e.affectsConfiguration(`${CONFIG}.vscodeUserDir`)
      ) {
        store.setProjectsDir(projectsDir());
        store.setRoots(sourceRoots());
        watch();
        model.reload();
      } else {
        model.refreshView();
      }
    }),
  );

  // One terminal per session, so resuming twice focuses the running CLI instead of starting a second one.
  const sessionTerminals = new Map<string, vscode.Terminal>();
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((t) => {
      for (const [id, term] of sessionTerminals) {
        if (term === t) {
          sessionTerminals.delete(id);
        }
      }
    }),
  );

  /** Opens a VS Code chat in this window when it belongs here; otherwise offers its folder's window. */
  const openChat = async (session: SessionInfo) => {
    // Chats live in workspaceStorage/<hash>/chatSessions/; this extension's own storage sits in the same <hash> folder.
    const chatWorkspace = path.basename(path.dirname(path.dirname(session.filePath)));
    const thisWorkspace = context.storageUri && path.basename(path.dirname(context.storageUri.fsPath));
    if (chatWorkspace === thisWorkspace) {
      try {
        await vscode.commands.executeCommand('vscode.open', chatSessionUri(session.id));
        return;
      } catch {
        // Fall through to the chat view.
      }
      await vscode.commands.executeCommand('workbench.action.chat.open');
      vscode.window.showInformationMessage(`Couldn't open the chat directly. Find "${session.title}" in the chat history.`);
      return;
    }
    const folder = projectPath(session);
    const choice = await vscode.window.showInformationMessage(
      folder
        ? `This chat belongs to ${folder}. VS Code opens a chat only in the window of its own folder.`
        : 'This chat was started in a window without a folder, so VS Code can only show it there.',
      ...(folder && existsSync(folder) ? ['Open Folder in New Window'] : []),
      'Read Transcript',
    );
    if (choice === 'Open Folder in New Window') {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), { forceNewWindow: true });
    } else if (choice === 'Read Transcript') {
      await transcripts.open(session);
    }
  };

  const resume = (session: SessionInfo) => {
    if (sourceOf(session) === 'vscode-chat') {
      return openChat(session);
    }
    const key = sessionKey(session);
    const existing = sessionTerminals.get(key);
    if (existing && existing.exitStatus === undefined) {
      existing.show();
      return;
    }
    const tool = SOURCES[sourceOf(session)].label;
    const cwd = projectPath(session);
    const hasCwd = !!cwd && existsSync(cwd);
    if (!hasCwd) {
      vscode.window.showWarningMessage(
        `The session's folder no longer exists (${cwd || 'unknown'}). ${tool} looks sessions up by folder, so resuming may fail.`,
      );
    }
    const terminal = vscode.window.createTerminal(
      claudeTerminalOptions(
        `${tool} · ${session.title.slice(0, 40)}`,
        hasCwd ? cwd : undefined,
        isClaude(session) ? undefined : new vscode.ThemeIcon(SOURCES[sourceOf(session)].icon),
      ),
    );
    sessionTerminals.set(key, terminal);
    terminal.show();
    terminal.sendText(resumeCommand(session));
  };

  /**
   * Starts a new CLI session whose first prompt is a handoff of where this one left off, optionally with a model
   * and effort that override the user's Claude Code settings.
   */
  /**
   * Starts a new session in `target` (by default the session's own tool) whose first prompt is a handoff of where this
   * one left off. `overrides` (model, effort) apply to the CLIs; a VS Code chat uses its own model picker.
   */
  const continueInNewSession = async (session: SessionInfo, overrides: Overrides = {}, target: SessionSource = sourceOf(session)) => {
    const cwd = projectPath(session);
    const hasCwd = !!cwd && existsSync(cwd);
    if (!hasCwd && target !== 'vscode-chat') {
      vscode.window.showWarningMessage(`The session's folder no longer exists (${cwd || 'unknown'}). The new session starts in the default folder.`);
    }
    let log: string;
    try {
      log = await fs.readFile(session.filePath, 'utf8');
    } catch (err) {
      vscode.window.showErrorMessage(`Could not read session log: ${(err as Error).message}`);
      return;
    }
    const facts = isClaude(session) ? collectHandoffFacts(log) : collectTranscriptFacts(parseTranscriptFor(session, log), cwd || undefined);
    // A handoff saved to a scratchpad may since have been cleaned up.
    facts.handoffNotes = facts.handoffNotes?.filter((n) => /^https?:/.test(n) || statSync(n, { throwIfNoEntry: false })?.isFile());
    const handoff = buildHandoff(session, facts, cwd || undefined, hasCwd ? await gitStatus(cwd) : undefined, target);
    // Continuing a continued session keeps one "Continued: " rather than stacking them.
    const title = session.title.replace(/^(Continued: )+/, '');
    if (target === 'vscode-chat') {
      return continueInChat(session, handoff);
    }
    if (target === 'copilot-cli') {
      return continueInCopilot(handoff, title, hasCwd ? cwd : undefined, overrides);
    }
    const [shellPath, ...shellArgs] = claudeCommandParts();
    // The CLI is the terminal's process rather than a command typed into a shell, so the multi-line handoff arrives
    // as one argument whatever the shell's quoting rules (Windows PowerShell 5.1 strips embedded double quotes).
    // The CLI sends a prompt given this way at once; the handoff ends by asking Claude to summarise and wait.
    const terminal = vscode.window.createTerminal({
      ...claudeTerminalOptions(`Claude Code · Continued: ${title.slice(0, 30)}`, hasCwd ? cwd : undefined),
      shellPath,
      shellArgs: [
        ...shellArgs,
        ...(overrides.model ? ['--model', overrides.model] : []),
        ...(overrides.effort ? ['--effort', overrides.effort] : []),
        '--name',
        `Continued: ${title}`,
        handoff,
      ],
    });
    terminal.show();
  };

  /**
   * Copilot CLI is often a .bat or .ps1 shim on Windows, which would split a multi-line argument, so the handoff goes
   * in a file the CLI is given access to, and the one-line prompt typed into the shell points at it.
   */
  const continueInCopilot = async (handoff: string, title: string, cwd: string | undefined, overrides: Overrides) => {
    const dir = path.join(os.tmpdir(), 'claude-sessions-handoffs');
    const file = path.join(dir, `handoff-${Date.now()}.md`);
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file, handoff, 'utf8');
    } catch (err) {
      vscode.window.showErrorMessage(`Could not write the handoff: ${(err as Error).message}`);
      return;
    }
    // Double quotes are the one quoting PowerShell, cmd and POSIX shells share; values never contain them.
    const quote = (s: string) => `"${s.replace(/"/g, "'")}"`;
    const command = config().get<string>('copilotCommand', 'copilot') || 'copilot';
    const args = [
      '--add-dir',
      quote(dir),
      ...(overrides.model ? ['--model', quote(overrides.model)] : []),
      ...(overrides.effort ? ['--reasoning-effort', overrides.effort] : []),
      '--name',
      quote(`Continued: ${title}`),
      '-i',
      quote(`Read the handoff in ${file}: it describes where an earlier session left off. Then do what its last paragraph asks.`),
    ];
    const terminal = vscode.window.createTerminal(
      claudeTerminalOptions(`GitHub Copilot CLI · Continued: ${title.slice(0, 30)}`, cwd, new vscode.ThemeIcon(SOURCES['copilot-cli'].icon)),
    );
    terminal.show();
    terminal.sendText(`${command} ${args.join(' ')}`);
  };

  /** A new VS Code chat in agent mode with the handoff in its input box, for you to review, pick a model and send. */
  const continueInChat = async (session: SessionInfo, handoff: string) => {
    await vscode.commands.executeCommand('workbench.action.chat.newChat');
    await vscode.commands.executeCommand('workbench.action.chat.open', { mode: 'agent', query: handoff, isPartialQuery: true });
    const cwd = projectPath(session);
    if (cwd && !workspaceFolderPaths().some((f) => isInside(cwd, f))) {
      vscode.window.showInformationMessage(
        `The handoff is in a new chat. That chat works in this window's folder, not in ${cwd}, where the session ran.`,
      );
    }
  };

  const openInClaudeCode = async (session: SessionInfo) => {
    if (!vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION)) {
      vscode.window.showErrorMessage('The Claude Code extension (anthropic.claude-code) is not installed.');
      return;
    }
    const folders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    if (!folders.some((f) => isInside(projectPath(session), f))) {
      const choice = await vscode.window.showWarningMessage(
        `This session was started in ${projectPath(session)}, which isn't open in this window. The Claude Code chat may not find it.`,
        'Resume in Terminal Instead',
        'Try Anyway',
      );
      if (choice === 'Resume in Terminal Instead') {
        return resume(session);
      }
      if (choice !== 'Try Anyway') {
        return;
      }
    }
    await vscode.commands.executeCommand('claude-vscode.editor.open', session.id);
  };

  const withSession = (fn: (s: SessionInfo) => unknown) => (arg: unknown) => {
    const s = toSession(arg);
    if (s) {
      return fn(s);
    }
    return pickSession(model).then((picked) => picked && fn(picked));
  };

  /** For commands that only make sense for Claude Code sessions: the picker lists only those, and others are refused. */
  const withClaudeSession = (what: string, fn: (s: SessionInfo) => unknown) => (arg: unknown) => {
    const s = toSession(arg);
    if (s && !isClaude(s)) {
      vscode.window.showInformationMessage(`${what} works only for Claude Code sessions.`);
      return;
    }
    if (s) {
      return fn(s);
    }
    return pickSession(model, isClaude).then((picked) => picked && fn(picked));
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSessions.refresh', () => {
      store.rescan();
      return model.reload();
    }),
    vscode.commands.registerCommand('claudeSessions.focusSearch', () => sidebar.focusSearch()),
    vscode.commands.registerCommand('claudeSessions.openOverview', () => overview.show()),
    vscode.commands.registerCommand('claudeSessions.search', () => searchSessions(model)),
    vscode.commands.registerCommand('claudeSessions.groupByProject', () => setConfig('groupBy', 'project')),
    vscode.commands.registerCommand('claudeSessions.groupByDate', () => setConfig('groupBy', 'date')),
    vscode.commands.registerCommand('claudeSessions.showCurrentWorkspaceOnly', () => setConfig('currentWorkspaceOnly', true)),
    vscode.commands.registerCommand('claudeSessions.showAll', () => setConfig('currentWorkspaceOnly', false)),
    vscode.commands.registerCommand('claudeSessions.resume', withSession(resume)),
    vscode.commands.registerCommand('claudeSessions.continueInNewSession', withSession((s) => continueInNewSession(s))),
    vscode.commands.registerCommand(
      'claudeSessions.continueInNewSessionWithModel',
      withSession(async (s) => {
        const choice = await pickContinuation(s);
        if (choice) {
          await continueInNewSession(s, choice.overrides, choice.target);
        }
      }),
    ),
    vscode.commands.registerCommand('claudeSessions.openInClaudeCode', withClaudeSession('Open in Claude Code Chat', openInClaudeCode)),
    // Optional arguments: search words to highlight in the transcript, and true to open it in its own tab
    // rather than the shared preview tab.
    vscode.commands.registerCommand('claudeSessions.openTranscript', (arg: unknown, highlight?: unknown, keepOpen?: unknown) =>
      withSession((s) => transcripts.open(s, toTokens(highlight), keepOpen === true))(arg),
    ),
    vscode.commands.registerCommand(
      'claudeSessions.openTranscriptInNewTab',
      withSession((s) => transcripts.open(s, [], true)),
    ),
    vscode.commands.registerCommand(
      'claudeSessions.openRawFile',
      withSession((s) => vscode.window.showTextDocument(vscode.Uri.file(s.filePath), { preview: true })),
    ),
    vscode.commands.registerCommand(
      'claudeSessions.copyId',
      withSession(async (s) => {
        await vscode.env.clipboard.writeText(s.id);
        vscode.window.setStatusBarMessage(`Copied session ID ${s.id}`, 3000);
      }),
    ),
    vscode.commands.registerCommand(
      'claudeSessions.copyResumeCommand',
      withSession(async (s) => {
        if (sourceOf(s) === 'vscode-chat') {
          vscode.window.showInformationMessage('VS Code chats have no resume command. Use Open in Chat instead.');
          return;
        }
        const cwd = projectPath(s);
        await vscode.env.clipboard.writeText(cwd ? `cd "${cwd}" && ${resumeCommand(s)}` : resumeCommand(s));
        vscode.window.setStatusBarMessage('Copied resume command', 3000);
      }),
    ),
    vscode.commands.registerCommand(
      'claudeSessions.openPr',
      withSession((s) => s.prUrl && vscode.env.openExternal(vscode.Uri.parse(s.prUrl))),
    ),
    vscode.commands.registerCommand('claudeSessions.revealFolder', (arg: unknown) => {
      const folder =
        arg && typeof arg === 'object' && 'projectPath' in arg && typeof arg.projectPath === 'string'
          ? arg.projectPath
          : undefined;
      if (folder) {
        vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folder), { forceNewWindow: true });
      }
    }),
  );

  model.reload();
}

/** CLI flags for a new session; undefined fields keep the user's Claude Code settings. */
interface Overrides {
  model?: string;
  effort?: string;
}

interface ValuePick extends vscode.QuickPickItem {
  value?: string;
}

const OTHER_MODEL = '\0other';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Asks which tool the new session runs in, then (for a CLI) its model and effort. Undefined when any step is cancelled.
 * A VS Code chat has its own model picker, so it takes no overrides.
 */
async function pickContinuation(session: SessionInfo): Promise<{ target: SessionSource; overrides: Overrides } | undefined> {
  const title = 'Continue in New Session';
  const own = sourceOf(session);
  const tools = [own, ...SOURCE_IDS.filter((id) => id !== own)].map((id) => ({
    label: `$(${id === 'claude' ? 'sparkle' : SOURCES[id].icon}) ${SOURCES[id].label}`,
    description: id === own ? 'same as this session' : undefined,
    detail: id === 'vscode-chat' ? 'A new chat with the handoff in the input box, to send when you are ready' : undefined,
    value: id,
  }));
  const tool = await vscode.window.showQuickPick(tools, { title: `${title} (1/3): tool`, placeHolder: 'Where the new session runs' });
  if (!tool) {
    return undefined;
  }
  const target = tool.value;
  if (target === 'vscode-chat') {
    return { target, overrides: {} };
  }
  const overrides = await pickOverrides(session, target, title);
  return overrides && { target, overrides };
}

/** Asks for the model, then the effort, of a continued CLI session. Undefined when either step is cancelled. */
async function pickOverrides(session: SessionInfo, target: SessionSource, title: string): Promise<Overrides | undefined> {
  const usedHere = 'used by this session';
  const claude = target === 'claude';
  const settings = claude ? 'whatever your Claude Code settings say' : 'whatever your Copilot CLI settings say';
  // Aliases always mean the latest model of each family, so the list doesn't go stale. Copilot CLI's models change
  // with your plan, so it is offered the session's own model and a free-form name.
  const models: ValuePick[] = [
    { label: '$(settings-gear) Default', description: settings },
    ...(claude
      ? [
          { label: 'Opus', description: 'opus · latest Opus', value: 'opus' },
          { label: 'Sonnet', description: 'sonnet · latest Sonnet', value: 'sonnet' },
          { label: 'Haiku', description: 'haiku · latest Haiku', value: 'haiku' },
          { label: 'Fable', description: 'fable · latest Fable', value: 'fable' },
        ]
      : []),
    ...(session.model && sourceOf(session) === target ? [{ label: session.model, description: usedHere, value: session.model }] : []),
    { label: '$(edit) Other model…', description: 'enter a model name', value: OTHER_MODEL },
  ];
  const model = await vscode.window.showQuickPick(models, { title: `${title} (2/3): model`, placeHolder: 'Model for the new session' });
  if (!model) {
    return undefined;
  }
  let modelValue = model.value;
  if (modelValue === OTHER_MODEL) {
    modelValue = (
      await vscode.window.showInputBox({
        title,
        prompt: claude ? 'Model alias or full name, as for claude --model' : 'Model name, as for copilot --model',
        placeHolder: claude ? 'claude-opus-5-5' : 'gpt-5.4',
      })
    )?.trim();
    if (!modelValue) {
      return undefined;
    }
  }
  const sessionEffort = sourceOf(session) === target ? session.usage?.effort : undefined;
  const efforts: ValuePick[] = [
    { label: '$(settings-gear) Default', description: settings },
    ...EFFORTS.map((e) => ({ label: e, description: e === sessionEffort ? usedHere : undefined, value: e })),
  ];
  const effort = await vscode.window.showQuickPick(efforts, { title: `${title} (3/3): effort`, placeHolder: 'Effort level for the new session' });
  if (!effort) {
    return undefined;
  }
  return { model: modelValue, effort: effort.value };
}

interface SessionPick extends vscode.QuickPickItem {
  session: SessionInfo;
}

function toTokens(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((t): t is string => typeof t === 'string' && !!t) : [];
}


function toPicks(sessions: SessionInfo[]): SessionPick[] {
  return sessions.map((s) => ({
    label: s.title,
    description: [isClaude(s) ? '' : SOURCES[sourceOf(s)].short, projectName(projectPath(s)), formatRelative(sortTime(s))].filter(Boolean).join(' · '),
    detail: [s.firstPrompt, s.lastPrompt !== s.firstPrompt ? s.lastPrompt : undefined]
      .filter(Boolean)
      .map((p) => p!.replace(/\s+/g, ' ').slice(0, 200))
      .join('  ⋯  '),
    session: s,
  }));
}

async function pickSession(model: SessionModel, filter?: (s: SessionInfo) => boolean): Promise<SessionInfo | undefined> {
  if (!model.allSessions.length) {
    await model.reload();
  }
  const sessions = model.visibleSessions();
  const picked = await vscode.window.showQuickPick(toPicks(filter ? sessions.filter(filter) : sessions), {
    placeHolder: filter ? 'Select a Claude Code session' : 'Select a session',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return picked?.session;
}

const RESUME_BUTTON: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('play'), tooltip: 'Resume in terminal' };

async function searchSessions(model: SessionModel): Promise<void> {
  if (!model.allSessions.length) {
    await model.reload();
  }
  const qp = vscode.window.createQuickPick<SessionPick>();
  qp.placeholder = 'Search sessions and transcripts ("exact phrase", -exclude, a OR b, source:copilot) — Enter opens the transcript';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  const basePicks = toPicks(model.visibleSessions()).map((p) => ({ ...p, buttons: [RESUME_BUTTON] }));
  const byKey = new Map(basePicks.map((p) => [sessionKey(p.session), p]));
  qp.items = basePicks;
  // The quick pick's own fuzzy filter knows neither the query syntax nor the transcripts, so while searching the
  // list holds only our matches, all marked alwaysShow so the built-in filter leaves them alone. Sessions found
  // via their transcript show the matching passage in place of their prompts.
  qp.onDidChangeValue((value) => {
    const q = parseQuery(value);
    if (isEmptyQuery(q)) {
      qp.items = basePicks;
      return;
    }
    qp.items = model
      .search(q, (s) => {
        const p = byKey.get(sessionKey(s));
        return p ? [p.label, p.description, p.detail].join('\0') : '';
      })
      .flatMap((hit) => {
        const p = byKey.get(sessionKey(hit.session));
        return p ? [{ ...p, alwaysShow: true, detail: hit.snippet ? `$(quote) ${hit.snippet}` : p.detail }] : [];
      });
  });
  qp.onDidTriggerItemButton((e) => {
    qp.hide();
    vscode.commands.executeCommand('claudeSessions.resume', e.item.session);
  });
  qp.onDidAccept(() => {
    const item = qp.selectedItems[0];
    const highlight = parseQuery(qp.value).highlight;
    qp.hide();
    if (item) {
      vscode.commands.executeCommand('claudeSessions.openTranscript', item.session, highlight);
    }
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}

export function deactivate(): void {}

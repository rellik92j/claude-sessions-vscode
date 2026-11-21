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
import { defaultCopilotDir, defaultProjectsDir, defaultVsCodeUserDirs, SessionStore, SourceRoots, sortTime, writeCustomTitle } from './sessionStore';
import { canResumeIn, CONTINUE_TARGETS, ContinueTarget, isClaude, sessionKey, SOURCE_IDS, SOURCES, sourceOf, toSources } from './sources';
import { parseTranscriptFor } from './transcripts';
import { OverviewPanel } from './overviewPanel';
import { SidebarView } from './sidebarView';
import { registerGitContentProvider, TranscriptPanels } from './transcriptPanel';

const CONFIG = 'claudeSessions';
const CLAUDE_CODE_EXTENSION = 'anthropic.claude-code';
/** A session written to this recently counts as active (matches the sidebar's live dot). */
const LIVE_MS = 3 * 60 * 1000;

function config() {
  return vscode.workspace.getConfiguration(CONFIG);
}

function isUri(x: unknown): x is vscode.Uri {
  return !!x && typeof (x as vscode.Uri).fsPath === 'string';
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
  // The tool last chosen in a transcript's message box, per kind of session; it is where the next message goes.
  const composerKey = (s: SessionSource) => `composerTarget.${s}`;
  const composerTarget = (s: SessionSource) => context.globalState?.get<ContinueTarget>(composerKey(s));
  const transcripts = new TranscriptPanels(context.extensionUri, hasClaudeCode, model, composerTarget);
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
      if (e.affectsConfiguration(`${CONFIG}.transcriptLineWidth`)) {
        transcripts.applyLineWidth();
      }
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

  /**
   * Opens a VS Code chat in this window when it belongs here; otherwise offers its folder's window.
   * True when the chat opened in this window.
   */
  const openChat = async (session: SessionInfo): Promise<boolean> => {
    // Chats live in workspaceStorage/<hash>/chatSessions/; this extension's own storage sits in the same <hash> folder.
    const chatWorkspace = path.basename(path.dirname(path.dirname(session.filePath)));
    const thisWorkspace = context.storageUri && path.basename(path.dirname(context.storageUri.fsPath));
    if (chatWorkspace === thisWorkspace) {
      try {
        await vscode.commands.executeCommand('vscode.open', chatSessionUri(session.id));
        return true;
      } catch {
        // Fall through to the chat view.
      }
      await vscode.commands.executeCommand('workbench.action.chat.open');
      vscode.window.showInformationMessage(`Couldn't open the chat directly. Find "${session.title}" in the chat history.`);
      return false;
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
    return false;
  };

  /**
   * Resumes the session in its own tool. This and the other actions below resolve to true once the session (or its
   * continuation) has opened, so the transcript it was started from can close; false when cancelled or refused.
   */
  const resume = async (session: SessionInfo, message?: string): Promise<boolean> => {
    if (sourceOf(session) === 'vscode-chat') {
      return openChat(session);
    }
    const key = sessionKey(session);
    const existing = sessionTerminals.get(key);
    if (existing && existing.exitStatus === undefined) {
      existing.show();
      if (message) {
        // Typing into a running CLI would send a multi-line message a line at a time, so it is handed over instead.
        await vscode.env.clipboard.writeText(message);
        vscode.window.showInformationMessage('This session is already open in a terminal. Your message is on the clipboard: paste it there.');
      }
      return true;
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
    return true;
  };

  /**
   * Resumes a CLI session with `message` as its next prompt, sent at once. Claude Code runs as the terminal's own
   * process so the message arrives as one argument, as in continueInNewSession; Copilot CLI is often a shell shim
   * (see continueInCopilot), so a message that won't survive shell quoting goes in a file its prompt points at.
   */
  const resumeWithMessage = async (session: SessionInfo, message: string, overrides: Overrides): Promise<boolean> => {
    const key = sessionKey(session);
    const existing = sessionTerminals.get(key);
    if (existing && existing.exitStatus === undefined) {
      return resume(session, message);
    }
    const tool = SOURCES[sourceOf(session)].label;
    const cwd = projectPath(session);
    const hasCwd = !!cwd && existsSync(cwd);
    if (!hasCwd) {
      vscode.window.showWarningMessage(
        `The session's folder no longer exists (${cwd || 'unknown'}). ${tool} looks sessions up by folder, so resuming may fail.`,
      );
    }
    const name = `${tool} · ${session.title.slice(0, 40)}`;
    let terminal: vscode.Terminal;
    if (isClaude(session)) {
      const [shellPath, ...shellArgs] = claudeCommandParts();
      terminal = vscode.window.createTerminal({
        ...claudeTerminalOptions(name, hasCwd ? cwd : undefined),
        shellPath,
        shellArgs: [
          ...shellArgs,
          '--resume',
          session.id,
          ...(overrides.model ? ['--model', overrides.model] : []),
          ...(overrides.effort ? ['--effort', overrides.effort] : []),
          message,
        ],
      });
    } else {
      const quote = (s: string) => `"${s}"`;
      let prompt = message;
      const extra: string[] = [];
      if (/["\r\n%`$]/.test(message) || message.length > 500) {
        const dir = path.join(os.tmpdir(), 'claude-sessions-handoffs');
        const file = path.join(dir, `message-${Date.now()}.md`);
        try {
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(file, message, 'utf8');
        } catch (err) {
          vscode.window.showErrorMessage(`Could not write the message: ${(err as Error).message}`);
          return false;
        }
        extra.push('--add-dir', quote(dir));
        prompt = `My next message is in ${file}. Read it and do what it asks.`;
      }
      const command = config().get<string>('copilotCommand', 'copilot') || 'copilot';
      const args = [
        '--resume',
        session.id,
        ...extra,
        ...(overrides.model ? ['--model', quote(overrides.model)] : []),
        ...(overrides.effort ? ['--reasoning-effort', overrides.effort] : []),
        '-i',
        quote(prompt),
      ];
      terminal = vscode.window.createTerminal(
        claudeTerminalOptions(name, hasCwd ? cwd : undefined, new vscode.ThemeIcon(SOURCES['copilot-cli'].icon)),
      );
      terminal.sendText(`${command} ${args.join(' ')}`);
    }
    sessionTerminals.set(key, terminal);
    terminal.show();
    return true;
  };

  /**
   * Sends what was typed in a transcript's message box: as the next prompt of this same session where its tool can
   * take one, otherwise as the request at the end of a handoff to a new session in `target`. The CLIs send it at once,
   * as does VS Code Chat; the Claude Code chat can only place it in its input box. `pickModel` asks for a model and
   * effort first (CLIs only). Resolves to true once it has gone, so the transcript can close.
   */
  const sendMessage = async (
    session: SessionInfo,
    text: string,
    target: ContinueTarget,
    mode: 'same' | 'handoff',
    pickModel = false,
  ): Promise<boolean> => {
    const own = sourceOf(session);
    if (!CONTINUE_TARGETS.includes(target) || !text.trim()) {
      return false;
    }
    if (target === 'claude-chat' && !hasClaudeCode()) {
      vscode.window.showErrorMessage('The Claude Code extension (anthropic.claude-code) is not installed.');
      return false;
    }
    let overrides: Overrides = {};
    if (pickModel && target !== 'vscode-chat' && target !== 'claude-chat') {
      const picked = await pickOverrides(session, target, 'Send');
      if (!picked) {
        return false;
      }
      overrides = picked;
    }
    await context.globalState?.update(composerKey(own), target);
    if (mode === 'same' && canResumeIn(own, target)) {
      return target === 'claude-chat' ? openInClaudeCode(session, text) : resumeWithMessage(session, text, overrides);
    }
    return continueInNewSession(session, overrides, target, text);
  };

  /**
   * Starts a new session in `target` (by default the session's own tool) whose first prompt is a handoff of where this
   * one left off. `overrides` (model, effort) apply to the CLIs; the chats (VS Code Chat, the Claude Code extension's
   * chat) use their own model pickers.
   */
  const continueInNewSession = async (
    session: SessionInfo,
    overrides: Overrides = {},
    target: ContinueTarget = sourceOf(session),
    request?: string,
  ): Promise<boolean> => {
    if (target === 'claude-chat' && !hasClaudeCode()) {
      vscode.window.showErrorMessage('The Claude Code extension (anthropic.claude-code) is not installed.');
      return false;
    }
    const cwd = projectPath(session);
    const hasCwd = !!cwd && existsSync(cwd);
    if (!hasCwd && target !== 'vscode-chat' && target !== 'claude-chat') {
      vscode.window.showWarningMessage(`The session's folder no longer exists (${cwd || 'unknown'}). The new session starts in the default folder.`);
    }
    let log: string;
    try {
      log = await fs.readFile(session.filePath, 'utf8');
    } catch (err) {
      vscode.window.showErrorMessage(`Could not read session log: ${(err as Error).message}`);
      return false;
    }
    const facts = isClaude(session) ? collectHandoffFacts(log) : collectTranscriptFacts(parseTranscriptFor(session, log), cwd || undefined);
    // A handoff saved to a scratchpad may since have been cleaned up.
    facts.handoffNotes = facts.handoffNotes?.filter((n) => /^https?:/.test(n) || statSync(n, { throwIfNoEntry: false })?.isFile());
    // The Claude Code chat is the same assistant as its CLI, so it gets the same handoff.
    const tool: SessionSource = target === 'claude-chat' ? 'claude' : target;
    const handoff = buildHandoff(session, facts, cwd || undefined, hasCwd ? await gitStatus(cwd) : undefined, tool, request);
    // Continuing a continued session keeps one "Continued: " rather than stacking them.
    const title = session.title.replace(/^(Continued: )+/, '');
    if (target === 'vscode-chat') {
      return continueInChat(session, handoff, !!request);
    }
    if (target === 'claude-chat') {
      return continueInClaudeChat(session, handoff);
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
    return true;
  };

  /**
   * Copilot CLI is often a .bat or .ps1 shim on Windows, which would split a multi-line argument, so the handoff goes
   * in a file the CLI is given access to, and the one-line prompt typed into the shell points at it.
   */
  const continueInCopilot = async (handoff: string, title: string, cwd: string | undefined, overrides: Overrides): Promise<boolean> => {
    const dir = path.join(os.tmpdir(), 'claude-sessions-handoffs');
    const file = path.join(dir, `handoff-${Date.now()}.md`);
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file, handoff, 'utf8');
    } catch (err) {
      vscode.window.showErrorMessage(`Could not write the handoff: ${(err as Error).message}`);
      return false;
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
    return true;
  };

  /**
   * A new VS Code chat in agent mode with the handoff in its input box, for you to review, pick a model and send; or,
   * with `send` (the handoff ends with a request from the message box), sent straight away.
   */
  const continueInChat = async (session: SessionInfo, handoff: string, send = false): Promise<boolean> => {
    await vscode.commands.executeCommand('workbench.action.chat.newChat');
    await vscode.commands.executeCommand('workbench.action.chat.open', { mode: 'agent', query: handoff, isPartialQuery: !send });
    const cwd = projectPath(session);
    if (cwd && !workspaceFolderPaths().some((f) => isInside(cwd, f))) {
      vscode.window.showInformationMessage(
        `The handoff is in a new chat. That chat works in this window's folder, not in ${cwd}, where the session ran.`,
      );
    }
    return true;
  };

  /**
   * A new Claude Code chat (the Claude Code extension's tab, not its CLI) with the handoff in its input box, for you to
   * review and send. The extension's open command takes a prompt as its second argument and types it in unsent.
   */
  const continueInClaudeChat = async (session: SessionInfo, handoff: string): Promise<boolean> => {
    try {
      await vscode.commands.executeCommand('claude-vscode.editor.open', undefined, handoff);
    } catch (err) {
      vscode.window.showErrorMessage(`Could not open a Claude Code chat: ${(err as Error).message}`);
      return false;
    }
    const cwd = projectPath(session);
    if (cwd && !workspaceFolderPaths().some((f) => isInside(cwd, f))) {
      vscode.window.showInformationMessage(
        `The handoff is in a new Claude Code chat. That chat works in this window's folder, not in ${cwd}, where the session ran.`,
      );
    }
    return true;
  };

  /** Opens the session in the Claude Code chat; `message` goes in its input box (the extension doesn't send it). */
  const openInClaudeCode = async (session: SessionInfo, message?: string): Promise<boolean> => {
    if (!vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION)) {
      vscode.window.showErrorMessage('The Claude Code extension (anthropic.claude-code) is not installed.');
      return false;
    }
    const folders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
    if (!folders.some((f) => isInside(projectPath(session), f))) {
      const choice = await vscode.window.showWarningMessage(
        `This session was started in ${projectPath(session)}, which isn't open in this window. The Claude Code chat may not find it.`,
        'Resume in Terminal Instead',
        'Try Anyway',
      );
      if (choice === 'Resume in Terminal Instead') {
        return message ? resumeWithMessage(session, message, {}) : resume(session);
      }
      if (choice !== 'Try Anyway') {
        return false;
      }
    }
    await vscode.commands.executeCommand('claude-vscode.editor.open', session.id, message);
    return true;
  };

  /** Asks for a new name and writes it to the log. Resolves to true once renamed and the list reloaded. */
  const rename = async (session: SessionInfo): Promise<boolean> => {
    const name = await vscode.window.showInputBox({
      title: 'Rename Session',
      prompt: 'New name for this Claude Code session',
      value: session.titleSource === 'custom' || session.titleSource === 'ai' ? session.title : '',
      valueSelection: [0, session.title.length],
      placeHolder: session.title,
      validateInput: (v) => (v.trim() ? undefined : 'Enter a name'),
    });
    if (!name?.trim() || name.trim() === session.title) {
      return false;
    }
    try {
      await writeCustomTitle(session.filePath, session.id, name);
    } catch (err) {
      vscode.window.showErrorMessage(`Could not rename the session: ${(err as Error).message}`);
      return false;
    }
    await model.reload();
    // A running Claude Code keeps its own copy of the name and writes it back to the log now and then.
    if (Date.now() - sortTime(session) < LIVE_MS) {
      vscode.window.showWarningMessage(
        'Renamed. This session looks active: if Claude Code still has it open, it may write its old name back. Use /rename inside that session to make it stick.',
      );
    } else {
      vscode.window.setStatusBarMessage(`Renamed session to “${name.trim()}”`, 3000);
    }
    return true;
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
    // Puts a query (such as skill:ship-change) in the sidebar's search box; used by the transcript's side panel.
    vscode.commands.registerCommand('claudeSessions.searchFor', (query: unknown) =>
      typeof query === 'string' ? sidebar.searchFor(query) : sidebar.focusSearch(),
    ),
    registerGitContentProvider(),
    vscode.commands.registerCommand('claudeSessions.searchForFile', (uri?: unknown) => {
      // From the Explorer or a tab's context menu the file comes as an argument; from the palette, the active editor.
      const target = isUri(uri) ? uri : vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        return;
      }
      // The file name alone: transcripts mention a file by absolute path in tool calls and by bare name in prose.
      const name = path.basename(target.fsPath);
      return sidebar.searchFor(/\s/.test(name) ? `"${name}"` : name);
    }),
    vscode.commands.registerCommand('claudeSessions.openOverview', () => overview.show()),
    vscode.commands.registerCommand('claudeSessions.search', () => searchSessions(model)),
    vscode.commands.registerCommand('claudeSessions.groupByProject', () => setConfig('groupBy', 'project')),
    vscode.commands.registerCommand('claudeSessions.groupByDate', () => setConfig('groupBy', 'date')),
    vscode.commands.registerCommand('claudeSessions.showCurrentWorkspaceOnly', () => setConfig('currentWorkspaceOnly', true)),
    vscode.commands.registerCommand('claudeSessions.showAll', () => setConfig('currentWorkspaceOnly', false)),
    vscode.commands.registerCommand('claudeSessions.resume', withSession((s) => resume(s))),
    // From a transcript's message box: (session, text, target, mode, pickModel). Not in the command palette.
    vscode.commands.registerCommand('claudeSessions.sendMessage', (arg: unknown, text: unknown, target: unknown, mode: unknown, pickModel: unknown) => {
      const s = toSession(arg);
      return !!s && typeof text === 'string' && sendMessage(s, text, target as ContinueTarget, mode === 'same' ? 'same' : 'handoff', pickModel === true);
    }),
    vscode.commands.registerCommand('claudeSessions.continueInNewSession', withSession((s) => continueInNewSession(s))),
    vscode.commands.registerCommand(
      'claudeSessions.continueInNewSessionWithModel',
      withSession(async (s) => {
        const choice = await pickContinuation(s);
        return !!choice && continueInNewSession(s, choice.overrides, choice.target);
      }),
    ),
    vscode.commands.registerCommand('claudeSessions.openInClaudeCode', withClaudeSession('Open in Claude Code Chat', openInClaudeCode)),
    vscode.commands.registerCommand('claudeSessions.rename', withClaudeSession('Rename', rename)),
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

/** Where a session can continue: a tool whose sessions are listed, or the Claude Code extension's chat. */


/** CLI flags for a new session; undefined fields keep the user's Claude Code settings. */
interface Overrides {
  model?: string;
  effort?: string;
}

interface ValuePick<T extends string = string> extends vscode.QuickPickItem {
  value?: T;
}

const OTHER_MODEL = '\0other';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const IN_INPUT_BOX = 'with the handoff in the input box, to send when you are ready';

/**
 * Asks which tool the new session runs in, then (for a CLI) its model and effort. Undefined when any step is cancelled.
 * The chats have their own model pickers, so they take no overrides. The Claude Code chat is offered, next to its CLI,
 * when the Claude Code extension is installed.
 */
async function pickContinuation(session: SessionInfo): Promise<{ target: ContinueTarget; overrides: Overrides } | undefined> {
  const title = 'Continue in New Session';
  const own = sourceOf(session);
  const claudeChat = !!vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION);
  const tools = [own, ...SOURCE_IDS.filter((id) => id !== own)].flatMap((id): ValuePick<ContinueTarget>[] => {
    const pick: ValuePick<ContinueTarget> = {
      label: `$(${id === 'claude' ? 'sparkle' : SOURCES[id].icon}) ${id === 'claude' && claudeChat ? 'Claude Code CLI' : SOURCES[id].label}`,
      description: id === own ? 'same as this session' : undefined,
      detail: id === 'vscode-chat' ? `A new chat ${IN_INPUT_BOX}` : id === 'claude' && claudeChat ? 'In a terminal' : undefined,
      value: id,
    };
    if (id !== 'claude' || !claudeChat) {
      return [pick];
    }
    return [
      pick,
      {
        label: '$(comment-discussion) Claude Code Chat',
        description: 'VS Code extension',
        detail: `A new Claude Code tab ${IN_INPUT_BOX}`,
        value: 'claude-chat',
      },
    ];
  });
  const tool = await vscode.window.showQuickPick(tools, { title: `${title} (1/3): tool`, placeHolder: 'Where the new session runs' });
  if (!tool?.value) {
    return undefined;
  }
  const target = tool.value;
  if (target === 'vscode-chat' || target === 'claude-chat') {
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
  qp.placeholder = 'Search sessions and transcripts ("exact phrase", -exclude, a OR b, source:copilot, file:a.ts, skill:x, has:commits) — Enter opens the transcript';
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

import { existsSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { formatRelative, isInside } from './format';
import { GroupBy, projectPath, SessionModel } from './model';
import { SessionInfo } from './sessionParser';
import { defaultProjectsDir, SessionStore, sortTime } from './sessionStore';
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

const hasClaudeCode = () => !!vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION);

export function activate(context: vscode.ExtensionContext): void {
  const store = new SessionStore(projectsDir());
  const model = new SessionModel(store);
  const transcripts = new TranscriptPanels(context.extensionUri, hasClaudeCode);

  /**
   * Commands receive a SessionInfo (from the transcript page or quick pick), a webview context
   * object with a sessionId (right-click in the sidebar), or nothing (command palette).
   */
  const toSession = (arg: unknown): SessionInfo | undefined => {
    if (arg && typeof arg === 'object') {
      if ('filePath' in arg && 'id' in arg) {
        return arg as SessionInfo;
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
  const updateClaudeCodeContext = () =>
    vscode.commands.executeCommand('setContext', 'claudeSessions.hasClaudeCode', hasClaudeCode());
  updateClaudeCodeContext();
  applyConfig();

  // File watching: re-parse only the logs that changed, debounced because active sessions write constantly.
  let watcher: vscode.FileSystemWatcher | undefined;
  let debounce: NodeJS.Timeout | undefined;
  const scheduleReload = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => model.reload(), 1500);
  };
  const watch = () => {
    watcher?.dispose();
    watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(store.projectsDir), '*/*.jsonl'),
    );
    watcher.onDidCreate(scheduleReload);
    watcher.onDidChange(scheduleReload);
    watcher.onDidDelete(scheduleReload);
  };
  watch();

  context.subscriptions.push(
    { dispose: () => watcher?.dispose() },
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
      if (e.affectsConfiguration(`${CONFIG}.projectsDir`)) {
        store.setProjectsDir(projectsDir());
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

  const resume = (session: SessionInfo) => {
    const existing = sessionTerminals.get(session.id);
    if (existing && existing.exitStatus === undefined) {
      existing.show();
      return;
    }
    const cwd = projectPath(session);
    const hasCwd = existsSync(cwd);
    if (!hasCwd) {
      vscode.window.showWarningMessage(
        `The session's folder no longer exists (${cwd}). Claude Code looks sessions up by folder, so resuming may fail.`,
      );
    }
    const command = config().get<string>('claudeCommand', 'claude') || 'claude';
    // Match the Claude Code extension's "Open in Terminal": a terminal tab in the editor area with the Claude logo.
    const inEditor = config().get<string>('terminalLocation', 'editor') === 'editor';
    const claudeCode = vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION);
    const terminal = vscode.window.createTerminal({
      name: `Claude Code · ${session.title.slice(0, 40)}`,
      cwd: hasCwd ? cwd : undefined,
      iconPath: claudeCode
        ? vscode.Uri.joinPath(claudeCode.extensionUri, 'resources', 'claude-logo.svg')
        : new vscode.ThemeIcon('comment-discussion'),
      location: inEditor ? { viewColumn: vscode.ViewColumn.Beside } : vscode.TerminalLocation.Panel,
    });
    sessionTerminals.set(session.id, terminal);
    terminal.show();
    terminal.sendText(`${command} --resume ${session.id}`);
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

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSessions.refresh', () => model.reload()),
    vscode.commands.registerCommand('claudeSessions.focusSearch', () => sidebar.focusSearch()),
    vscode.commands.registerCommand('claudeSessions.search', () => searchSessions(model)),
    vscode.commands.registerCommand('claudeSessions.groupByProject', () => setConfig('groupBy', 'project')),
    vscode.commands.registerCommand('claudeSessions.groupByDate', () => setConfig('groupBy', 'date')),
    vscode.commands.registerCommand('claudeSessions.showCurrentWorkspaceOnly', () => setConfig('currentWorkspaceOnly', true)),
    vscode.commands.registerCommand('claudeSessions.showAll', () => setConfig('currentWorkspaceOnly', false)),
    vscode.commands.registerCommand('claudeSessions.resume', withSession(resume)),
    vscode.commands.registerCommand('claudeSessions.openInClaudeCode', withSession(openInClaudeCode)),
    vscode.commands.registerCommand('claudeSessions.openTranscript', withSession((s) => transcripts.open(s))),
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
        const command = config().get<string>('claudeCommand', 'claude') || 'claude';
        const cwd = projectPath(s);
        await vscode.env.clipboard.writeText(`cd "${cwd}" && ${command} --resume ${s.id}`);
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

interface SessionPick extends vscode.QuickPickItem {
  session: SessionInfo;
}

function toPicks(sessions: SessionInfo[]): SessionPick[] {
  return sessions.map((s) => ({
    label: s.title,
    description: `${path.basename(projectPath(s))} · ${formatRelative(sortTime(s))}`,
    detail: [s.firstPrompt, s.lastPrompt !== s.firstPrompt ? s.lastPrompt : undefined]
      .filter(Boolean)
      .map((p) => p!.replace(/\s+/g, ' ').slice(0, 200))
      .join('  ⋯  '),
    session: s,
  }));
}

async function pickSession(model: SessionModel): Promise<SessionInfo | undefined> {
  if (!model.allSessions.length) {
    await model.reload();
  }
  const picked = await vscode.window.showQuickPick(toPicks(model.visibleSessions()), {
    placeHolder: 'Select a Claude Code session',
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
  qp.placeholder = 'Search sessions by title, project, or prompt — Enter opens the transcript';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.items = toPicks(model.visibleSessions()).map((p) => ({ ...p, buttons: [RESUME_BUTTON] }));
  qp.onDidTriggerItemButton((e) => {
    qp.hide();
    vscode.commands.executeCommand('claudeSessions.resume', e.item.session);
  });
  qp.onDidAccept(() => {
    const item = qp.selectedItems[0];
    qp.hide();
    if (item) {
      vscode.commands.executeCommand('claudeSessions.openTranscript', item.session);
    }
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}

export function deactivate(): void {}

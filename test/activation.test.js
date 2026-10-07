// Loads the bundled extension (dist/extension.js) against a fake VS Code API and drives the sidebar and
// transcript webviews. Catches packaging problems such as a dependency failing to load at activation.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

function fakeVscode(state) {
  class EventEmitter {
    constructor() {
      this.listeners = [];
      this.event = (f) => (this.listeners.push(f), { dispose() {} });
    }
    fire(x) {
      this.listeners.forEach((f) => f(x));
    }
  }
  const disposable = { dispose() {} };
  const uri = (p) => ({ fsPath: p, toString: () => 'file://' + p });
  const webview = (posted) => ({
    cspSource: 'vscode-webview:',
    options: {},
    html: '',
    asWebviewUri: (u) => uri(u.fsPath),
    onDidReceiveMessage: (f) => ((webview.handler = f), disposable),
    postMessage: async (m) => posted.push(m),
  });
  return {
    EventEmitter,
    Uri: { file: uri, joinPath: (b, ...p) => uri(path.join(b.fsPath, ...p)), parse: uri },
    ThemeIcon: class {
      constructor(id) {
        this.id = id;
      }
    },
    RelativePattern: class {},
    ViewColumn: { Active: -1, Beside: -2 },
    TerminalLocation: { Panel: 1 },
    ConfigurationTarget: { Global: 1 },
    extensions: { getExtension: () => undefined, onDidChange: () => disposable },
    env: { clipboard: { writeText: async () => {} }, openExternal: async () => {} },
    workspace: {
      workspaceFolders: [],
      // Every source reads from temp folders (state.config), never from this machine's real sessions.
      getConfiguration: () => ({
        get: (k, d) => (k === 'projectsDir' ? state.projectsDir : k in (state.config ?? {}) ? state.config[k] : d),
        update: async () => {},
      }),
      createFileSystemWatcher: () => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {}, dispose() {} }),
      onDidChangeConfiguration: () => disposable,
      onDidChangeWorkspaceFolders: () => disposable,
    },
    window: {
      registerWebviewViewProvider: (id, provider) => ((state.providers[id] = provider), disposable),
      createWebviewPanel: () => {
        const panel = { webview: webview(state.panelPosts), reveal() {}, title: '' };
        panel.onDidDispose = (f) => ((panel.dispose = f), disposable);
        panel.webview.onDidReceiveMessage = (f) => ((panel.onMessage = f), disposable);
        state.panels.push(panel);
        return panel;
      },
      onDidCloseTerminal: () => disposable,
      createTerminal: (options) => (state.terminals.push(options), { show() {}, sendText(t) { options.sent = t; } }),
      showErrorMessage: (m) => state.errors.push(m),
      showWarningMessage: async () => undefined,
      showInformationMessage: async (m) => (state.infos?.push(m), undefined),
      setStatusBarMessage() {},
      // Tests answer quick picks by setting state.pick to a function of the items and options.
      showQuickPick: async (items, options) => state.pick?.(items, options),
      showInputBox: async () => undefined,
    },
    commands: {
      registerCommand: (id, f) => ((state.commands[id] = f), disposable),
      executeCommand: async (id, ...args) => state.commands[id]?.(...args),
    },
    _webview: webview,
  };
}

function writeSession(dir, id, lines) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

test('bundled extension activates, fills the sidebar, and renders a transcript', async () => {
  // EXT_DIR lets this run against an unpacked .vsix to check what actually ships.
  const extDir = process.env.EXT_DIR || path.join(__dirname, '..');
  const bundle = path.join(extDir, 'dist', 'extension.js');
  assert.ok(fs.existsSync(bundle), 'run `npm run bundle` first');

  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-'));
  const ts = new Date().toISOString();
  writeSession(path.join(projectsDir, 'C--repo'), 'aaaa-1111', [
    { type: 'user', message: { content: 'Add a **dark mode** toggle' }, cwd: 'C:\\repo', gitBranch: 'main', timestamp: ts },
    {
      type: 'assistant',
      message: {
        id: 'm1',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: 'Done:\n\n```ts\nconst x = 1;\n```' }],
        usage: { input_tokens: 10, cache_creation_input_tokens: 20000, cache_creation: { ephemeral_1h_input_tokens: 20000 }, cache_read_input_tokens: 0, output_tokens: 500 },
      },
      effort: 'high',
      timestamp: ts,
    },
    { type: 'ai-title', aiTitle: 'Dark mode toggle' },
  ]);

  const noSources = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-none-'));
  const state = {
    projectsDir,
    config: { copilotDir: noSources, vscodeUserDir: noSources },
    providers: {},
    commands: {},
    panels: [],
    panelPosts: [],
    errors: [],
    terminals: [],
  };
  const vscode = fakeVscode(state);
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, ...rest);
  };
  try {
    delete require.cache[bundle];
    const ext = require(bundle);
    ext.activate({ subscriptions: [], extensionUri: vscode.Uri.file(extDir) });

    const provider = state.providers['claudeSessions.list'];
    assert.ok(provider, 'sidebar webview provider registered');

    const posted = [];
    let handler;
    const view = {
      visible: true,
      webview: { ...vscode._webview(posted), onDidReceiveMessage: (f) => ((handler = f), { dispose() {} }) },
      onDidChangeVisibility: () => ({ dispose() {} }),
      onDidDispose: () => ({ dispose() {} }),
      show() {},
    };
    provider.resolveWebviewView(view);
    assert.match(view.webview.html, /sidebar\.js/);
    assert.match(view.webview.html, /codicon\.css/);

    handler({ type: 'ready' });
    await new Promise((r) => setTimeout(r, 300));
    const msg = posted.filter((m) => m.type === 'state').pop();
    assert.ok(msg, 'state posted to sidebar');
    assert.equal(msg.loaded, true);
    assert.equal(msg.total, 1);
    assert.equal(msg.groups[0].sessions[0].title, 'Dark mode toggle');

    await state.commands['claudeSessions.openTranscript']({ sessionId: 'aaaa-1111' });
    const html = state.panels[0]?.webview.html ?? '';
    assert.match(html, /<strong>dark mode<\/strong>/);
    assert.match(html, /hljs-keyword/);
    assert.doesNotMatch(html, /data-highlight/);
    // Usage stats: context, a warm 1-hour cache, cost (10 input at $4, 20k 1h writes at $8 and 500 output at $20 per MTok = $0.17).
    assert.match(html, /claude-opus-5-5 · high/);
    assert.match(html, /20k<span> \/ 1M<\/span>/);
    assert.match(html, /class="stat cache" data-expires="\d+"/);
    assert.match(html, /<div class="stat-value">\$0\.17<\/div>/);
    // The same stats, compact, in the sticky top bar, with a second tool-call switch.
    assert.match(html, /<div class="topbar-stats"><button class="strip-stats" id="to-top"[^>]*>.*claude-opus-5-5 · high.*20k \/ 1M · 2%.*\$0\.17/);
    assert.equal(html.match(/data-tools-toggle/g)?.length ?? 0, 0, 'no tool calls in this session, so no switches');
    const card = msg.groups[0].sessions[0];
    assert.ok(Math.abs(card.cost - 0.17004) < 1e-6);
    assert.ok(card.cacheExpires > Date.now());

    // Search: the sidebar sends the query, the host answers with matching ids, snippets and highlight words.
    const search = (query) => {
      handler({ type: 'search', query });
      return posted.filter((m) => m.type === 'searchResults').pop();
    };
    let results = search('"x = 1" toggle');
    assert.equal(results.query, '"x = 1" toggle');
    // Results are session keys, which stay unique across sources.
    assert.deepEqual(results.ids, ['claude:aaaa-1111']);
    assert.deepEqual(results.highlight, ['x = 1', 'toggle']);
    assert.match(results.snippets['claude:aaaa-1111'], /x = 1/);
    // Matched on the card alone: no snippet.
    results = search('dark OR nothing');
    assert.deepEqual(results.ids, ['claude:aaaa-1111']);
    assert.deepEqual(results.snippets, {});
    assert.deepEqual(search('"toggle dark"').ids, []);
    assert.deepEqual(search('toggle -const').ids, []);

    // Opening from a search passes the words on to the transcript page.
    handler({ type: 'run', command: 'openTranscript', id: 'aaaa-1111', highlight: ['const', 42] });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(state.panels.length, 1, 'existing panel reused');
    assert.match(state.panels[0].webview.html, /<body data-highlight="\[&quot;const&quot;\]">/);
    assert.deepEqual(state.errors, []);

    // Transcripts share one preview tab until kept open (Keep open button, or keepOpen from a double-click).
    const open = (id, ...args) =>
      state.commands['claudeSessions.openTranscript']({ ...sessionA, id, title: `Session ${id}` }, ...args);
    const sessionA = { id: 'aaaa-1111', filePath: path.join(projectsDir, 'C--repo', 'aaaa-1111.jsonl'), projectDir: 'C--repo', promptCount: 1 };
    const keepButton = /data-cmd="keepOpen"/;
    assert.match(state.panels[0].webview.html, keepButton, 'first tab is the preview');
    await open('bbbb');
    assert.equal(state.panels.length, 1, 'preview tab reused for another session');
    assert.equal(state.panels[0].title, 'Session bbbb');
    await state.panels[0].onMessage({ command: 'keepOpen' });
    await new Promise((r) => setTimeout(r, 50));
    assert.doesNotMatch(state.panels[0].webview.html, keepButton, 'kept tab drops the button');
    await open('cccc');
    assert.equal(state.panels.length, 2, 'next transcript gets a new preview tab');
    await open('bbbb');
    assert.equal(state.panels.length, 2, 'kept session is focused, not reopened');
    assert.equal(state.panels[1].title, 'Session cccc', 'preview untouched');
    await open('cccc', [], true);
    assert.equal(state.panels.length, 2, 'keepOpen on the previewed session promotes it');
    assert.doesNotMatch(state.panels[1].webview.html, keepButton);
    await state.commands['claudeSessions.openTranscriptInNewTab']({ ...sessionA, id: 'dddd', title: 'Session dddd' });
    await open('eeee');
    assert.equal(state.panels.length, 4);
    assert.doesNotMatch(state.panels[2].webview.html, keepButton, 'Open in New Tab keeps it open');
    assert.match(state.panels[3].webview.html, keepButton);
    state.panels[3].dispose();
    await open('ffff');
    assert.equal(state.panels.length, 5, 'closing the preview tab means a new one next time');
    assert.deepEqual(state.errors, []);

    // Continue in new session: the CLI is the terminal's process, with the handoff as one argument (no shell typing).
    await state.panels[0].onMessage({ command: 'continueInNewSession' });
    await new Promise((r) => setTimeout(r, 300));
    const t = state.terminals.pop();
    assert.ok(t, 'terminal created');
    assert.equal(t.shellPath, 'claude');
    assert.equal(t.sent, undefined, 'nothing typed into a shell');
    assert.deepEqual(t.shellArgs.slice(0, 2), ['--name', 'Continued: Session bbbb']);
    const handoff = t.shellArgs[2];
    assert.equal(t.shellArgs.length, 3);
    assert.match(handoff, /## My last request\nAdd a \*\*dark mode\*\* toggle/);
    assert.match(handoff, /## Your last reply\nDone:/);
    assert.match(handoff, /wait for my instruction\.$/);
    assert.deepEqual(state.errors, []);

    // With model: two quick picks, then --model and --effort ahead of the handoff.
    const titles = [];
    state.pick = (items, options) => {
      titles.push(options.title);
      return items.find((i) => i.value === ['claude', 'sonnet', 'xhigh'][titles.length - 1]);
    };
    await state.panels[0].onMessage({ command: 'continueInNewSessionWithModel' });
    await new Promise((r) => setTimeout(r, 300));
    const tm = state.terminals.pop();
    assert.equal(titles.length, 3, 'tool, model, effort');
    assert.deepEqual(tm.shellArgs.slice(0, 6), ['--model', 'sonnet', '--effort', 'xhigh', '--name', 'Continued: Session bbbb']);
    // Default for both adds no flags; cancelling starts nothing.
    state.pick = (items) => items[0];
    await state.panels[0].onMessage({ command: 'continueInNewSessionWithModel' });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(state.terminals.pop().shellArgs[0], '--name');
    state.pick = () => undefined;
    await state.panels[0].onMessage({ command: 'continueInNewSessionWithModel' });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(state.terminals.length, 0);
    // Continuing a continued session doesn't stack the prefix.
    await state.commands['claudeSessions.continueInNewSession']({ ...sessionA, title: 'Continued: Continued: Session aaaa' });
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(state.terminals.pop().shellArgs.slice(0, 2), ['--name', 'Continued: Session aaaa']);

    // Overview: one editor tab, filled when its page is ready, for the range the page asks for.
    await state.commands['claudeSessions.openOverview']();
    await state.commands['claudeSessions.openOverview']();
    const overview = state.panels[state.panels.length - 1];
    assert.equal(state.panels.length, 6, 'overview opened once');
    assert.match(overview.webview.html, /overview\.js/);
    state.panelPosts.length = 0;
    overview.onMessage({ type: 'ready', range: 7, scope: 'workspace' });
    const ov = state.panelPosts.filter((m) => m.type === 'state').pop();
    assert.ok(ov, 'state posted to overview');
    assert.equal(ov.scope, 'all', 'no folder open, so the workspace scope shows all projects');
    assert.equal(ov.hasWorkspace, false);
    assert.equal(ov.overview.range, 7);
    assert.equal(ov.overview.totals.sessions, 1);
    assert.ok(Math.abs(ov.overview.totals.cost - 0.17004) < 1e-6);
    assert.match(ov.overview.projects[0].name, /repo/);
    assert.deepEqual(ov.overview.models.map((m) => m.model), ['opus-5-5']);
    // Project filter: keys from allProjects; unknown ones are dropped.
    const repoKey = ov.overview.allProjects[0].key;
    overview.onMessage({ type: 'setFilters', range: 30, scope: 'pick', projects: [repoKey, 'nowhere'] });
    const filtered = state.panelPosts.filter((m) => m.type === 'state').pop();
    assert.equal(filtered.scope, 'pick');
    assert.equal(filtered.overview.range, 30);
    assert.deepEqual(filtered.overview.filter, [repoKey]);
    assert.equal(filtered.overview.totals.sessions, 1);
    // With a folder open, the workspace scope shows only sessions started inside it.
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(path.join(projectsDir, 'elsewhere')) }];
    overview.onMessage({ type: 'setFilters', range: 30, scope: 'workspace' });
    const ws = state.panelPosts.filter((m) => m.type === 'state').pop();
    assert.equal(ws.scope, 'workspace');
    assert.deepEqual(ws.workspaceKeys, []);
    assert.equal(ws.overview.totals.sessions, 0);
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file('C:\\repo') }];
    overview.onMessage({ type: 'setFilters', range: 30, scope: 'workspace' });
    assert.equal(state.panelPosts.filter((m) => m.type === 'state').pop().overview.totals.sessions, 1);
    vscode.workspace.workspaceFolders = [];

    // Assets referenced by the webviews must exist on disk.
    for (const f of ['media/sidebar.js', 'media/sidebar.css', 'media/transcript.js', 'media/transcript.css', 'media/overview.js', 'media/overview.css','node_modules/@vscode/codicons/dist/codicon.css', 'node_modules/@vscode/codicons/dist/codicon.ttf']) {
      assert.ok(fs.existsSync(path.join(extDir, f)), `${f} exists`);
    }
  } finally {
    Module._load = originalLoad;
    fs.rmSync(projectsDir, { recursive: true, force: true });
    fs.rmSync(noSources, { recursive: true, force: true });
  }
});

/** Activates the bundle against fake VS Code with the given state; returns the sidebar's posts and message handler. */
async function activateWithSidebar(state) {
  const extDir = process.env.EXT_DIR || path.join(__dirname, '..');
  const bundle = path.join(extDir, 'dist', 'extension.js');
  const vscode = fakeVscode(state);
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, ...rest);
  };
  try {
    delete require.cache[bundle];
    require(bundle).activate({ subscriptions: [], extensionUri: vscode.Uri.file(extDir) });
  } finally {
    Module._load = originalLoad;
  }
  const posted = [];
  let handler;
  state.providers['claudeSessions.list'].resolveWebviewView({
    visible: true,
    webview: { ...vscode._webview(posted), onDidReceiveMessage: (f) => ((handler = f), { dispose() {} }) },
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
    show() {},
  });
  handler({ type: 'ready' });
  await new Promise((r) => setTimeout(r, 300));
  return { vscode, posted, send: handler, last: (type) => posted.filter((m) => m.type === type).pop() };
}

test('Copilot CLI and VS Code Chat sessions: source chips, filters, search, transcripts and actions', async () => {
  const fixtures = path.join(__dirname, 'fixtures');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-sources-'));
  const projectsDir = path.join(root, 'claude');
  const copilotDir = path.join(root, 'copilot');
  const userDir = path.join(root, 'Code', 'User');
  try {
    // One Claude session whose id is also a Copilot session's id, to check keys keep them apart.
    const shared = 'b380c8e3-1729-4e04-a560-1517aa38fb97';
    writeSession(path.join(projectsDir, 'C--repo'), shared, [
      { type: 'user', message: { content: 'Fix the login race' }, cwd: 'C:\\repo', timestamp: new Date().toISOString() },
    ]);
    fs.cpSync(path.join(fixtures, 'copilot-cli'), path.join(copilotDir, 'session-state'), { recursive: true });
    const chats = path.join(userDir, 'workspaceStorage', 'abc123', 'chatSessions');
    fs.mkdirSync(chats, { recursive: true });
    fs.copyFileSync(path.join(fixtures, 'vscode-chat', '63869299-99f3-491c-89c4-bb361f7147f7.jsonl'), path.join(chats, '63869299-99f3-491c-89c4-bb361f7147f7.jsonl'));
    fs.writeFileSync(path.join(userDir, 'workspaceStorage', 'abc123', 'workspace.json'), JSON.stringify({ folder: 'file:///c%3A/work/site' }));
    // An empty chat in an empty window: hidden like any empty session.
    const empty = path.join(userDir, 'globalStorage', 'emptyWindowChatSessions');
    fs.mkdirSync(empty, { recursive: true });
    fs.writeFileSync(path.join(empty, 'e0.jsonl'), JSON.stringify({ kind: 0, v: { version: 3, sessionId: 'e0', customTitle: 'Untouched', requests: [] } }) + '\n');

    const state = {
      projectsDir,
      config: { copilotDir, vscodeUserDir: userDir },
      providers: {},
      commands: {},
      panels: [],
      panelPosts: [],
      errors: [],
      terminals: [],
      infos: [],
    };
    const { posted, send, last } = await activateWithSidebar(state);
    let msg = last('state');
    const cards = msg.groups.flatMap((g) => g.sessions);
    const bySource = (src) => cards.filter((c) => c.source === src);
    assert.equal(bySource('claude').length, 1);
    assert.equal(bySource('copilot-cli').length, 2, 'the real capture and the synthetic one with tool calls');
    assert.equal(bySource('vscode-chat').length, 1, 'the empty chat is hidden');
    assert.equal(new Set(cards.map((c) => c.id)).size, cards.length, 'keys are unique across sources');
    assert.ok(cards.some((c) => c.id === `claude:${shared}`) && cards.some((c) => c.id === `copilot-cli:${shared}`));
    assert.deepEqual(msg.sources.map((x) => [x.id, x.count, x.on]), [['claude', 1, true], ['copilot-cli', 2, true], ['vscode-chat', 1, true]]);
    const chat = bySource('vscode-chat')[0];
    assert.equal(chat.title, 'Chat session overview');
    assert.match(chat.projectPath, /work[\\/]site$/);

    // Chips filter for this window only.
    send({ type: 'setSources', value: ['copilot-cli'] });
    msg = last('state');
    assert.equal(msg.total, 2);
    assert.deepEqual(msg.sources.map((x) => x.on), [false, true, false]);
    assert.deepEqual(msg.sources.map((x) => x.count), [1, 2, 1], 'counts ignore the source filter');
    send({ type: 'setSources', value: ['nonsense'] });
    assert.equal(last('state').total, 0);
    assert.equal(last('state').hiddenBySource, true);
    send({ type: 'setSources', value: null });
    assert.equal(last('state').total, 4, 'anything but a list means every source');

    // source: narrows the search and is never highlighted.
    send({ type: 'search', query: 'source:copilot' });
    let results = last('searchResults');
    assert.deepEqual(results.ids.sort(), bySource('copilot-cli').map((c) => c.id).sort());
    assert.deepEqual(results.highlight, []);
    send({ type: 'search', query: '-source:claude -source:cli' });
    assert.deepEqual(last('searchResults').ids, [chat.id]);
    send({ type: 'search', query: 'login source:chat' });
    assert.deepEqual(last('searchResults').ids, []);

    // Transcripts render with each source's parser and branding.
    await state.commands['claudeSessions.openTranscript']({ sessionKey: chat.id });
    let html = state.panels[0].webview.html;
    assert.match(html, /source-avatar/);
    assert.match(html, /<strong>Copilot<\/strong>/);
    assert.match(html, /<span>Open in Chat<\/span>/);
    assert.match(html, /data-cmd="continueInNewSession" title="Start a new chat/);
    await state.commands['claudeSessions.openTranscript']({ sessionKey: `copilot-cli:${shared}` });
    html = state.panels[0].webview.html;
    assert.match(html, /GitHub Copilot CLI/);
    assert.match(html, /Create Chat Session/);

    // Open in Claude Code Chat refuses other sources; resuming Copilot runs its CLI in the session's folder.
    const copilotSession = { sessionKey: `copilot-cli:${shared}` };
    await state.commands['claudeSessions.openInClaudeCode'](copilotSession);
    assert.equal(state.terminals.length, 0);
    assert.match(state.infos.pop(), /only for Claude Code sessions/);
    await state.commands['claudeSessions.resume'](copilotSession);
    const t = state.terminals.pop();
    assert.equal(t.sent, `copilot --resume ${shared}`);
    assert.match(t.name, /^GitHub Copilot CLI · /);
    await state.commands['claudeSessions.resume']({ sessionKey: `claude:${shared}` });
    assert.equal(state.terminals.pop().sent, `claude --resume ${shared}`);
    // A chat from another workspace offers that folder's window instead of opening here.
    await state.commands['claudeSessions.resume']({ sessionKey: chat.id });
    assert.match(state.infos.pop(), /VS Code opens a chat only in the window of its own folder/);

    // Continue in New Session, Copilot CLI: one shell line pointing at the handoff file, which the CLI may read.
    await state.commands['claudeSessions.continueInNewSession'](copilotSession);
    const ct = state.terminals.pop();
    assert.match(ct.name, /^GitHub Copilot CLI · Continued: Create Chat Session/);
    const line = ct.sent;
    assert.doesNotMatch(line, /\n/);
    const [, dir] = /--add-dir "([^"]+)"/.exec(line);
    const [, file] = /Read the handoff in (.+?\.md):/.exec(line);
    assert.ok(file.startsWith(dir));
    assert.match(line, /--name "Continued: Create Chat Session" -i "/);
    const copilotHandoff = fs.readFileSync(file, 'utf8');
    fs.rmSync(file);
    assert.match(copilotHandoff, /^I'm continuing work from an earlier GitHub Copilot CLI session \("Create Chat Session"\)/);
    assert.match(copilotHandoff, /## My last request\nThis is a chat session/);
    assert.match(copilotHandoff, /## Your last reply\nHello!/);

    // VS Code Chat: a new chat in agent mode with the handoff typed in but not sent.
    const chatOpens = [];
    state.commands['workbench.action.chat.newChat'] = () => chatOpens.push('new');
    state.commands['workbench.action.chat.open'] = (o) => chatOpens.push(o);
    await state.commands['claudeSessions.continueInNewSession']({ sessionKey: chat.id });
    assert.equal(chatOpens[0], 'new');
    assert.equal(chatOpens[1].mode, 'agent');
    assert.equal(chatOpens[1].isPartialQuery, true);
    assert.match(chatOpens[1].query, /^I'm continuing work from an earlier VS Code Chat session \("Chat session overview"\)/);

    // Into another tool: pick Claude Code for the Copilot session; the earlier replies are Copilot's, not "yours".
    state.pick = (items) => items.find((i) => i.value === 'claude') ?? items[0];
    await state.commands['claudeSessions.continueInNewSessionWithModel'](copilotSession);
    const cc = state.terminals.pop();
    assert.equal(cc.shellPath, 'claude');
    const crossHandoff = cc.shellArgs[cc.shellArgs.length - 1];
    assert.match(crossHandoff, /## Copilot's last reply\nHello!/);
    // A VS Code chat as the target takes no model or effort.
    let picks = 0;
    state.pick = (items) => (picks++, items.find((i) => i.value === 'vscode-chat'));
    chatOpens.length = 0;
    await state.commands['claudeSessions.continueInNewSessionWithModel']({ sessionKey: `claude:${shared}` });
    assert.equal(picks, 1);
    assert.match(chatOpens[1].query, /earlier Claude Code session/);
    assert.match(chatOpens[1].query, /## Claude's last reply|## My last request/);
    assert.deepEqual(state.errors, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

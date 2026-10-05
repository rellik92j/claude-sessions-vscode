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
    ThemeIcon: class {},
    RelativePattern: class {},
    ViewColumn: { Active: -1, Beside: -2 },
    TerminalLocation: { Panel: 1 },
    ConfigurationTarget: { Global: 1 },
    extensions: { getExtension: () => undefined, onDidChange: () => disposable },
    env: { clipboard: { writeText: async () => {} }, openExternal: async () => {} },
    workspace: {
      workspaceFolders: [],
      getConfiguration: () => ({ get: (k, d) => (k === 'projectsDir' ? state.projectsDir : d), update: async () => {} }),
      createFileSystemWatcher: () => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {}, dispose() {} }),
      onDidChangeConfiguration: () => disposable,
      onDidChangeWorkspaceFolders: () => disposable,
    },
    window: {
      registerWebviewViewProvider: (id, provider) => ((state.providers[id] = provider), disposable),
      createWebviewPanel: () => {
        const panel = { webview: webview(state.panelPosts), onDidDispose: () => disposable, reveal() {}, title: '' };
        state.panels.push(panel);
        return panel;
      },
      onDidCloseTerminal: () => disposable,
      showErrorMessage: (m) => state.errors.push(m),
      showWarningMessage: async () => undefined,
      setStatusBarMessage() {},
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
    { type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Done:\n\n```ts\nconst x = 1;\n```' }] }, timestamp: ts },
    { type: 'ai-title', aiTitle: 'Dark mode toggle' },
  ]);

  const state = { projectsDir, providers: {}, commands: {}, panels: [], panelPosts: [], errors: [] };
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

    // Transcript search: the sidebar asks, the host answers with matched words and a snippet.
    handler({ type: 'search', key: 'const toggle', tokens: ['const', 'toggle', 'nowhere'] });
    const results = posted.filter((m) => m.type === 'searchResults').pop();
    assert.equal(results.key, 'const toggle');
    assert.deepEqual(results.hits['aaaa-1111'].found, ['const', 'toggle']);
    assert.match(results.hits['aaaa-1111'].snippet, /dark mode\*\* toggle/);

    // Opening from a search passes the words on to the transcript page.
    handler({ type: 'run', command: 'openTranscript', id: 'aaaa-1111', highlight: ['const', 42] });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(state.panels.length, 1, 'existing panel reused');
    assert.match(state.panels[0].webview.html, /<body data-highlight="\[&quot;const&quot;\]">/);
    assert.deepEqual(state.errors, []);

    // Assets referenced by the webviews must exist on disk.
    for (const f of ['media/sidebar.js', 'media/sidebar.css', 'media/transcript.js', 'media/transcript.css', 'node_modules/@vscode/codicons/dist/codicon.css', 'node_modules/@vscode/codicons/dist/codicon.ttf']) {
      assert.ok(fs.existsSync(path.join(extDir, f)), `${f} exists`);
    }
  } finally {
    Module._load = originalLoad;
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

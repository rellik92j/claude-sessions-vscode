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

  const state = { projectsDir, providers: {}, commands: {}, panels: [], panelPosts: [], errors: [], terminals: [] };
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

    // Search: the sidebar sends the query, the host answers with matching ids, snippets and highlight words.
    const search = (query) => {
      handler({ type: 'search', query });
      return posted.filter((m) => m.type === 'searchResults').pop();
    };
    let results = search('"x = 1" toggle');
    assert.equal(results.query, '"x = 1" toggle');
    assert.deepEqual(results.ids, ['aaaa-1111']);
    assert.deepEqual(results.highlight, ['x = 1', 'toggle']);
    assert.match(results.snippets['aaaa-1111'], /x = 1/);
    // Matched on the card alone: no snippet.
    results = search('dark OR nothing');
    assert.deepEqual(results.ids, ['aaaa-1111']);
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

    // Assets referenced by the webviews must exist on disk.
    for (const f of ['media/sidebar.js', 'media/sidebar.css', 'media/transcript.js', 'media/transcript.css', 'node_modules/@vscode/codicons/dist/codicon.css', 'node_modules/@vscode/codicons/dist/codicon.ttf']) {
      assert.ok(fs.existsSync(path.join(extDir, f)), `${f} exists`);
    }
  } finally {
    Module._load = originalLoad;
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

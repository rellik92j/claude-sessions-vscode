const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSession, parseTranscript, classifyUserContent, decodeProjectDir, oneLine, matchText } = require('../out/sessionParser');
const { formatRelative, dateBucket, isInside, normalizePath, escapeHtml } = require('../out/format');
const { renderMarkdown } = require('../out/markdown');

const jsonl = (...recs) => recs.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, cwd: 'C:\\repo', gitBranch: 'main', timestamp: '2026-10-01T10:00:00.000Z', ...extra });
const asst = (id, content, extra = {}) => ({ type: 'assistant', message: { id, role: 'assistant', model: 'claude-opus-5-5', content }, timestamp: '2026-10-01T10:05:00.000Z', ...extra });

test('title prefers custom > ai > first prompt > command', () => {
  const base = [user('<command-name>/effort</command-name><command-args>high</command-args>'), user('Fix the login bug please')];
  assert.equal(parseSession(jsonl(...base), 'f', 'p', 'id').title, 'Fix the login bug please');
  assert.equal(parseSession(jsonl(...base, { type: 'ai-title', aiTitle: 'Login fix' }), 'f', 'p', 'id').title, 'Login fix');
  const custom = parseSession(jsonl(...base, { type: 'ai-title', aiTitle: 'Login fix' }, { type: 'custom-title', customTitle: 'My name' }), 'f', 'p', 'id');
  assert.equal(custom.title, 'My name');
  assert.equal(custom.titleSource, 'custom');
  const cmdOnly = parseSession(jsonl(base[0]), 'f', 'p', 'id');
  assert.equal(cmdOnly.title, '/effort high');
  assert.equal(cmdOnly.titleSource, 'command');
  assert.equal(parseSession('', 'f', 'p', 'id').titleSource, 'none');
});

test('legacy summary records are used as a title', () => {
  const s = parseSession(jsonl({ type: 'summary', summary: 'Old style title' }, user('hi')), 'f', 'p', 'id');
  assert.equal(s.title, 'Old style title');
});

test('metadata: cwd, branch, times, counts, model, PR, agent', () => {
  const s = parseSession(
    jsonl(
      { type: 'mode', mode: 'normal' },
      user('<local-command-caveat>Caveat</local-command-caveat>', { isMeta: true }),
      user('first prompt', { timestamp: '2026-10-01T09:00:00.000Z' }),
      asst('m1', [{ type: 'thinking', thinking: 'x' }]),
      asst('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]),
      user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
      asst('m2', [{ type: 'text', text: 'done' }], { timestamp: '2026-10-01T11:00:00.000Z' }),
      user('second prompt', { gitBranch: 'feature/x', cwd: 'C:\\other' }),
      user('sidechain prompt', { isSidechain: true, timestamp: '2026-12-01T00:00:00.000Z' }),
      { type: 'pr-link', prUrl: 'https://github.com/o/r/pull/7', prNumber: 7, prRepository: 'o/r' },
      { type: 'agent-name', agentName: 'Lead' },
      '{"type":"user","message":{"content":"trunc', // partially written final line
    ),
    'f', 'p', 'id',
  );
  assert.equal(s.cwd, 'C:\\repo');
  assert.equal(s.gitBranch, 'feature/x');
  assert.equal(s.promptCount, 2);
  assert.equal(s.assistantCount, 2);
  assert.equal(s.firstPrompt, 'first prompt');
  assert.equal(s.lastPrompt, 'second prompt');
  assert.equal(s.startTime, Date.parse('2026-10-01T09:00:00.000Z'));
  assert.equal(s.lastTime, Date.parse('2026-10-01T11:00:00.000Z'));
  assert.equal(s.model, 'claude-opus-5-5');
  assert.equal(s.prNumber, 7);
  assert.equal(s.agentName, 'Lead');
});

test('agent-team sessions: peer messages counted, title disambiguated, shown in transcript', () => {
  const peer = user('Another Claude session sent a message:\n<cross-session-message from="uds:x" from-name="Overseer" from-mode="prompting">\nResearch the auth flow\n</cross-session-message>', { isMeta: true });
  const log = jsonl(
    user('<command-name>/clear</command-name>'),
    peer,
    asst('m1', [{ type: 'text', text: 'On it' }]),
    { type: 'agent-name', agentName: 'Project Lead' },
    { type: 'custom-title', customTitle: 'Project Lead' },
  );
  const s = parseSession(log, 'f', 'p', 'id');
  assert.equal(s.peerMessageCount, 1);
  assert.deepEqual(s.firstPeerMessage, { from: 'Overseer', text: 'Research the auth flow' });
  assert.equal(s.title, 'Project Lead — Research the auth flow');
  const t = parseTranscript(log);
  assert.deepEqual(t.map((e) => e.role), ['user', 'peer', 'assistant']);
  assert.equal(t[1].parts[0].from, 'Overseer');
  // Without a custom title the peer message becomes the title.
  assert.equal(parseSession(jsonl(peer), 'f', 'p', 'id').title, 'Overseer: Research the auth flow');
  // A custom title that differs from the agent name is kept verbatim.
  assert.equal(parseSession(jsonl(peer, { type: 'agent-name', agentName: 'A' }, { type: 'custom-title', customTitle: 'Mine' }), 'f', 'p', 'id').title, 'Mine');
});

test('searchText holds prompts, peer messages and replies but not tool I/O or thinking', () => {
  const s = parseSession(
    jsonl(
      user('<system-reminder>secret reminder</system-reminder>Find the flaky test'),
      asst('m1', [{ type: 'thinking', thinking: 'private musing' }]),
      asst('m1', [{ type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'toolinput' } }]),
      user([{ type: 'tool_result', tool_use_id: 't1', content: 'tooloutput' }]),
      asst('m2', [{ type: 'text', text: 'The culprit is a race in setup.' }]),
      user('<cross-session-message from-name="Lead">Peer note here</cross-session-message>', { isMeta: true }),
      user('sidechain words', { isSidechain: true }),
    ),
    'f',
    'p',
    'id',
  );
  assert.match(s.searchText, /Find the flaky test/);
  assert.match(s.searchText, /race in setup/);
  assert.match(s.searchText, /Peer note here/);
  for (const absent of ['secret reminder', 'private musing', 'toolinput', 'tooloutput', 'sidechain']) {
    assert.ok(!s.searchText.includes(absent), absent);
  }
});

test('matchText finds tokens case-insensitively and cuts a snippet around the earliest hit', () => {
  const text = 'x '.repeat(100) + 'The Culprit is a race in setup. ' + 'y '.repeat(200);
  const m = matchText(text, ['race', 'culprit', 'missing', 'a+b']);
  assert.deepEqual(m.found, ['race', 'culprit']);
  assert.ok(m.snippet.startsWith('…'));
  assert.ok(m.snippet.endsWith('…'));
  assert.match(m.snippet, /The Culprit is a race/);
  assert.ok(!m.snippet.includes('  '));
  assert.deepEqual(matchText('short text', ['nope']), { found: [] });
  assert.equal(matchText('short text', ['TEXT']).snippet, 'short text');
});

test('HEAD branch is ignored', () => {
  assert.equal(parseSession(jsonl(user('hi', { gitBranch: 'HEAD' })), 'f', 'p', 'id').gitBranch, undefined);
});

test('classifyUserContent filters CLI noise and system reminders', () => {
  assert.equal(classifyUserContent('<local-command-stdout>x</local-command-stdout>').kind, 'noise');
  assert.equal(classifyUserContent('<bash-input>ls</bash-input>').kind, 'noise');
  assert.equal(classifyUserContent('[Request interrupted by user]').kind, 'noise');
  assert.equal(classifyUserContent([{ type: 'tool_result', content: 'x' }]).kind, 'noise');
  assert.equal(classifyUserContent(undefined).kind, 'noise');
  assert.deepEqual(classifyUserContent('<system-reminder>ctx</system-reminder>\nreal question'), { kind: 'prompt', text: 'real question' });
  assert.deepEqual(classifyUserContent([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), { kind: 'prompt', text: 'a\nb' });
});

test('transcript merges a whole Claude turn and attaches tool results to their calls', () => {
  const t = parseTranscript(
    jsonl(
      user('do it'),
      asst('m1', [{ type: 'text', text: 'Sure' }]),
      asst('m1', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } }]),
      user([{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'file body' }] }]),
      asst('m2', [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' } }]),
      user([{ type: 'tool_result', tool_use_id: 't2', content: 'boom', is_error: true }]),
      user([{ type: 'tool_result', tool_use_id: 'unknown', content: 'orphan' }]),
      asst('m3', [{ type: 'text', text: 'All done' }]),
      { type: 'system', subtype: 'compact_boundary', timestamp: '2026-10-01T12:00:00.000Z' },
      user('meta', { isMeta: true }),
      user('side', { isSidechain: true }),
    ),
  );
  assert.deepEqual(t.map((e) => e.role), ['user', 'assistant', 'tool', 'assistant', 'system']);
  const [, turn, orphan] = t;
  assert.deepEqual(turn.parts.map((p) => p.kind), ['text', 'tool_use', 'tool_use']);
  assert.equal(turn.parts[1].hint, 'a.ts');
  assert.deepEqual(turn.parts[1].result, { text: 'file body', isError: false });
  assert.deepEqual(turn.parts[2].diff, { before: 'a', after: 'b' });
  assert.equal(turn.parts[2].result.isError, true);
  assert.equal(orphan.parts[0].text, 'orphan');
});

test('transcript truncates huge tool output', () => {
  const t = parseTranscript(jsonl(user([{ type: 'tool_result', content: 'x'.repeat(10000) }])));
  assert.ok(t[0].parts[0].text.length < 4100);
  assert.match(t[0].parts[0].text, /more characters/);
});

test('decodeProjectDir and oneLine', () => {
  assert.equal(decodeProjectDir('C--Users-me-repo'), 'C:\\Users\\me\\repo');
  assert.equal(decodeProjectDir('-home-me-repo'), '/home/me/repo');
  assert.equal(oneLine('a\n\n  b'), 'a b');
  assert.equal(oneLine('<pasted_content id="x1">\nhello\n</pasted_content> more'), 'hello more');
  assert.equal(oneLine('x'.repeat(200), 10).length, 10);
});

test('format helpers', () => {
  const now = Date.parse('2026-10-03T12:00:00');
  assert.equal(formatRelative(now - 10_000, now), 'just now');
  assert.equal(formatRelative(now - 5 * 60_000, now), '5m ago');
  assert.equal(formatRelative(now - 3 * 3600_000, now), '3h ago');
  assert.equal(formatRelative(now - 2 * 86400_000, now), '2d ago');
  assert.equal(dateBucket(now - 3600_000, now), 'Today');
  assert.equal(dateBucket(Date.parse('2026-10-02T08:00:00'), now), 'Yesterday');
  assert.equal(dateBucket(now - 5 * 86400_000, now), 'Previous 7 Days');
  assert.equal(dateBucket(now - 20 * 86400_000, now), 'Previous 30 Days');
  assert.equal(dateBucket(now - 90 * 86400_000, now), 'Older');
  assert.ok(isInside('C:\\Users\\Me\\repo\\sub', 'c:/users/me/repo', 'win32'));
  assert.ok(!isInside('C:\\Users\\Me\\repo2', 'C:\\Users\\Me\\repo', 'win32'));
  assert.ok(!isInside('/home/Me/repo', '/home/me/repo', 'linux'));
  assert.equal(normalizePath('/a/b/', 'linux'), '/a/b');
});

test('renderMarkdown escapes HTML, highlights code, renders tables and lists', () => {
  const html = renderMarkdown(
    'Hi <script>alert(1)</script> <img src=x onerror=alert(1)> `x` **b**\n\n```js\nconst a = "<b>";\n```\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[bad](javascript:alert(1)) https://example.com',
  );
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('<code>x</code>'));
  assert.ok(html.includes('<strong>b</strong>'));
  assert.match(html, /<div class="code-block">.*code-lang">js<.*<span class="hljs-keyword">const<\/span>/s);
  assert.ok(html.includes('&quot;&lt;b&gt;&quot;'));
  assert.ok(html.includes('<li>one</li>'));
  assert.ok(html.includes('<table>'));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('href="https://example.com"'));
  assert.ok(renderMarkdown('a\nb', 'user').includes('<br>'));
  assert.equal(escapeHtml(`"'&`), '&quot;&#39;&amp;');
});

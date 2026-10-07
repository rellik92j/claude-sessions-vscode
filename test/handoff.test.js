const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { collectHandoffFacts, collectTranscriptFacts, buildHandoff, shellWrites, MAX_HANDOFF } = require('../out/handoff');
const { parseCopilotTranscript } = require('../out/copilotCliParser');
const { parseChatTranscript } = require('../out/vscodeChatParser');

const jsonl = (...recs) => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
const asst = (content, extra = {}) => ({ type: 'assistant', message: { id: 'm', role: 'assistant', content }, ...extra });
const tool = (name, input) => ({ type: 'tool_use', id: 't', name, input });

const session = { id: 'sess-1', filePath: 'C:\\logs\\sess-1.jsonl', title: 'Fix login', gitBranch: 'main', prUrl: undefined };

test('collectHandoffFacts: last prompt and reply, edited vs read files, open to-dos', () => {
  const f = collectHandoffFacts(
    jsonl(
      user('First request'),
      asst([tool('Read', { file_path: 'C:\\repo\\a.ts' }), tool('Read', { file_path: 'C:\\repo\\b.ts' })]),
      asst([tool('Edit', { file_path: 'C:\\repo\\a.ts', old_string: 'x', new_string: 'y' })]),
      asst([tool('Write', { file_path: 'C:\\repo\\c.ts', content: '' }), tool('Bash', { command: 'sed -i s/a/b/ d.ts' })]),
      asst([tool('TodoWrite', { todos: [{ content: 'done', status: 'completed' }, { content: 'add tests', status: 'in_progress' }] })]),
      user([{ type: 'tool_result', tool_use_id: 't', content: 'ok' }]),
      user('<system-reminder>noise</system-reminder>Second "quoted" request'),
      asst([{ type: 'text', text: 'Reply one' }]),
      asst([{ type: 'text', text: 'Final reply' }]),
      user('sidechain prompt', { isSidechain: true }),
      asst([tool('Edit', { file_path: 'C:\\repo\\side.ts' })], { isSidechain: true }),
      user('<local-command-stdout>x</local-command-stdout>'),
    ),
  );
  assert.equal(f.lastPrompt, 'Second "quoted" request');
  assert.equal(f.lastReply, 'Reply one\n\nFinal reply', 'the whole last turn, not just its final line');
  assert.deepEqual(f.modified, ['C:\\repo\\a.ts', 'C:\\repo\\c.ts']);
  assert.deepEqual(f.read, ['C:\\repo\\b.ts'], 'a file that was edited is not also listed as read');
  assert.deepEqual(f.todos, [{ content: 'add tests', status: 'in_progress' }]);
});

test('buildHandoff: sections, relative paths, git status, and the wait instruction', () => {
  const memory = path.join(os.homedir(), '.claude', 'projects', 'p', 'memory', 'note.md');
  const scratch = path.join(os.tmpdir(), 'claude', 'p', 'sess-1', 'scratchpad', 'demo.js');
  const toolOutput = path.join(os.homedir(), '.claude', 'projects', 'p', 'sess-1', 'tool-results', 'out.txt');
  const modified = ['C:\\repo\\src\\a.ts', 'D:\\elsewhere\\x.ts', memory, scratch, toolOutput];
  const f = { lastPrompt: 'Do it', previousPrompt: 'Fix the login bug', lastReply: 'Done', modified, read: [], todos: [] };
  const text = buildHandoff(session, f, 'C:\\repo', '## main\n M src/a.ts\n');
  assert.match(text, /^I'm continuing work from an earlier Claude Code session \("Fix login", on branch main\)/);
  assert.match(text, /## My last request\nDo it/);
  assert.match(text, /## The request before that\nFix the login bug/, 'a short request comes with the one before it');
  assert.match(text, /## Your last reply\nDone/);
  if (process.platform === 'win32') {
    assert.match(text, /- src\\a\.ts/);
  }
  assert.match(text, /- … and 1 other file outside the project/, 'other files outside the project are only counted');
  assert.doesNotMatch(text, /elsewhere/);
  assert.ok(text.includes(`- ~${path.sep}${path.join('.claude', 'projects', 'p', 'memory', 'note.md')}`), 'files under ~/.claude are named');
  assert.doesNotMatch(text, /scratchpad|demo\.js|tool-results/, 'scratch files and saved tool output are left out');
  assert.match(text, /## Working tree now \(git status\)\n```\n## main\n M src\/a\.ts\n```/);
  assert.doesNotMatch(text, /## Files read|## Unfinished/);
  assert.match(text, /C:\\logs\\sess-1\.jsonl \(session sess-1\)/);
  assert.match(text, /then wait for my instruction\.$/);
});

test('buildHandoff stays under the size limit, keeping the newest files', () => {
  const many = Array.from({ length: 400 }, (_, i) => `C:\\repo\\some\\fairly\\deep\\folder\\file-${i}.ts`);
  const f = { lastPrompt: 'p'.repeat(20000), lastReply: 'r'.repeat(20000), modified: many, read: many.map((m) => m + '.md'), todos: [] };
  const text = buildHandoff(session, f, 'C:\\repo', Array.from({ length: 500 }, (_, i) => ` M f${i}`).join('\n'));
  assert.ok(text.length <= MAX_HANDOFF, `length ${text.length}`);
  assert.match(text, /file-399\.ts/, 'newest file kept');
  assert.doesNotMatch(text, /file-0\.ts\n/, 'oldest files dropped');
  assert.match(text, /… \d+ earlier/);
  assert.match(text, /## Your last reply\nr+ \[…\] \(rest in the transcript\)\n/, 'a long final message keeps its start');
  assert.doesNotMatch(text, /## The request before that/, 'a long request stands alone');
  const turn = buildHandoff(session, { ...f, replyIsWholeTurn: true }, 'C:\\repo');
  assert.match(turn, /## Your last reply\n\[…\] r+\n/, 'a whole-turn fallback keeps its end');
  assert.match(text, /wait for my instruction\.$/, 'closing instruction survives');
});

test('skills and MCP servers the session used are collected and listed', () => {
  const f = collectHandoffFacts(
    jsonl(
      user('Ship it'),
      asst([tool('Skill', { skill: 'ship-change' }), tool('Skill', { skill: 'productivity:update' })]),
      asst([tool('mcp__claude_ai_Gmail__search_threads', {}), tool('mcp__claude_ai_Gmail__get_thread', {})]),
      asst([tool('mcp__plugin_github_github__create_pull_request', {}), tool('Skill', { skill: 'ship-change' })]),
      asst([{ type: 'text', text: 'Done.' }]),
    ),
  );
  assert.deepEqual(f.skills, ['ship-change', 'productivity:update']);
  assert.deepEqual(f.mcpServers, ['mcp__claude_ai_Gmail', 'mcp__plugin_github_github']);
  const text = buildHandoff(session, f, 'C:\\repo');
  assert.match(text, /## Skills and connectors used\n- Skills: ship-change, productivity:update\n- Connectors and MCP servers \(tool prefixes\): mcp__claude_ai_Gmail, mcp__plugin_github_github/);
  assert.doesNotMatch(buildHandoff(session, { ...f, skills: [], mcpServers: [] }, 'C:\\repo'), /## Skills and connectors/);
});

test('skills typed as /name are listed and count as the request; built-in commands are not', () => {
  const load = (name, extra = {}) => user([{ type: 'text', text: `Base directory for this skill: C:\\skills\\${name}\n\n# Skill` }], { isMeta: true, ...extra });
  const command = (name, args = '') =>
    user(`<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`);
  const f = collectHandoffFacts(
    jsonl(
      user('Fix the bug'),
      asst([tool('Skill', { skill: 'start-change' })]),
      load('start-change', { sourceToolUseID: 't' }),
      asst([{ type: 'text', text: 'Fixed.' }]),
      command('effort', 'high'),
      user('<local-command-stdout>Set effort to high</local-command-stdout>'),
      command('productivity:update'),
      load('update'),
      command('ship-change', 'looks good'),
      load('ship-change'),
      asst([{ type: 'text', text: 'Shipped.' }]),
    ),
  );
  assert.deepEqual(f.skills, ['start-change', 'productivity:update', 'ship-change']);
  assert.equal(f.lastPrompt, '/ship-change looks good');
  assert.equal(f.previousPrompt, '/productivity:update');
  assert.equal(f.lastReply, 'Shipped.');
});

test('collectHandoffFacts: the reply is the final message after the last tool call', () => {
  const summary = ('Shipped. ' + 'Details of what changed. '.repeat(10)).trim();
  const f = collectHandoffFacts(
    jsonl(
      user('Ship it'),
      asst([{ type: 'text', text: 'Running the tests first.' }, tool('Bash', { command: 'npm test' })]),
      user([{ type: 'tool_result', tool_use_id: 't', content: 'ok' }]),
      asst([{ type: 'text', text: summary }]),
    ),
  );
  assert.equal(f.lastReply, summary);
  assert.equal(f.replyIsWholeTurn, undefined);
  assert.equal(f.previousPrompt, undefined);
});

test('collectHandoffFacts: an interrupted turn falls back to the whole turn, and the earlier prompt is kept', () => {
  const f = collectHandoffFacts(
    jsonl(
      user('Add dark mode'),
      asst([{ type: 'text', text: 'Added.' }]),
      user('yes'),
      asst([{ type: 'text', text: 'Updating the CSS.' }, tool('Edit', { file_path: 'C:\\repo\\a.css' })]),
      asst([{ type: 'text', text: 'Now tests.' }]),
    ),
  );
  assert.equal(f.lastReply, 'Updating the CSS.\n\nNow tests.');
  assert.equal(f.replyIsWholeTurn, true);
  assert.equal(f.previousPrompt, 'Add dark mode');
});

test('collectTranscriptFacts: Copilot CLI and VS Code Chat transcripts', () => {
  const fixtures = path.join(__dirname, 'fixtures');
  const dir = fs.readdirSync(path.join(fixtures, 'copilot-cli')).find((d) => d.startsWith('3f2a'));
  const log = fs.readFileSync(path.join(fixtures, 'copilot-cli', dir, 'events.jsonl'), 'utf8');
  const cli = collectTranscriptFacts(parseCopilotTranscript(log), path.join(os.tmpdir(), 'repo'));
  assert.ok(cli.lastPrompt);
  assert.ok(cli.lastReply);
  // router.ts was viewed, then edited: listed once, as changed, resolved against the session's folder.
  assert.deepEqual(cli.modified, [path.join(os.tmpdir(), 'repo', 'src', 'router.ts')]);
  assert.deepEqual(cli.read, []);

  // A VS Code read call saves no input, only "Read <path>"; the path is taken from there.
  const entries = parseChatTranscript(
    JSON.stringify({
      kind: 0,
      v: {
        requests: [
          {
            message: { text: 'read the readme' },
            response: [
              { kind: 'toolInvocationSerialized', toolId: 'copilot_readFile', isComplete: true, pastTenseMessage: { value: 'Read [](file:///c%3A/repo/README.md)' } },
              { kind: 'toolInvocationSerialized', toolId: 'copilot_replaceString', isComplete: true, toolSpecificData: { filePath: 'C:\\repo\\a.ts' } },
              { value: 'Summary of the readme.' },
            ],
          },
        ],
      },
    }),
  );
  const chat = collectTranscriptFacts(entries);
  assert.equal(chat.lastPrompt, 'read the readme');
  assert.equal(chat.lastReply, 'Summary of the readme.');
  assert.deepEqual(chat.modified, ['C:\\repo\\a.ts']);
  assert.equal(chat.read.length, 1);
  assert.match(chat.read[0], /repo[\\/]README\.md$/);
  const text = buildHandoff({ ...session, source: 'vscode-chat' }, chat, 'C:\\repo', undefined, 'claude');
  assert.match(text, /^I'm continuing work from an earlier VS Code Chat session/);
  assert.match(text, /## Copilot's last reply\nSummary of the readme\./);
});

test('handoff notes: files and pages written when the user asked for a handoff, wherever they went', () => {
  const scratch = path.join(os.tmpdir(), 'claude', 'p', 'sess-1', 'scratchpad', 'handoff.md');
  const result = (id, text) => user([{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }]);
  const f = collectHandoffFacts(
    jsonl(
      user('does the handoff list the files?'),
      asst([tool('Edit', { file_path: 'C:\\repo\\README.md' })]),
      user('create and save a handoff.md for this session'),
      asst([
        tool('Write', { file_path: 'C:\\repo\\HANDOFF.md', content: '' }),
        tool('Edit', { file_path: 'C:\\repo\\src\\a.ts' }),
        tool('Write', { file_path: scratch, content: '' }),
      ]),
      { ...asst([tool('Bash', { command: 'cp HANDOFF.md /c/Users/me/Desktop/ && echo done > /dev/null' })]), cwd: 'C:\\repo' },
      asst([{ type: 'tool_use', id: 'pub', name: 'Artifact', input: { file_path: scratch } }]),
      result('pub', 'Published to https://claude.ai/code/artifact/abc123. Watching it.'),
      asst([{ type: 'text', text: 'Saved.' }]),
      user('now fix the login bug'),
      asst([tool('Write', { file_path: 'C:\\repo\\notes.md' }), tool('Write', { file_path: 'C:\\other\\HANDOFF.md' })]),
    ),
  );
  assert.deepEqual(
    f.handoffNotes,
    ['C:\\repo\\HANDOFF.md', scratch, path.join('C:\\Users\\me\\Desktop', 'HANDOFF.md'), 'https://claude.ai/code/artifact/abc123', 'C:\\other\\HANDOFF.md'],
    'code, files from turns that only mention a handoff, and unrelated notes are left out; later copies count',
  );

  const text = buildHandoff(session, f, 'C:\\repo');
  assert.ok(text.indexOf('## Read first: handoff notes') < text.indexOf('## My last request'), 'called out first');
  assert.ok(text.includes('read them before anything else:\n\n    C:\\other\\HANDOFF.md\n\nOther copies, newest first.'), 'the latest stands alone');
  assert.ok(
    text.includes(`can't be read:\n- https://claude.ai/code/artifact/abc123\n- ${path.join('C:\\Users\\me\\Desktop', 'HANDOFF.md')}\n- ${scratch}\n- C:\\repo\\HANDOFF.md\n`),
    'older copies newest first, a scratch copy named in full',
  );
  assert.equal(text.split('C:\\other\\HANDOFF.md').length, 2, 'the latest is named once');
  assert.doesNotMatch(text.split('## Files changed with edit tools')[1].split('The full earlier')[0], /HANDOFF/, 'not listed twice');
  assert.ok(text.includes('First read the handoff notes named at the top. Then, before changing anything, briefly summarise'));
  assert.match(text, /wait for my instruction\.$/);
});

test('handoff notes: a handoff skill, Claude-invoked or typed, marks its turn', () => {
  const memory = path.join(os.homedir(), '.claude', 'projects', 'p', 'memory', 'project_lead_handoff.md');
  const invoked = collectHandoffFacts(
    jsonl(user('wrap up for today'), asst([tool('Skill', { skill: 'session-handoff' })]), asst([tool('Write', { file_path: memory })])),
  );
  assert.deepEqual(invoked.handoffNotes, [memory]);
  const typed = collectHandoffFacts(
    jsonl(
      user('<command-message>handoff</command-message>\n<command-name>/handoff</command-name>\n<command-args></command-args>'),
      user([{ type: 'text', text: 'Base directory for this skill: C:\\skills\\handoff' }], { isMeta: true }),
      asst([tool('Write', { file_path: 'C:\\repo\\docs\\handoff-2026-10-06.md' })]),
    ),
  );
  assert.deepEqual(typed.handoffNotes, ['C:\\repo\\docs\\handoff-2026-10-06.md']);
  const one = buildHandoff(session, typed, 'C:\\repo');
  assert.ok(one.includes('before anything else:\n\n    C:\\repo\\docs\\handoff-2026-10-06.md\n\n## My last request'));
  assert.doesNotMatch(one, /Other copies/);
  const none = buildHandoff(session, { ...typed, handoffNotes: [] }, 'C:\\repo');
  assert.doesNotMatch(none, /handoff notes|First read/);
});

test('shellWrites: redirections, tee, PowerShell cmdlets and copies', () => {
  assert.deepEqual(shellWrites("cat > handoff.md <<'EOF'\nx\nEOF", 'C:\\repo'), [path.join('C:\\repo', 'handoff.md')]);
  assert.deepEqual(shellWrites('echo x 2>&1 >> "C:\\a\\n.md"'), [path.normalize('C:\\a\\n.md')]);
  assert.deepEqual(shellWrites('echo x >> C:\\notes\\n.md 2>/dev/null'), [path.normalize('C:\\notes\\n.md')]);
  assert.deepEqual(shellWrites('echo x | tee -a ~/h.md'), [path.join(os.homedir(), 'h.md')]);
  assert.deepEqual(shellWrites('Set-Content -Value $x -Path C:\\h.md'), [path.normalize('C:\\h.md')]);
  assert.deepEqual(shellWrites('$t | Out-File C:\\h.txt -Encoding utf8'), [path.normalize('C:\\h.txt')]);
  assert.deepEqual(shellWrites('Copy-Item -Path C:\\r\\h.md -Destination D:\\backup'), [path.join('D:\\backup', 'h.md')]);
  assert.deepEqual(shellWrites('echo $x > $out'), []);
});

test('shellWrites: what a heredoc or here-string writes is text, not commands', () => {
  // The body of a script being written once showed up as handoff notes named "\", "void)" and "add(m[2]))".
  const heredoc = "cat >> test/a.test.js <<'EOF'\nconst f = (x) => add(x);\nif (a > b) {}\nassert('\\\\' > '\\\\');\nEOF\necho ok > done.md";
  assert.deepEqual(shellWrites(heredoc, 'C:\\repo'), [path.join('C:\\repo', 'test', 'a.test.js'), path.join('C:\\repo', 'done.md')]);
  assert.deepEqual(shellWrites("python - <<'EOF'\nopen('x.md','w')  # a > b.md\nEOF"), []);
  assert.deepEqual(shellWrites("@'\n$a -> b > c.md\n'@ | Set-Content C:\\h.md"), [path.normalize('C:\\h.md')]);
  assert.deepEqual(shellWrites('node -e "[1].map((x) => x)"'), []);
});

test('handoff notes: only notes files count, not code or extensionless names', () => {
  const f = collectHandoffFacts(
    jsonl(
      user('write a handoff for this session'),
      { ...asst([tool('Bash', { command: 'echo x > handoff && echo y > / && echo z > notes.md' })]), cwd: 'C:\\repo' },
    ),
  );
  assert.deepEqual(f.handoffNotes, [path.join('C:\\repo', 'notes.md')]);
});

test('handoff notes: Copilot CLI and VS Code Chat transcripts', () => {
  const entries = [
    { role: 'user', parts: [{ kind: 'text', text: 'Write a handoff doc and save it to docs/' }] },
    {
      role: 'assistant',
      parts: [
        { kind: 'tool_use', name: 'create', input: JSON.stringify({ path: 'docs/handoff.md' }) },
        { kind: 'tool_use', name: 'bash', input: JSON.stringify({ command: 'cp docs/handoff.md ~/Desktop/' }) },
        { kind: 'text', text: 'Done.' },
      ],
    },
  ];
  const f = collectTranscriptFacts(entries, 'C:\\repo');
  assert.deepEqual(f.handoffNotes, [path.join('C:\\repo', 'docs', 'handoff.md'), path.join(os.homedir(), 'Desktop', 'handoff.md')]);
});

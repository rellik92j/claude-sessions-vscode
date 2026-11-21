const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseSession, parseTranscript } = require('../out/sessionParser');
const { collectInsights } = require('../out/insights');
const { writeCustomTitle } = require('../out/sessionStore');

const jsonl = (...recs) => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
const user = (content) => ({ type: 'user', message: { role: 'user', content }, timestamp: '2026-10-01T10:00:00.000Z' });
const call = (id, name, input) => ({ type: 'assistant', message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, text, isError = false) => user([{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }]);

test('insights: files, commits, PRs, skills, commands, subagents, web, MCP, prompts', () => {
  const log = jsonl(
    user('<command-name>/start-change</command-name><command-args>add x</command-args>'),
    user('Add the thing'),
    call('t1', 'Read', { file_path: 'C:\\repo\\a.ts' }),
    result('t1', 'contents'),
    call('t2', 'Edit', { file_path: 'C:\\repo\\a.ts', old_string: 'a', new_string: 'b' }),
    result('t2', 'ok'),
    call('t3', 'Write', { file_path: 'C:\\repo\\new.ts', content: 'x'.repeat(10_000) }),
    result('t3', 'ok'),
    call('t4', 'Read', { file_path: 'C:\\repo\\b.ts' }),
    result('t4', 'contents'),
    call('t5', 'Bash', { command: 'git commit -m "Add the thing"' }),
    result('t5', '[add-x 1a2b3c4] Add the thing\n 2 files changed'),
    call('t6', 'Bash', { command: 'gh pr create --fill' }),
    result('t6', 'https://github.com/me/repo/pull/42\n'),
    call('t7', 'Skill', { skill: 'ship-change' }),
    result('t7', 'loaded'),
    call('t8', 'Agent', { description: 'Find callers', subagent_type: 'Explore', prompt: '…' }),
    result('t8', 'done'),
    call('t9', 'WebFetch', { url: 'https://example.com/doc', prompt: 'x' }),
    result('t9', 'page'),
    call('t10', 'mcp__claude_ai_Gmail__search_threads', { query: 'x' }),
    result('t10', 'boom', true),
    call('t11', 'Edit', { file_path: 'C:\\repo\\c.ts', old_string: 'a', new_string: 'b' }),
    result('t11', 'String not found', true),
    user('Now ship it'),
  );
  const ins = collectInsights(parseTranscript(log));
  assert.deepEqual(ins.changed.map((f) => [f.path, f.count, !!f.written]), [
    ['C:\\repo\\a.ts', 1, false],
    ['C:\\repo\\new.ts', 1, true],
  ]);
  // A read-then-edited file is only under changed; a failed edit doesn't count.
  assert.deepEqual(ins.read.map((f) => f.path), ['C:\\repo\\b.ts']);
  assert.deepEqual(ins.commits, [{ branch: 'add-x', hash: '1a2b3c4', subject: 'Add the thing' }]);
  assert.deepEqual(ins.pullRequests, ['https://github.com/me/repo/pull/42']);
  assert.deepEqual(ins.skills, [{ name: 'ship-change', count: 1 }]);
  assert.deepEqual(ins.commands, [{ name: '/start-change', count: 1 }]);
  assert.deepEqual(ins.subagents, [{ type: 'Explore', description: 'Find callers' }]);
  assert.deepEqual(ins.web, [{ kind: 'fetch', text: 'https://example.com/doc' }]);
  assert.deepEqual(ins.mcpServers, [{ name: 'Gmail', count: 1 }]);
  assert.equal(ins.failedTools, 2);
  assert.deepEqual(ins.prompts.map((p) => p.text), ['/start-change add x', 'Add the thing', 'Now ship it']);
});

test('insights: commits are only read from git commit output', () => {
  const log = jsonl(call('t1', 'Bash', { command: 'git log -1' }), result('t1', '[main 1a2b3c4] Not mine'));
  assert.deepEqual(collectInsights(parseTranscript(log)).commits, []);
});

test('writeCustomTitle appends a custom-title record that the parser picks up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-'));
  const file = path.join(dir, 's.jsonl');
  // No trailing newline: the record must still land on its own line.
  fs.writeFileSync(file, JSON.stringify(user('Fix the login bug')) + '\n' + JSON.stringify({ type: 'ai-title', aiTitle: 'Login fix' }));
  await writeCustomTitle(file, 'sid', '  My   name ');
  const s = parseSession(fs.readFileSync(file, 'utf8'), file, 'p', 'sid');
  assert.equal(s.title, 'My name');
  assert.equal(s.titleSource, 'custom');
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 3);
  await assert.rejects(writeCustomTitle(file, 'sid', '   '));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('commitSubject reads -m and heredoc messages', () => {
  const { commitSubject } = require('../out/insights');
  assert.equal(commitSubject('git commit -m "Fix \\"quoted\\" bug"'), 'Fix "quoted" bug');
  assert.equal(commitSubject("git add . && git commit -q -m 'Single quoted'"), 'Single quoted');
  assert.equal(commitSubject("git commit -q -F - <<'EOF'\nBump to 0.2.7\n\nBody\nEOF"), 'Bump to 0.2.7');
  assert.equal(commitSubject('git commit'), undefined);
});

test('a quiet commit is left for the repository lookup', () => {
  const log = jsonl(call('t1', 'Bash', { command: "git commit -q -F - <<'EOF'\nQuiet one\nEOF" }), result('t1', ''));
  const ins = collectInsights(parseTranscript(log));
  assert.deepEqual(ins.commits, []);
  assert.deepEqual(ins.unresolvedCommits, ['Quiet one']);
});

const withUsage = (id, content, time, usage = { input_tokens: 1000, output_tokens: 500 }) => ({
  type: 'assistant',
  timestamp: time,
  message: { id, role: 'assistant', model: 'claude-opus-5-5', content, usage },
});

test('each prompt gets the cost and duration of its reply', () => {
  const log = jsonl(
    { ...user('first'), timestamp: '2026-10-01T10:00:00.000Z' },
    withUsage('a1', [{ type: 'text', text: 'one' }], '2026-10-01T10:00:05.000Z'),
    withUsage('a2', [{ type: 'text', text: 'two' }], '2026-10-01T10:02:00.000Z'),
    { ...user('second'), timestamp: '2026-10-01T10:05:00.000Z' },
    withUsage('a3', [{ type: 'text', text: 'three' }], '2026-10-01T10:05:30.000Z'),
    { ...user('third, unanswered'), timestamp: '2026-10-01T10:06:00.000Z' },
  );
  const [p1, p2, p3] = collectInsights(parseTranscript(log)).prompts;
  assert.equal(p1.turn.requests, 2);
  assert.equal(p1.turn.durationMs, 120_000);
  assert.equal(p1.turn.outputTokens, 1000);
  assert.ok(p1.turn.cost > 0 && Math.abs(p1.turn.cost - 2 * p2.turn.cost) < 1e-9);
  assert.equal(p2.turn.durationMs, 30_000);
  assert.equal(p3.turn, undefined);
});

test('todo list: TodoWrite replaces it, TaskCreate/TaskUpdate change one item', () => {
  const todos = (...recs) => collectInsights(parseTranscript(jsonl(...recs))).todos;
  const list = [
    { content: 'Write parser', status: 'completed', activeForm: 'Writing parser' },
    { content: 'Add tests', status: 'in_progress', activeForm: 'Adding tests' },
    { content: 'Ship', status: 'pending', activeForm: 'Shipping' },
  ];
  assert.deepEqual(todos(call('t1', 'TodoWrite', { todos: list }), result('t1', 'ok')), [
    { text: 'Write parser', status: 'done' },
    { text: 'Add tests', status: 'active' },
    { text: 'Ship', status: 'pending' },
  ]);
  assert.deepEqual(
    todos(
      call('c1', 'TaskCreate', { subject: 'Plan', description: 'x' }),
      result('c1', 'Task #1 created successfully: Plan'),
      call('c2', 'TaskCreate', { subject: 'Build', description: 'y' }),
      result('c2', 'Task #2 created successfully: Build'),
      call('u1', 'TaskUpdate', { taskId: '1', status: 'completed' }),
      result('u1', 'Updated task #1 status'),
      call('u2', 'TaskUpdate', { taskId: '2', status: 'in_progress' }),
      result('u2', 'Updated task #2 status'),
    ),
    [
      { text: 'Plan', status: 'done' },
      { text: 'Build', status: 'active' },
    ],
  );
  assert.deepEqual(todos(call('m1', 'update_todo', { todos: '- [x] One\n- [ ] Two' }), result('m1', 'ok')), [
    { text: 'One', status: 'done' },
    { text: 'Two', status: 'pending' },
  ]);
});

test('edits are kept per file and shown as a diff', () => {
  const { editsAsDiff } = require('../out/insights');
  const log = jsonl(call('t1', 'Edit', { file_path: 'C:\\repo\\a.ts', old_string: 'old line', new_string: 'new line' }), result('t1', 'ok'));
  const [file] = collectInsights(parseTranscript(log)).changed;
  assert.deepEqual(file.edits, [{ before: 'old line', after: 'new line' }]);
  assert.match(editsAsDiff(file), /@@ edit 1 of 1 @@\n-old line\n\+new line\n/);
});

test('parseSession records changed files, skills and successful commits for search filters', () => {
  const log = jsonl(
    user('go'),
    call('t1', 'Edit', { file_path: 'C:\\repo\\src\\auth.ts', old_string: 'a', new_string: 'b' }),
    call('t2', 'Read', { file_path: 'C:\\repo\\README.md' }),
    call('t3', 'Skill', { skill: 'ship-change' }),
    call('t4', 'Bash', { command: 'git commit -q -m "x"' }),
    result('t4', ''),
    call('t5', 'Bash', { command: 'git commit -m "y"' }),
    result('t5', 'nothing to commit', true),
  );
  const s = parseSession(log, 'f', 'p', 'id');
  assert.deepEqual(s.changedFiles, ['C:\\repo\\src\\auth.ts']);
  assert.deepEqual(s.skills, ['ship-change']);
  assert.equal(s.commitCount, 1);
});

test('file:, skill: and has: search filters', () => {
  const { parseQuery, fieldsMatch, isEmptyQuery } = require('../out/query');
  const s = { changedFiles: ['C:\\repo\\src\\Auth.ts'], skills: ['ship-change'], commitCount: 2 };
  const ok = (q) => fieldsMatch(parseQuery(q), s);
  assert.ok(ok('file:auth.ts'));
  assert.ok(ok('file:src/auth'));
  assert.ok(!ok('file:login.ts'));
  assert.ok(ok('skill:ship'));
  assert.ok(ok('has:commits'));
  assert.ok(!ok('has:pr'));
  assert.ok(ok('-has:pr'));
  assert.ok(ok('has:edits skill:ship file:auth'));
  assert.ok(!fieldsMatch(parseQuery('has:edits'), {}));
  // An unknown has: value is searched as text.
  assert.equal(parseQuery('has:wings').fields.length, 0);
  assert.equal(parseQuery('has:wings').clauses.length, 1);
  assert.ok(!isEmptyQuery(parseQuery('has:commits')));
});

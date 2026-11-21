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

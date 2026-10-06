const test = require('node:test');
const assert = require('node:assert/strict');
const { collectHandoffFacts, buildHandoff, MAX_HANDOFF } = require('../out/handoff');

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
  const f = { lastPrompt: 'Do it', lastReply: 'Done', modified: ['C:\\repo\\src\\a.ts', 'D:\\elsewhere\\x.ts'], read: [], todos: [] };
  const text = buildHandoff(session, f, 'C:\\repo', '## main\n M src/a.ts\n');
  assert.match(text, /^I'm continuing work from an earlier Claude Code session \("Fix login", on branch main\)/);
  assert.match(text, /## My last request\nDo it/);
  assert.match(text, /## Your last reply\nDone/);
  if (process.platform === 'win32') {
    assert.match(text, /- src\\a\.ts/);
  }
  assert.match(text, /- … and 1 outside the project/, 'files outside the project are only counted');
  assert.doesNotMatch(text, /elsewhere/);
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
  assert.match(text, /## Your last reply\n\[…\] r+\n/, 'a long reply keeps its end');
  assert.match(text, /wait for my instruction\.$/, 'closing instruction survives');
});

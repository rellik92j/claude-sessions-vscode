const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseCopilotSession, parseCopilotTranscript, readYamlScalars } = require('../out/copilotCliParser');
const { parseSession, MAX_SEARCH_TEXT } = require('../out/sessionParser');

const ID = '3f2a9c1e-0b7d-4e55-9a41-6c2d8e1f7a10';
const dir = path.join(__dirname, 'fixtures', 'copilot-cli', ID);
const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
const yaml = fs.readFileSync(path.join(dir, 'workspace.yaml'), 'utf8');

const jsonl = (...recs) => recs.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';
const ev = (type, data, timestamp = '2026-10-01T10:00:00.000Z') => ({ type, data, timestamp });

test('session metadata from events and workspace.yaml', () => {
  const s = parseCopilotSession(events, 'f', ID, yaml);
  assert.equal(s.source, 'copilot-cli');
  assert.equal(s.key, `copilot-cli:${ID}`);
  assert.equal(s.id, ID);
  assert.equal(s.projectDir, '');
  assert.equal(s.title, 'Fix the login redirect');
  assert.equal(s.titleSource, 'ai');
  assert.equal(s.cwd, 'C:\\Users\\me\\repo');
  assert.equal(s.gitBranch, 'feature/login');
  assert.equal(s.promptCount, 2);
  assert.equal(s.assistantCount, 4);
  assert.equal(s.firstPrompt, 'Why does login redirect to /home?');
  assert.equal(s.lastPrompt, 'Change it to /dashboard');
  assert.equal(s.model, 'claude-sonnet-4.5');
  assert.equal(s.version, '0.0.330');
  assert.equal(s.startTime, Date.parse('2026-10-01T10:00:00.000Z'));
  assert.equal(s.lastTime, Date.parse('2026-10-01T10:02:00.000Z'));
  assert.equal(s.usage, undefined);
  assert.match(s.searchText, /hard-coded in src\/router.ts/);
  assert.doesNotMatch(s.searchText, /injected|secret reasoning|Let me\n/);
});

test('real capture: generated name, auto model, internal model.* events ignored', () => {
  const realId = 'b380c8e3-1729-4e04-a560-1517aa38fb97';
  const realDir = path.join(__dirname, 'fixtures', 'copilot-cli', realId);
  const text = fs.readFileSync(path.join(realDir, 'events.jsonl'), 'utf8');
  const s = parseCopilotSession(text, 'f', realId, fs.readFileSync(path.join(realDir, 'workspace.yaml'), 'utf8'));
  assert.equal(s.title, 'Create Chat Session');
  assert.equal(s.titleSource, 'ai');
  assert.equal(s.cwd, 'C:\\Users\\bisch');
  assert.equal(s.promptCount, 1);
  assert.equal(s.assistantCount, 1);
  assert.equal(s.model, 'mai-code-1.1-flash');
  assert.equal(s.version, '1.0.92');
  assert.doesNotMatch(s.searchText, /session-title|current_datetime|GitHub Copilot CLI, a terminal/);
  const t = parseCopilotTranscript(text);
  assert.deepEqual(t.map((e) => e.role), ['user', 'assistant']);
  assert.equal(t[0].parts[0].text, 'This is a chat session');
  assert.match(t[1].parts[0].text, /^Hello! I’m ready to help/);
});

test('a session folder without events.jsonl parses as empty', () => {
  const s = parseCopilotSession('', 'f', 'd5b4ce53', 'id: d5b4ce53\ncwd: C:\\Users\\me\nuser_named: false\n');
  assert.equal(s.titleSource, 'none');
  assert.equal(s.cwd, 'C:\\Users\\me');
  assert.equal(s.promptCount + s.assistantCount, 0);
  assert.deepEqual(parseCopilotTranscript(''), []);
});

test('title order: user-named name > generated name or summary > first prompt; cwd falls back to session.start', () => {
  assert.equal(parseCopilotSession(events, 'f', ID, 'name: My session\nuser_named: true\nsummary: ignored\n').titleSource, 'custom');
  const generated = parseCopilotSession(events, 'f', ID, 'name: Generated\nuser_named: false\nsummary: ignored\n');
  assert.equal(generated.title, 'Generated');
  assert.equal(generated.titleSource, 'ai');
  const noYaml = parseCopilotSession(events, 'f', ID);
  assert.equal(noYaml.title, 'Why does login redirect to /home?');
  assert.equal(noYaml.titleSource, 'prompt');
  assert.equal(noYaml.cwd, 'C:\\Users\\me\\repo');
  const empty = parseCopilotSession(jsonl(ev('session.start', {})), 'f', 'x');
  assert.equal(empty.titleSource, 'none');
  assert.equal(empty.promptCount + empty.assistantCount, 0);
});

test('yaml reader handles quotes, comments and nested blocks', () => {
  const y = readYamlScalars('a: plain # note\nb: "q\\"uoted"\nc: \'it\'\'s\'\nnested:\n  inner: x\nlist:\n  - 1\nempty:\r\nd: C:\\path\\x\n');
  assert.deepEqual(y, { a: 'plain', b: 'q"uoted', c: "it's", d: 'C:\\path\\x' });
});

test('transcript: prompts, replies, tool calls with results; deltas and reasoning skipped', () => {
  const t = parseCopilotTranscript(events);
  assert.deepEqual(t.map((e) => e.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(t[0].parts[0].text, 'Why does login redirect to /home?');
  const a = t[1].parts;
  assert.deepEqual(a.map((p) => p.kind), ['text', 'tool_use', 'tool_use', 'text']);
  assert.equal(a[1].name, 'view');
  assert.equal(a[1].hint, 'src/router.ts');
  assert.deepEqual(a[1].result, { text: '1. export const home = "/home";', isError: false });
  assert.equal(a[2].name, 'bash');
  assert.deepEqual(a[2].result, { text: 'exit code 1', isError: true });
  const edit = t[3].parts[0];
  assert.deepEqual(edit.diff, { before: '/home', after: '/dashboard' });
  assert.equal(edit.result.text, 'File edited.');
  assert.ok(!JSON.stringify(t).includes('secret reasoning'));
  assert.ok(!JSON.stringify(t).includes('injected'));
});

test('orphan tool results and string arguments', () => {
  const t = parseCopilotTranscript(
    jsonl(
      ev('assistant.message', { messageId: 'm', content: '', toolRequests: [{ toolCallId: 'c', name: 'grep', arguments: '{"pattern":"foo"}' }] }),
      ev('tool.execution_complete', { toolCallId: 'zzz', success: true, result: 'loose' }),
    ),
  );
  assert.equal(t[0].parts[0].hint, 'foo');
  assert.deepEqual(t[1], { role: 'tool', timestamp: '2026-10-01T10:00:00.000Z', parts: [{ kind: 'tool_result', text: 'loose', isError: false }] });
});

test('search text is capped', () => {
  const big = 'x'.repeat(150_000);
  const s = parseCopilotSession(jsonl(ev('user.message', { content: big }), ev('assistant.message', { content: big })), 'f', 'x');
  assert.equal(s.searchText.length, MAX_SEARCH_TEXT);
  assert.equal(s.promptCount, 1);
});

test('same id in two sources gets distinct keys', () => {
  const c = parseSession('', 'f', 'p', ID);
  assert.equal(c.source, 'claude');
  assert.equal(c.key, `claude:${ID}`);
  assert.notEqual(c.key, parseCopilotSession('', 'f', ID).key);
});

test('fuzz: truncated and garbage input never throws', () => {
  let seed = 7;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  for (let i = 0; i < 300; i++) {
    let text = events.slice(0, rand(events.length));
    if (i % 3 === 0) {
      text += '\n{"type":"user.message","data":null}\n[1,2]\nnull\n{"type":5}\n{"type":"tool.execution_complete","data":{"error":{}}}';
    }
    if (i % 5 === 0) {
      const at = rand(text.length + 1);
      text = text.slice(0, at) + '\u0000}{' + text.slice(at);
    }
    const s = parseCopilotSession(text, 'f', 'x', i % 2 ? yaml.slice(0, rand(yaml.length)) : undefined);
    assert.ok(s.promptCount >= 0 && typeof s.title === 'string');
    assert.ok(Array.isArray(parseCopilotTranscript(text)));
  }
});

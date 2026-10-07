const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { rebuildChatSession, parseChatSession, parseChatTranscript } = require('../out/vscodeChatParser');

const fixtures = path.join(__dirname, 'fixtures', 'vscode-chat');
const LOG_ID = 'b1c2d3e4-1111-2222-3333-444455556666';
const LEGACY_ID = 'a0a0a0a0-0000-0000-0000-000000000001';
const log = fs.readFileSync(path.join(fixtures, `${LOG_ID}.jsonl`), 'utf8');
const legacy = fs.readFileSync(path.join(fixtures, `${LEGACY_ID}.json`), 'utf8');
const jsonl = (...recs) => recs.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

test('patch log replay: snapshot, set, push, splice index, unknown kinds', () => {
  const s = rebuildChatSession(log);
  assert.equal(s.customTitle, 'Auth walkthrough');
  assert.equal(s.requests.length, 2);
  const kinds = s.requests[0].response.map((p) => p.kind ?? 'md');
  assert.deepEqual(kinds, ['thinking', 'md', 'inlineReference', 'markdownContent', 'toolInvocationSerialized', 'markdownContent']);
  assert.equal(s.requests[0].response[5].content.value, ' It is used by the router.');
  assert.equal(s.requests[0].result.timings.totalElapsed, 5000);
  assert.equal(s.lastMessageDate, 1759312905000);
  assert.equal(s.whatever, undefined);
});

test('replay without a snapshot, with deletes and with a truncated last line', () => {
  const s = rebuildChatSession(
    jsonl(
      { kind: 2, k: ['requests'], v: [{ message: { text: 'a' } }, { message: { text: 'b' } }] },
      { kind: 1, k: ['requests', 1, 'response'], v: [{ value: 'hi' }] },
      { kind: 1, k: ['inputState', 'draft'], v: 'x' },
      { kind: 3, k: ['inputState', 'draft'] },
      { kind: 3, k: ['requests', 0] },
      '{"kind":2,"k":["requests"],"v":[{"message":{"text":"tru',
    ),
  );
  assert.deepEqual(s, { requests: [{ message: { text: 'b' }, response: [{ value: 'hi' }] }], inputState: {} });
});

test('legacy .json is read whole', () => {
  const s = rebuildChatSession(legacy);
  assert.equal(s.sessionId, LEGACY_ID);
  assert.equal(s.requests.length, 2);
});

test('session metadata from a patch log', () => {
  const s = parseChatSession(log, 'f', LOG_ID, 'C:\\repo');
  assert.equal(s.source, 'vscode-chat');
  assert.equal(s.key, `vscode-chat:${LOG_ID}`);
  assert.equal(s.projectDir, '');
  assert.equal(s.cwd, 'C:\\repo');
  assert.equal(s.title, 'Auth walkthrough');
  assert.equal(s.titleSource, 'custom');
  assert.equal(s.promptCount, 2);
  assert.equal(s.assistantCount, 2);
  assert.equal(s.firstPrompt, 'Explain #file:auth.ts');
  assert.equal(s.lastPrompt, 'Thanks');
  assert.equal(s.model, 'copilot/gpt-5');
  assert.equal(s.startTime, 1759312800000);
  assert.equal(s.lastTime, 1759312905000);
  assert.equal(s.usage, undefined);
  assert.match(s.searchText, /exports \*\*login\*\*/);
  assert.doesNotMatch(s.searchText, /Considering|Overwritten/);
});

test('legacy session: first prompt as title, canceled request', () => {
  const s = parseChatSession(legacy, 'f', LEGACY_ID);
  assert.equal(s.title, 'What is a monad?');
  assert.equal(s.titleSource, 'prompt');
  assert.equal(s.promptCount, 2);
  assert.equal(s.assistantCount, 1);
  assert.equal(s.model, 'gpt-4.1');
  assert.equal(s.cwd, undefined);
  assert.equal(s.lastTime, 1759000060000);
});

test('real capture: splice-indexed response, Auto model, empty thinking skipped', () => {
  const realId = '63869299-99f3-491c-89c4-bb361f7147f7';
  const text = fs.readFileSync(path.join(fixtures, `${realId}.jsonl`), 'utf8');
  const raw = rebuildChatSession(text);
  // The kind 2 line with i=2 replaces the snapshot's "Optimizing tool selection" progress part.
  assert.deepEqual(
    raw.requests[0].response.map((p) => p.kind ?? 'md'),
    ['mcpServersStarting', 'autoModeResolution', 'progressTaskSerialized', 'md', 'thinking', 'thinking', 'md'],
  );
  assert.equal(raw.requests[0].response[2].content.value, 'Optimized tool selection');
  const s = parseChatSession(text, 'f', realId, 'C:\\Users\\bisch\\claude-sessions-vscode');
  assert.equal(s.title, 'Chat session overview');
  assert.equal(s.titleSource, 'custom');
  assert.equal(s.promptCount, 1);
  assert.equal(s.assistantCount, 1);
  assert.equal(s.model, 'mai-code-1.1-flash');
  assert.equal(s.startTime, 1791335649005);
  assert.equal(s.lastTime, 1791335676160);
  assert.doesNotMatch(s.searchText, /Optimiz|current date/);
  const t = parseChatTranscript(text);
  assert.deepEqual(t.map((e) => e.role), ['user', 'assistant']);
  assert.equal(t[0].parts[0].text, 'This is a chat session');
  // Empty thinking parts don't split the reply.
  assert.deepEqual(t[1].parts.map((p) => p.kind), ['text']);
  assert.match(t[1].parts[0].text, /^I will pick up .*here\.\n\n## Ready to help/s);
});

test('an empty chat has no prompts or replies even with a title', () => {
  const s = parseChatSession(jsonl({ kind: 0, v: { requests: [], customTitle: 'Named' } }), 'f', 'x');
  assert.equal(s.title, 'Named');
  assert.equal(s.promptCount, 0);
  assert.equal(s.assistantCount, 0);
  assert.equal(parseChatSession('', 'f', 'x').titleSource, 'none');
});

test('transcript maps markdown, inline references, thinking and tool calls', () => {
  const t = parseChatTranscript(log);
  assert.deepEqual(t.map((e) => e.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(t[0].timestamp, new Date(1759312810000).toISOString());
  const parts = t[1].parts;
  assert.deepEqual(parts.map((p) => p.kind), ['thinking', 'text', 'tool_use', 'text']);
  assert.equal(parts[0].text, 'Considering the file');
  assert.equal(parts[1].text, 'The file `auth.ts` exports **login**.');
  assert.equal(parts[2].name, 'copilot_readFile');
  assert.equal(parts[2].hint, 'Read auth.ts');
  assert.match(parts[2].input, /"filePath"/);
  assert.deepEqual(parts[2].result, { text: 'export function login() {}', isError: false });
  assert.equal(parts[3].text, ' It is used by the router.');
  const lt = parseChatTranscript(legacy);
  assert.equal(lt[1].parts[0].text, 'A monoid in the category of endofunctors.');
  assert.equal(lt[3].parts[0].text, '> Error: Request was canceled');
});

test('a tool call as VS Code saves it: file link as the hint, no output', () => {
  const part = {
    kind: 'toolInvocationSerialized',
    invocationMessage: { value: 'Reading [](file:///c%3A/Users/me/repo/README.md)' },
    pastTenseMessage: { value: 'Read [](file:///c%3A/Users/me/repo/README.md), lines 1 to 50 of [notes](file:///c%3A/n.md)' },
    isComplete: true,
    toolCallId: 'call_1',
    toolId: 'copilot_readFile',
  };
  const t = parseChatTranscript(jsonl({ kind: 0, v: { requests: [{ message: { text: 'read it' }, response: [part], timestamp: 1 }] } }));
  const tool = t[1].parts[0];
  assert.equal(tool.hint, 'Read c:/Users/me/repo/README.md, lines 1 to 50 of notes');
  assert.equal(tool.result.isError, false);
  assert.match(tool.result.text, /did not save/);
  // Still running when the window closed: no result.
  const open = parseChatTranscript(jsonl({ kind: 0, v: { requests: [{ message: { text: 'x' }, response: [{ ...part, isComplete: false }] }] } }));
  assert.equal(open[1].parts[0].result, undefined);
});

test('fuzz: truncated and garbage input never throws', () => {
  let seed = 11;
  const rand = (n) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  const junk = [
    '{"kind":2,"k":["requests",9,"response"],"v":[1]}',
    '{"kind":1,"k":[],"v":5}',
    '{"kind":2,"k":[],"v":[1]}',
    '{"kind":1,"k":["requests",0,"message"],"v":null}',
    '{"kind":2,"k":["customTitle"],"v":"x","i":99}',
    '{"kind":3,"k":["requests",-1]}',
    '{"kind":1,"k":[{"bad":1}],"v":1}',
    '{"kind":0,"v":null}',
    '{"kind":1,"k":["requests"],"v":"not an array"}',
  ];
  for (let i = 0; i < 300; i++) {
    const src = i % 4 === 0 ? legacy : log;
    let text = src.slice(0, rand(src.length + 1));
    for (let j = 0; j < 3; j++) {
      text += '\n' + junk[rand(junk.length)];
    }
    const s = parseChatSession(text, 'f', 'x');
    assert.ok(s.promptCount >= 0 && typeof s.title === 'string');
    assert.ok(Array.isArray(parseChatTranscript(text)));
  }
});

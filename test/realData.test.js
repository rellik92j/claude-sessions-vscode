// Smoke test against the real ~/.claude/projects folder (skipped when it does not exist).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { SessionStore, defaultProjectsDir } = require('../out/sessionStore');
const { parseTranscript } = require('../out/sessionParser');

const dir = defaultProjectsDir();
test('loads real sessions', { skip: !fs.existsSync(dir) }, async () => {
  const store = new SessionStore(dir);
  let t = Date.now();
  const sessions = await store.load();
  const cold = Date.now() - t;
  t = Date.now();
  await store.load();
  const warm = Date.now() - t;
  console.log(`${sessions.length} sessions; cold ${cold}ms, cached ${warm}ms`);
  for (const s of sessions.slice(0, 50)) {
    console.log(`  ${new Date(s.lastTime).toISOString().slice(0, 16)}  [${s.titleSource}] ${s.title}  (${s.cwd}, ${s.promptCount} prompts)`);
  }
  assert.ok(sessions.every((s) => s.title && s.id));
  for (let i = 1; i < sessions.length; i++) {
    assert.ok((sessions[i - 1].lastTime ?? 0) >= (sessions[i].lastTime ?? 0), 'sorted newest first');
  }
  const biggest = sessions.reduce((a, b) => (fs.statSync(a.filePath).size > fs.statSync(b.filePath).size ? a : b));
  t = Date.now();
  const tr = parseTranscript(fs.readFileSync(biggest.filePath, 'utf8'));
  console.log(`transcript of largest session: ${tr.length} entries in ${Date.now() - t}ms`);
  assert.ok(tr.length > 0);
});

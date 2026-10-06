const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSession } = require('../out/sessionParser');
const { buildOverview } = require('../out/overview');
const { dayKey } = require('../out/usage');
const { normalizePath } = require('../out/format');

const jsonl = (...recs) => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
const DAY = 24 * 60 * 60 * 1000;
// Noon, so a day either side never crosses midnight in any time zone offset that matters here.
const now = new Date(2026, 9, 5, 12).getTime();
const at = (daysAgo) => new Date(now - daysAgo * DAY).toISOString();

/** A session in `cwd` with one Opus 5.5 request per entry of `days` (days ago), each $4 of input. */
function session(id, cwd, days, model = 'claude-opus-5-5') {
  const recs = [{ type: 'user', message: { content: `prompt ${id}` }, cwd, timestamp: at(days[0]) }];
  days.forEach((d, i) =>
    recs.push({
      type: 'assistant',
      message: { id: `${id}-${i}`, model, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1_000_000, output_tokens: 0 } },
      timestamp: at(d),
    }),
  );
  return parseSession(jsonl(...recs), `${id}.jsonl`, 'p', id);
}

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≉ ${b}`);

test('usage records cost by day and model', () => {
  const s = session('a', '/repo', [3, 3, 1]);
  assert.deepEqual(Object.keys(s.usage.daily).sort(), [dayKey(now - 3 * DAY), dayKey(now - DAY)]);
  close(s.usage.daily[dayKey(now - 3 * DAY)]['opus-5-5'], 8);
});

test('overview: range splits a long session, totals, projects, models and top sessions', () => {
  const sessions = [
    session('a', '/repo', [40, 2]), // $4 old, $4 recent
    session('b', '/repo', [1], 'claude-sonnet-5-5'), // $2
    session('c', '/other', [0, 0]), // $8
    session('d', '/old', [200]),
  ];
  const o = buildOverview(sessions, 7, now);
  assert.equal(o.from, dayKey(now - 6 * DAY));
  assert.equal(o.to, dayKey(now));
  assert.equal(o.buckets.length, 7);
  assert.equal(o.bucketDays, 1);
  assert.equal(o.totals.sessions, 3);
  assert.equal(o.totals.projects, 2);
  assert.equal(o.totals.prompts, 3);
  close(o.totals.cost, 14);
  assert.equal(o.totals.activeDays, 3);
  close(o.buckets[6].cost, 8);
  assert.equal(o.buckets[6].sessions, 1);
  assert.deepEqual(o.projects.map((p) => [p.name, p.sessions, p.cost]), [['other', 1, 8], ['repo', 2, 6]]);
  assert.deepEqual(o.models.map((m) => m.model), ['opus-5-5', 'sonnet-5-5']);
  close(o.models[1].cost, 2);
  assert.deepEqual(o.topSessions.map((s) => s.id), ['c', 'a', 'b']);
  // Bars split by model and project; colors follow all-time cost, so they hold when the range changes.
  close(o.buckets[5].byModel['sonnet-5-5'], 2);
  close(o.buckets[4].byProject[normalizePath('/repo')], 4);
  assert.deepEqual(o.series.model, ['opus-5-5', 'sonnet-5-5']);
  assert.deepEqual(o.series.project, [normalizePath('/repo'), normalizePath('/other'), normalizePath('/old')]);
  close(o.topSessions[1].cost, 4);
  assert.deepEqual(o.recentSessions.map((s) => s.id), ['c', 'b', 'a']);

  const all = buildOverview(sessions, 0, now);
  assert.equal(all.from, dayKey(now - 200 * DAY));
  assert.equal(all.bucketDays, 7, 'long spans are charted by week');
  assert.equal(all.buckets.length, Math.ceil(201 / 7));
  assert.equal(all.totals.sessions, 4);
  close(all.totals.cost, 4 * 2 + 2 + 8 + 4);
  close(all.buckets.reduce((n, b) => n + b.cost, 0), all.totals.cost);
});

test('overview: nothing to show', () => {
  const o = buildOverview([], 0, now);
  assert.equal(o.totals.sessions, 0);
  assert.equal(o.buckets.length, 1);
});

test('overview: project filter', () => {
  const sessions = [session('a', '/repo', [2]), session('b', '/other', [1]), session('c', '/third', [0])];
  const key = (p) => normalizePath(p);
  const o = buildOverview(sessions, 7, now, [key('/repo'), key('/third'), key('/gone')]);
  assert.deepEqual(o.filter, [key('/repo'), key('/third')], 'projects that no longer exist drop out');
  assert.equal(o.totals.sessions, 2);
  close(o.totals.cost, 8);
  assert.deepEqual(o.projects.map((p) => p.name).sort(), ['repo', 'third']);
  assert.deepEqual(o.allProjects.map((p) => p.name), ['third', 'other', 'repo'], 'every project, most recent first');
  assert.equal(buildOverview(sessions, 7, now).totals.sessions, 3, 'no filter: all projects');
  assert.equal(buildOverview(sessions, 7, now, []).totals.sessions, 0, 'an empty filter shows nothing');
});

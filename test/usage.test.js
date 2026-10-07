const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSession } = require('../out/sessionParser');
const { modelKey, UsageCollector } = require('../out/usage');
const { formatTokens, formatUsd } = require('../out/format');

const jsonl = (...recs) => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';
const asst = (id, usage, extra = {}) => ({
  type: 'assistant',
  message: { id, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], usage },
  timestamp: '2026-10-01T10:00:00.000Z',
  ...extra,
});
const usage = (input, w5, w1h, read, output, extra = {}) => ({
  input_tokens: input,
  cache_creation_input_tokens: w5 + w1h,
  cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1h },
  cache_read_input_tokens: read,
  output_tokens: output,
  ...extra,
});
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≉ ${b}`);

test('model ids map to price keys', () => {
  assert.equal(modelKey('claude-opus-5-5'), 'opus-5-5');
  assert.equal(modelKey('claude-opus-4-1-20250805'), 'opus-4-1');
  assert.equal(modelKey('claude-3-5-haiku-20241022'), '3-5-haiku');
  assert.equal(modelKey('us.anthropic.claude-sonnet-4-5-20250929-v1:0'), 'sonnet-4-5');
  assert.equal(modelKey('claude-opus-5-5[1m]'), 'opus-5-5');
});

test('cost: each token type at its own rate, blocks of one message counted once', () => {
  // Opus 5.5: $4 in, $20 out, cache reads 0.05x, writes 1.25x / 2x.
  const u = usage(1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000);
  const s = parseSession(jsonl(asst('m1', u), asst('m1', u)), 'f', 'p', 'id').usage;
  assert.equal(s.requests, 1);
  close(s.costs.input, 4);
  close(s.costs.cacheWrite5m, 5);
  close(s.costs.cacheWrite1h, 8);
  close(s.costs.cacheRead, 0.2);
  close(s.costs.output, 20);
  close(s.cost, 37.2);
  assert.equal(s.tokens.cacheRead, 1_000_000);
});

test('fast mode, US inference and web searches', () => {
  const fast = parseSession(jsonl(asst('m1', usage(1_000_000, 0, 0, 0, 0, { speed: 'fast', inference_geo: 'us' }))), 'f', 'p', 'id').usage;
  close(fast.cost, 4 * 2 * 1.1);
  const search = parseSession(jsonl(asst('m1', usage(0, 0, 0, 0, 0, { server_tool_use: { web_search_requests: 3 } }))), 'f', 'p', 'id').usage;
  close(search.cost, 0.03);
});

test('Haiku 5.5 bills prompts over 100K tokens at the higher tier', () => {
  const haiku = (id, u) => {
    const r = asst(id, u);
    r.message.model = 'claude-haiku-5-5';
    return r;
  };
  // Up to 100K: $0.10 in, $0.50 out, cache reads $0.01.
  const short = parseSession(jsonl(haiku('m1', usage(40_000, 0, 0, 60_000, 1_000_000))), 'f', 'p', 'id').usage;
  close(short.costs.input, 0.004);
  close(short.costs.cacheRead, 0.0006);
  close(short.costs.output, 0.5);
  // Over 100K, cache reads and writes included: $0.50 in, $2.50 out, cache reads $0.05, 5m writes $0.625.
  const long = parseSession(jsonl(haiku('m1', usage(40_000, 1, 0, 60_000, 1_000_000))), 'f', 'p', 'id').usage;
  close(long.costs.input, 0.02);
  close(long.costs.cacheRead, 0.003);
  close(long.costs.cacheWrite5m, 0.000000625);
  close(long.costs.output, 2.5);
  assert.equal(long.context.limit, 1_000_000);
});

test('subagents add to cost but not to context or cache', () => {
  const main = asst('m1', usage(10, 0, 1000, 5000, 100), { timestamp: '2026-10-01T10:00:00.000Z' });
  const side = asst('s1', usage(10, 50_000, 0, 0, 100), { isSidechain: true, timestamp: '2026-10-01T11:00:00.000Z' });
  const sub = jsonl(asst('a1', usage(1_000_000, 0, 0, 0, 0)));
  const s = parseSession(jsonl(main, side), 'f', 'p', 'id', [sub]).usage;
  assert.equal(s.requests, 3);
  assert.ok(s.subagentCost > 4);
  assert.deepEqual(s.context, { tokens: 6010, limit: 1_000_000 });
  assert.deepEqual(s.cache, { lastRequest: Date.parse('2026-10-01T10:00:00.000Z'), ttlMs: 3_600_000 });
});

test('context: last main request; cache TTL from the last write', () => {
  const s = parseSession(
    jsonl(
      asst('m1', usage(5, 2000, 0, 0, 10), { timestamp: '2026-10-01T10:00:00.000Z' }),
      asst('m2', usage(5, 0, 0, 2000, 10), { timestamp: '2026-10-01T10:03:00.000Z', effort: 'high' }),
    ),
    'f', 'p', 'id',
  ).usage;
  assert.equal(s.context.tokens, 2005);
  assert.deepEqual(s.cache, { lastRequest: Date.parse('2026-10-01T10:03:00.000Z'), ttlMs: 300_000 });
  assert.equal(s.effort, 'high');
});

test('older models have a 200K window unless the log shows more; unknown models are not costed', () => {
  const haiku = asst('m1', usage(150_000, 0, 0, 0, 0));
  haiku.message.model = 'claude-haiku-4-5';
  assert.equal(parseSession(jsonl(haiku), 'f', 'p', 'id').usage.context.limit, 200_000);
  const big = asst('m1', usage(300_000, 0, 0, 0, 0));
  big.message.model = 'claude-sonnet-4-5-20250929';
  assert.equal(parseSession(jsonl(big), 'f', 'p', 'id').usage.context.limit, 1_000_000);
  const odd = asst('m1', usage(1000, 0, 0, 0, 0));
  odd.message.model = 'some-other-model';
  const s = parseSession(jsonl(odd), 'f', 'p', 'id').usage;
  assert.deepEqual(s.unpriced, ['some-other-model']);
  assert.equal(s.cost, 0);
  assert.equal(s.tokens.input, 1000);
});

test('no usage: synthetic messages and logs without usage', () => {
  const synthetic = asst('m1', usage(5, 0, 0, 0, 0));
  synthetic.message.model = '<synthetic>';
  assert.equal(parseSession(jsonl(synthetic), 'f', 'p', 'id').usage, undefined);
  assert.equal(new UsageCollector().summary(), undefined);
});

test('token and dollar formatting', () => {
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(1234), '1.2k');
  assert.equal(formatTokens(312_400), '312k');
  assert.equal(formatTokens(1_234_567), '1.23M');
  assert.equal(formatTokens(1_000_000), '1M');
  assert.equal(formatUsd(0.004), '<$0.01');
  assert.equal(formatUsd(12.345), '$12.35');
});

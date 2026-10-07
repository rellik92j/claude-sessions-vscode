const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../scripts/sync-prices.mjs')).href);

/** A LiteLLM entry from USD-per-million rates. */
const entry = (input, output, read, w5, w1h, extra = {}) => ({
  litellm_provider: 'anthropic',
  input_cost_per_token: input / 1e6,
  output_cost_per_token: output / 1e6,
  cache_read_input_token_cost: read / 1e6,
  cache_creation_input_token_cost: w5 / 1e6,
  cache_creation_input_token_cost_above_1hr: w1h / 1e6,
  max_input_tokens: 1_000_000,
  ...extra,
});
const filler = Object.fromEntries(['a', 'b', 'c', 'd'].map((n) => [`claude-filler-${n}`, entry(1, 5, 0.1, 1.25, 2)]));

test('sync: ids map to price keys; other providers are ignored', async () => {
  const { priceKey } = await load();
  assert.equal(priceKey('claude-opus-4-1-20250805'), 'opus-4-1');
  assert.equal(priceKey('claude-haiku-5-5'), 'haiku-5-5');
  assert.equal(priceKey('bedrock/claude-haiku-5-5'), undefined);
});

test('sync: converts rates, fast mode and the prompt-length tier', async () => {
  const { toPrice } = await load();
  const tier = {
    input_cost_per_token_above_100k_tokens: 0.5e-6,
    output_cost_per_token_above_100k_tokens: 2.5e-6,
    cache_read_input_token_cost_above_100k_tokens: 0.05e-6,
    cache_creation_input_token_cost_above_100k_tokens: 0.625e-6,
    cache_creation_input_token_cost_above_1hr_above_100k_tokens: 1e-6,
    input_cost_per_token_above_100k_tokens_batches: 0.25e-6,
  };
  assert.deepEqual(toPrice(entry(0.1, 0.5, 0.01, 0.125, 0.2, tier)), {
    input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2, context: 1_000_000,
    long: { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite5m: 0.625, cacheWrite1h: 1 },
  });
  assert.equal(toPrice(entry(4, 20, 0.2, 5, 8, { supports_fast_mode: true })).fast, true);
  assert.equal(toPrice({ litellm_provider: 'anthropic', input_cost_per_token: 1e-6 }), undefined);
});

test('sync: updates and adds models, keeps ours that LiteLLM dropped and our context windows', async () => {
  const { merge, summary } = await load();
  const ours = {
    'opus-4-1': { input: 15, output: 75, cacheRead: 1.5, cacheWrite5m: 18.75, cacheWrite1h: 30, context: 200_000 },
    'sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4, context: 200_000 },
  };
  const feed = {
    ...filler,
    'claude-sonnet-5-5': entry(2, 10, 0.1, 2.5, 4),
    'claude-sonnet-5-5-20260901': entry(9, 9, 9, 9, 9),
    'claude-haiku-5-5': entry(0.1, 0.5, 0.01, 0.125, 0.2),
    'azure_ai/claude-haiku-5-5': entry(9, 9, 9, 9, 9, { litellm_provider: 'azure_ai' }),
  };
  const { next, changes } = merge(ours, feed);
  assert.deepEqual(next['opus-4-1'], ours['opus-4-1']);
  assert.equal(next['sonnet-5-5'].cacheRead, 0.1);
  assert.equal(next['sonnet-5-5'].context, 200_000);
  assert.equal(next['haiku-5-5'].input, 0.1);
  const s = summary(changes);
  assert.match(s, /\| `sonnet-5-5` \| cacheRead \| 0\.2 \| 0\.1 \|/);
  assert.match(s, /\| `haiku-5-5` \| new model \|/);
  assert.equal(summary(merge(next, feed).changes), 'No price changes.\n');
});

test('sync: refuses a feed with almost no Anthropic models', async () => {
  const { merge } = await load();
  assert.throws(() => merge({}, { 'claude-haiku-5-5': entry(0.1, 0.5, 0.01, 0.125, 0.2) }), /format changed/);
});

// Refreshes src/prices.json from LiteLLM's community price map, which tracks Anthropic's list prices
// (https://platform.claude.com/docs/en/about-claude/pricing). Prices LiteLLM no longer lists, such as retired
// models, are kept. Prints a Markdown summary of the changes for the pull request body.
//
//   node scripts/sync-prices.mjs [path-or-url-of-litellm-json]

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const PRICES_FILE = fileURLToPath(new URL('../src/prices.json', import.meta.url));

/** Our rate field -> LiteLLM's per-token field. */
const FIELDS = {
  input: 'input_cost_per_token',
  output: 'output_cost_per_token',
  cacheRead: 'cache_read_input_token_cost',
  cacheWrite5m: 'cache_creation_input_token_cost',
  cacheWrite1h: 'cache_creation_input_token_cost_above_1hr',
};

/** USD per token -> USD per million tokens, without float noise. */
const perM = (v) => Math.round(v * 1e12) / 1e6;

/** "claude-opus-4-1-20250805" -> "opus-4-1"; undefined for ids that are not plain Anthropic models. */
export function priceKey(id) {
  const m = /^claude-(.+?)(-\d{8})?$/.exec(id);
  return m ? m[1] : undefined;
}

/** One LiteLLM entry in our format, or undefined when it lacks the basic rates. */
export function toPrice(e) {
  const rates = (suffix) => {
    const r = {};
    for (const [ours, theirs] of Object.entries(FIELDS)) {
      const v = e[theirs + suffix];
      if (typeof v !== 'number') {
        return undefined;
      }
      r[ours] = perM(v);
    }
    return r;
  };
  const base = rates('');
  if (!base || typeof e.max_input_tokens !== 'number') {
    return undefined;
  }
  const p = { ...base, context: e.max_input_tokens };
  if (e.supports_fast_mode) {
    p.fast = true;
  }
  // Prompt-length tiers appear as "<field>_above_<N>k_tokens"; we model one, the lowest.
  const tiers = Object.keys(e)
    .map((k) => /^input_cost_per_token_above_(\d+)k_tokens$/.exec(k)?.[1])
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b);
  if (tiers.length) {
    const long = rates(`_above_${tiers[0]}k_tokens`);
    if (long) {
      p.long = { above: tiers[0] * 1000, ...long };
    }
  }
  return p;
}

/** Merges LiteLLM's Anthropic entries into ours; returns the new table and a list of changes. */
export function merge(ours, litellm) {
  const theirs = {};
  // Undated ids win over dated snapshots of the same model.
  const ids = Object.keys(litellm).sort((a, b) => b.length - a.length);
  for (const id of ids) {
    const e = litellm[id];
    const key = e?.litellm_provider === 'anthropic' ? priceKey(id) : undefined;
    const p = key && toPrice(e);
    if (p) {
      theirs[key] = p;
    }
  }
  if (Object.keys(theirs).length < 5) {
    throw new Error(`Only ${Object.keys(theirs).length} Anthropic models found; has LiteLLM's format changed?`);
  }
  const next = { ...ours };
  const changes = [];
  for (const [key, p] of Object.entries(theirs)) {
    const old = ours[key];
    // LiteLLM lists the largest window a model can run with (Sonnet 4.5: 1M in beta); ours is the default one,
    // and the extension already widens it when a session's log shows more.
    if (old) {
      p.context = old.context;
    }
    if (!old) {
      changes.push({ key, added: true, fields: [] });
    } else if (JSON.stringify(old) !== JSON.stringify(p)) {
      const fields = [...new Set([...Object.keys(old), ...Object.keys(p)])]
        .filter((f) => JSON.stringify(old[f]) !== JSON.stringify(p[f]))
        .map((f) => ({ field: f, from: old[f], to: p[f] }));
      changes.push({ key, added: false, fields });
    } else {
      continue;
    }
    next[key] = p;
  }
  return { next, changes };
}

const show = (v) => (v === undefined ? '—' : typeof v === 'object' ? `\`${JSON.stringify(v)}\`` : String(v));

export function summary(changes) {
  if (!changes.length) {
    return 'No price changes.\n';
  }
  const rows = changes.flatMap((c) =>
    c.added ? [`| \`${c.key}\` | new model | | |`] : c.fields.map((f) => `| \`${c.key}\` | ${f.field} | ${show(f.from)} | ${show(f.to)} |`),
  );
  return ['| Model | Field | Was | Now |', '| --- | --- | --- | --- |', ...rows, ''].join('\n');
}

async function main() {
  const src = process.argv[2] ?? SOURCE;
  const text = /^https?:/.test(src) ? await (await fetch(src)).text() : await readFile(src, 'utf8');
  const ours = JSON.parse(await readFile(PRICES_FILE, 'utf8'));
  const { next, changes } = merge(ours, JSON.parse(text));
  await writeFile(PRICES_FILE, JSON.stringify(next, null, 2) + '\n');
  process.stdout.write(summary(changes));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

// Token usage, API-priced cost, context fill and prompt-cache state from Claude Code session logs.
// No VS Code imports here so it can be unit-tested with plain Node.

import prices from './prices.json';

/** USD per million tokens. */
interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

interface Price extends Rates {
  /** Context window in tokens. */
  context: number;
  /** Fast mode bills at twice the standard rates on the models that offer it. */
  fast?: boolean;
  /** Rates for prompts (input plus cache reads and writes) over `above` tokens. */
  long?: Rates & { above: number };
}

const M = 1_000_000;
const K200 = 200_000;

// Claude API list prices (https://platform.claude.com/docs/en/about-claude/pricing), keyed by model id without the
// "claude-" prefix and date suffix. scripts/sync-prices.mjs refreshes them from LiteLLM's price map; models it no
// longer lists, such as retired ones, are kept.
const PRICES: Record<string, Price> = prices;

const WEB_SEARCH_PRICE = 0.01;
const TTL_5M = 5 * 60 * 1000;
const TTL_1H = 60 * 60 * 1000;

/** "claude-opus-4-1-20250805", "us.anthropic.claude-sonnet-4-5-20250929-v1:0" or "claude-opus-5-5[1m]" -> price key. */
export function modelKey(model: string): string {
  let m = model.toLowerCase();
  const i = m.lastIndexOf('claude-');
  if (i >= 0) {
    m = m.slice(i + 'claude-'.length);
  }
  return m
    .replace(/\[.*\]$/, '')
    .replace(/@.*$/, '')
    .replace(/-v\d+(:\d+)?$/, '')
    .replace(/-\d{8}$/, '');
}

/** Local calendar day of a time, as "2026-10-05". */
export function dayKey(time: number): string {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function priceFor(model: string): Price | undefined {
  return PRICES[modelKey(model)];
}

export interface TokenCounts {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
}

export interface UsageSummary {
  /** Tokens across the whole session, subagents included. */
  tokens: TokenCounts;
  /** What those tokens would cost at Claude API prices, by category (USD). */
  costs: TokenCounts & { webSearch: number };
  cost: number;
  /** Part of `cost` spent by subagents. */
  subagentCost: number;
  /** Distinct API requests. */
  requests: number;
  /** Models seen with no known price; their tokens are counted but not costed. */
  unpriced: string[];
  /** How full the context window was at the last main-thread request. */
  context?: { tokens: number; limit: number };
  /** Time of the last main-thread request and the TTL of the cache it was using; the cache expires at the sum. */
  cache?: { lastRequest: number; ttlMs: number };
  /** Effort level of the last request, when the log records it. */
  effort?: string;
  /** Cost by local day ("2026-10-05") and model price key, for the overview; requests with no time are left out. */
  daily: Record<string, Record<string, number>>;
}

interface Request {
  model: string;
  usage: any;
  speed?: string;
  geo?: string;
  time?: number;
  subagent: boolean;
}

const zero = (): TokenCounts => ({ input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 });
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Splits a request's cache writes by TTL; logs from before the breakdown existed count as 5-minute writes. */
function writes(usage: any): { w5: number; w1h: number } {
  const total = num(usage.cache_creation_input_tokens);
  const split = usage.cache_creation;
  if (split && typeof split === 'object') {
    const w1h = num(split.ephemeral_1h_input_tokens);
    return { w5: Math.max(0, total - w1h), w1h };
  }
  return { w5: total, w1h: 0 };
}

/**
 * Collects the usage of every API request in a session. Claude Code logs one line per content block, each repeating
 * the message's usage, so requests are keyed by message id.
 */
export class UsageCollector {
  private readonly requests = new Map<string, Request>();
  private effort: string | undefined;

  /** Adds an assistant record; `subagent` for sidechain records and subagent logs. */
  add(r: any, subagent: boolean): void {
    const msg = r?.message;
    const usage = msg?.usage;
    const model = msg?.model;
    if (!usage || typeof model !== 'string' || model.startsWith('<')) {
      return;
    }
    const id = msg.id ?? r.requestId ?? r.uuid;
    if (typeof id !== 'string') {
      return;
    }
    const t = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
    const prev = this.requests.get(id);
    this.requests.set(id, {
      model,
      usage,
      speed: usage.speed,
      geo: usage.inference_geo,
      // The first block's time is closest to when the request was made.
      time: prev?.time ?? (Number.isNaN(t) ? undefined : t),
      subagent,
    });
    if (!subagent && typeof r.effort === 'string') {
      this.effort = r.effort;
    }
  }

  summary(): UsageSummary | undefined {
    if (!this.requests.size) {
      return undefined;
    }
    const tokens = zero();
    const costs = { ...zero(), webSearch: 0 };
    let subagentCost = 0;
    const daily: Record<string, Record<string, number>> = {};
    const unpriced = new Set<string>();
    let last: Request | undefined;
    let ttlMs: number | undefined;

    for (const req of this.requests.values()) {
      const u = req.usage;
      const { w5, w1h } = writes(u);
      const t: TokenCounts = {
        input: num(u.input_tokens),
        cacheWrite5m: w5,
        cacheWrite1h: w1h,
        cacheRead: num(u.cache_read_input_tokens),
        output: num(u.output_tokens),
      };
      for (const k of Object.keys(tokens) as (keyof TokenCounts)[]) {
        tokens[k] += t[k];
      }
      const p = priceFor(req.model);
      const searches = num(u.server_tool_use?.web_search_requests);
      let cost = searches * WEB_SEARCH_PRICE;
      costs.webSearch += searches * WEB_SEARCH_PRICE;
      if (p) {
        const prompt = t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead;
        const r: Rates = p.long && prompt > p.long.above ? p.long : p;
        const mult = (req.speed === 'fast' && p.fast ? 2 : 1) * (req.geo === 'us' ? 1.1 : 1);
        const c: TokenCounts = {
          input: (t.input * r.input * mult) / M,
          cacheWrite5m: (t.cacheWrite5m * r.cacheWrite5m * mult) / M,
          cacheWrite1h: (t.cacheWrite1h * r.cacheWrite1h * mult) / M,
          cacheRead: (t.cacheRead * r.cacheRead * mult) / M,
          output: (t.output * r.output * mult) / M,
        };
        for (const k of Object.keys(c) as (keyof TokenCounts)[]) {
          costs[k] += c[k];
          cost += c[k];
        }
      } else {
        unpriced.add(req.model);
      }
      if (req.time !== undefined && cost > 0) {
        const day = (daily[dayKey(req.time)] ??= {});
        const key = modelKey(req.model);
        day[key] = (day[key] ?? 0) + cost;
      }
      if (req.subagent) {
        subagentCost += cost;
        continue;
      }
      last = req;
      if (w5 + w1h > 0) {
        ttlMs = w1h > 0 ? TTL_1H : TTL_5M;
      }
    }

    const cost = costs.input + costs.cacheWrite5m + costs.cacheWrite1h + costs.cacheRead + costs.output + costs.webSearch;
    const summary: UsageSummary = { tokens, costs, cost, subagentCost, requests: this.requests.size, unpriced: [...unpriced], effort: this.effort, daily };
    if (last) {
      const u = last.usage;
      const used = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
      const limit = priceFor(last.model)?.context ?? K200;
      // Older models could run with a 1M window (beta); never show more than 100%.
      summary.context = { tokens: used, limit: used > limit ? M : limit };
      if (last.time !== undefined && ttlMs !== undefined) {
        summary.cache = { lastRequest: last.time, ttlMs };
      }
    }
    return summary;
  }
}

// Token usage, API-priced cost, context fill and prompt-cache state from Claude Code session logs.
// No VS Code imports here so it can be unit-tested with plain Node.

/** USD per million tokens. Cache writes are 1.25x (5 minutes) and 2x (1 hour) the input price. */
interface Price {
  input: number;
  output: number;
  cacheRead: number;
  /** Context window in tokens. */
  context: number;
  /** Fast mode bills at twice the standard rates on the models that offer it. */
  fast?: boolean;
}

const M = 1_000_000;
const K200 = 200_000;
const price = (input: number, output: number, readMultiplier: number, context: number, fast = false): Price => ({
  input,
  output,
  cacheRead: input * readMultiplier,
  context,
  fast,
});

// From https://platform.claude.com/docs/en/about-claude/pricing (October 2026), keyed by model id without the
// "claude-" prefix and date suffix.
const PRICES: Record<string, Price> = {
  'fable-5-1': price(10, 50, 0.025, M),
  'mythos-5-1': price(10, 50, 0.025, M),
  'fable-5': price(10, 50, 0.1, M),
  'mythos-5': price(10, 50, 0.1, M),
  'opus-5-5': price(4, 20, 0.05, M, true),
  'opus-5': price(5, 25, 0.1, M, true),
  'opus-4-8': price(5, 25, 0.1, M, true),
  'opus-4-7': price(5, 25, 0.1, M),
  'opus-4-6': price(5, 25, 0.1, M),
  'opus-4-5': price(5, 25, 0.1, K200),
  'opus-4-1': price(15, 75, 0.1, K200),
  'opus-4': price(15, 75, 0.1, K200),
  'sonnet-5-5': price(2, 10, 0.1, M),
  'sonnet-5': price(2, 10, 0.1, M),
  'sonnet-4-6': price(3, 15, 0.1, M),
  'sonnet-4-5': price(3, 15, 0.1, K200),
  'sonnet-4': price(3, 15, 0.1, K200),
  '3-7-sonnet': price(3, 15, 0.1, K200),
  'haiku-4-5': price(1, 5, 0.1, K200),
  '3-5-haiku': price(0.8, 4, 0.1, K200),
};

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
        const mult = (req.speed === 'fast' && p.fast ? 2 : 1) * (req.geo === 'us' ? 1.1 : 1);
        const c: TokenCounts = {
          input: (t.input * p.input * mult) / M,
          cacheWrite5m: (t.cacheWrite5m * p.input * 1.25 * mult) / M,
          cacheWrite1h: (t.cacheWrite1h * p.input * 2 * mult) / M,
          cacheRead: (t.cacheRead * p.cacheRead * mult) / M,
          output: (t.output * p.output * mult) / M,
        };
        for (const k of Object.keys(c) as (keyof TokenCounts)[]) {
          costs[k] += c[k];
          cost += c[k];
        }
      } else {
        unpriced.add(req.model);
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
    const summary: UsageSummary = { tokens, costs, cost, subagentCost, requests: this.requests.size, unpriced: [...unpriced], effort: this.effort };
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

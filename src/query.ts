// Search query syntax shared by the sidebar and the Search Sessions quick pick:
//   word          sessions containing "word" (case-insensitive substring)
//   "two words"   the exact phrase
//   -word -"a b"  sessions NOT containing it
//   a OR b        either one
//   source:copilot  only sessions from that tool (claude, copilot, chat); -source:chat leaves it out
// Terms separated by spaces must all match. No VS Code imports, so it can be unit-tested with plain Node.

import { SessionSource, sourceAlias } from './sources';

export interface Term {
  text: string;
  negate: boolean;
  re: RegExp;
}

export interface Query {
  /** All clauses must hold; a clause holds when any of its terms does. Negated terms are always a clause of their own. */
  clauses: Term[][];
  /** Texts of the positive terms, for highlighting. */
  highlight: string[];
  /** From `source:` terms: sessions must come from one of `include` (when any) and from none of `exclude`. */
  sources: { include: SessionSource[]; exclude: SessionSource[] };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Case-insensitive pattern for a term; spaces in a phrase match any whitespace (transcripts contain line breaks). */
export function termPattern(text: string): string {
  return text.split(' ').map(escapeRegExp).join('\\s+');
}

// A quoted phrase (optionally negated, closing quote optional) or a bare word.
const TOKEN = /(-?)"([^"]*)"?|(\S+)/g;

const SOURCE_TERM = /^(-?)source:(.+)$/i;

export function parseQuery(input: string): Query {
  const clauses: Term[][] = [];
  const sources: Query['sources'] = { include: [], exclude: [] };
  let orPending = false;
  for (const m of input.matchAll(TOKEN)) {
    let text: string;
    let negate = false;
    if (m[2] !== undefined) {
      text = m[2];
      negate = m[1] === '-';
    } else {
      text = m[3];
      // A known source filters by source; anything else after "source:" is searched for as text.
      const sm = SOURCE_TERM.exec(text);
      const source = sm ? sourceAlias(sm[2]) : undefined;
      if (sm && source) {
        (sm[1] ? sources.exclude : sources.include).push(source);
        continue;
      }
      const prev = clauses[clauses.length - 1];
      if (text === 'OR' && prev && !prev[0].negate && !orPending) {
        orPending = true;
        continue;
      }
      if (text.length > 1 && text.startsWith('-')) {
        text = text.slice(1);
        negate = true;
      }
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) {
      continue;
    }
    const term: Term = { text, negate, re: new RegExp(termPattern(text), 'i') };
    if (orPending && !negate) {
      clauses[clauses.length - 1].push(term);
    } else {
      clauses.push([term]);
    }
    orPending = false;
  }
  const highlight = [...new Set(clauses.flat().filter((t) => !t.negate).map((t) => t.text.toLowerCase()))];
  return { clauses, highlight, sources };
}

export const isEmptyQuery = (q: Query) =>
  q.clauses.length === 0 && q.sources.include.length === 0 && q.sources.exclude.length === 0;

/** True when the query's `source:` terms allow this source. */
export function sourceAllowed(q: Query, source: SessionSource): boolean {
  return (!q.sources.include.length || q.sources.include.includes(source)) && !q.sources.exclude.includes(source);
}

/** True when the query holds for the combined texts (a term counts as found if it is in any of them). */
export function evaluate(q: Query, texts: string[]): boolean {
  const found = (t: Term) => texts.some((x) => t.re.test(x));
  return q.clauses.every((alts) => alts.some((t) => (t.negate ? !found(t) : found(t))));
}

const SNIPPET_BEFORE = 60;
const SNIPPET_AFTER = 160;

/** One line of context around the earliest match of any positive term, or undefined if none matches. */
export function snippet(text: string, q: Query): string | undefined {
  let first: { index: number; length: number } | undefined;
  for (const t of q.clauses.flat()) {
    if (t.negate) {
      continue;
    }
    const m = t.re.exec(text);
    if (m && (!first || m.index < first.index)) {
      first = { index: m.index, length: m[0].length };
    }
  }
  if (!first) {
    return undefined;
  }
  let start = Math.max(0, first.index - SNIPPET_BEFORE);
  const end = Math.min(text.length, first.index + first.length + SNIPPET_AFTER);
  // Start at a word boundary so the snippet doesn't open mid-word.
  if (start > 0) {
    const space = text.slice(start, first.index).search(/\s/);
    if (space !== -1) {
      start += space + 1;
    }
  }
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + body + (end < text.length ? '…' : '');
}

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseQuery, evaluate, snippet, isEmptyQuery, sourceAllowed } = require('../out/query');

const terms = (q) => parseQuery(q).clauses.map((alts) => alts.map((t) => (t.negate ? '-' : '') + t.text));
const hit = (q, ...texts) => evaluate(parseQuery(q), texts);

test('parseQuery: words, phrases, exclusions and OR', () => {
  assert.deepEqual(terms('search term'), [['search'], ['term']]);
  assert.deepEqual(terms('"search  term"'), [['search term']]);
  assert.deepEqual(terms('"unclosed phrase'), [['unclosed phrase']]);
  assert.deepEqual(terms('-draft -"work in progress" x'), [['-draft'], ['-work in progress'], ['x']]);
  assert.deepEqual(terms('a OR b OR "c d" e'), [['a', 'b', 'c d'], ['e']]);
  // OR with nothing (positive) to join is just a word; "or" in lower case is a word.
  assert.deepEqual(terms('OR a'), [['OR'], ['a']]);
  assert.deepEqual(terms('-a OR b'), [['-a'], ['OR'], ['b']]);
  assert.deepEqual(terms('a or b'), [['a'], ['or'], ['b']]);
  // A lone minus or empty quotes are not operators.
  assert.deepEqual(terms('- ""'), [['-']]);
  assert.ok(isEmptyQuery(parseQuery('  ""  ')));
  assert.deepEqual(parseQuery('Login -x a OR LOGIN').highlight, ['login', 'a']);
});

test('parseQuery: source terms filter by source and stay out of the text search', () => {
  const q = parseQuery('login source:copilot -source:chat SOURCE:Claude');
  assert.deepEqual(terms('login source:copilot -source:chat'), [['login']]);
  assert.deepEqual(q.sources, { include: ['copilot-cli', 'claude'], exclude: ['vscode-chat'] });
  assert.deepEqual(q.highlight, ['login']);
  assert.ok(sourceAllowed(q, 'copilot-cli'));
  assert.ok(!sourceAllowed(q, 'vscode-chat'));
  // A source-only query is not empty, and matches any text.
  const only = parseQuery('source:cli');
  assert.ok(!isEmptyQuery(only));
  assert.ok(evaluate(only, ['anything']));
  assert.ok(!sourceAllowed(only, 'claude'));
  // Unknown names and quoted terms are searched for as text.
  assert.deepEqual(terms('source:map "source:copilot"'), [['source:map'], ['source:copilot']]);
  assert.ok(sourceAllowed(parseQuery('source:map'), 'claude'));
});

test('evaluate: phrase vs words, case, whitespace, exclusion, OR, several texts', () => {
  assert.ok(hit('search term', 'the term to search'));
  assert.ok(!hit('"search term"', 'the term to search'));
  assert.ok(hit('"search term"', 'a SEARCH\n  Term here'));
  assert.ok(!hit('"search term"', 'search\0term'), 'NUL separates fields');
  assert.ok(hit('login -flaky', 'login works'));
  assert.ok(!hit('login -flaky', 'login is flaky'));
  assert.ok(!hit('login -flaky', 'login', 'FLAKY in the transcript'));
  assert.ok(hit('redis OR postgres', 'uses Postgres'));
  assert.ok(!hit('redis OR postgres', 'uses sqlite'));
  assert.ok(hit('login race', 'login card', 'a race in the transcript'));
  assert.ok(hit('a+b (x)', 'is a+b (x) ok'), 'regex characters are literal');
  assert.ok(hit('-nothing', 'anything'));
});

test('snippet: context around the earliest positive match', () => {
  const text = 'x '.repeat(100) + 'The Culprit is a race in setup. ' + 'y '.repeat(200);
  const s = snippet(text, parseQuery('race culprit -x'));
  assert.ok(s.startsWith('…'));
  assert.ok(s.endsWith('…'));
  assert.match(s, /The Culprit is a race/);
  assert.ok(!s.includes('  '));
  assert.equal(snippet('short text', parseQuery('nope')), undefined);
  assert.equal(snippet('short\n\ntext', parseQuery('"SHORT TEXT"')), 'short text');
});

/**
 * Traces for the message syntax (P10.4).
 *
 * The two properties that matter are that plurals are decided by CLDR rather
 * than by an English intuition, and that a broken translation degrades to
 * something readable instead of throwing inside a render. Everything else here
 * exists to hold the parser to its own grammar, because a parser that silently
 * accepts a malformed message produces a label nobody notices is wrong.
 */

import assert from 'node:assert/strict';

import { formatMessage, isValidMessage, messageArguments, resetFormatCaches, type FormatProblem } from '../icu';

let passed = 0;
function test(name: string, run: () => void): void {
  resetFormatCaches();
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const en = (message: string, values?: Record<string, string | number | boolean | Date>) =>
  formatMessage(message, { locale: 'en', values });

test('plain text passes through, including braces that were quoted', () => {
  assert.equal(en('Slice'), 'Slice');
  // ICU quoting: a `'` before a brace opens a literal run that closes at the
  // next lone `'`, so the whole placeholder-looking text passes through.
  assert.equal(en("Use '{tool}' to name a tool"), 'Use {tool} to name a tool');
  assert.equal(en("It''s fine"), "It's fine");
});

test('an argument is substituted, and a missing one names itself', () => {
  assert.equal(en('Loading {file}', { file: 'bunny.stl' }), 'Loading bunny.stl');
  // Not a blank: an operator reporting "it says {file}" has told us which
  // message and which argument, and a gap tells us nothing.
  assert.equal(en('Loading {file}'), 'Loading {file}');
});

test('plural categories come from CLDR, not from count === 1', () => {
  const message = '{count, plural, one {# object} other {# objects}}';
  assert.equal(en(message, { count: 1 }), '1 object');
  assert.equal(en(message, { count: 2 }), '2 objects');
  assert.equal(en(message, { count: 0 }), '0 objects');
  // Russian has three categories and Polish four. An English `=== 1` rule
  // renders both wrong in a way an English reviewer cannot see, which is the
  // whole reason this goes through Intl.
  const ru = '{count, plural, one {# объект} few {# объекта} many {# объектов} other {# объекта}}';
  assert.equal(formatMessage(ru, { locale: 'ru', values: { count: 1 } }), '1 объект');
  assert.equal(formatMessage(ru, { locale: 'ru', values: { count: 3 } }), '3 объекта');
  assert.equal(formatMessage(ru, { locale: 'ru', values: { count: 7 } }), '7 объектов');
});

test('an exact branch wins over its category', () => {
  const message = '{count, plural, =0 {Nothing selected} one {# object} other {# objects}}';
  assert.equal(en(message, { count: 0 }), 'Nothing selected');
  assert.equal(en(message, { count: 1 }), '1 object');
});

test('offset subtracts before choosing a branch and before rendering #', () => {
  const message = '{count, plural, offset:1 one {and one other} other {and # others}}';
  assert.equal(en(message, { count: 2 }), 'and one other');
  assert.equal(en(message, { count: 4 }), 'and 3 others');
});

test('select routes on a value and falls back to other', () => {
  const message = '{kind, select, cube {Cube} sphere {Sphere} other {Shape}}';
  assert.equal(en(message, { kind: 'cube' }), 'Cube');
  assert.equal(en(message, { kind: 'torus' }), 'Shape');
});

test('numbers, units, and dates are formatted for the locale, not concatenated', () => {
  assert.equal(formatMessage('{v, number}', { locale: 'en', values: { v: 1234.5 } }), '1,234.5');
  assert.equal(formatMessage('{v, number}', { locale: 'de', values: { v: 1234.5 } }), '1.234,5');
  assert.equal(formatMessage('{v, number, integer}', { locale: 'en', values: { v: 12.7 } }), '13');
  assert.equal(formatMessage('{v, number, percent}', { locale: 'en', values: { v: 0.42 } }), '42%');
  const mm = formatMessage('{v, unit, millimeter}', { locale: 'en', values: { v: 0.2 } });
  assert.match(mm, /0\.2\s?mm/);
  const stamp = new Date(Date.UTC(2026, 7, 18, 12, 0, 0));
  assert.ok(formatMessage('{when, date, short}', { locale: 'en', values: { when: stamp } }).includes('26'));
});

test('an unsupported unit still renders the number rather than taking the panel down', () => {
  const out = formatMessage('{v, unit, furlong}', { locale: 'en', values: { v: 3 } });
  assert.equal(out, '3');
});

test('nested plurals inside a select render every branch', () => {
  const message = '{kind, select, plate {{count, plural, one {# plate} other {# plates}}} other {{count} items}}';
  assert.equal(en(message, { kind: 'plate', count: 1 }), '1 plate');
  assert.equal(en(message, { kind: 'plate', count: 3 }), '3 plates');
  assert.equal(en(message, { kind: 'other', count: 3 }), '3 items');
});

test('a message that does not parse renders as itself and reports why', () => {
  // A render must not throw. Twenty catalogues written by twenty people will
  // eventually contain one unbalanced brace, and a panel that disappears is a
  // worse outcome than a label showing its own source.
  const problems: FormatProblem[] = [];
  const broken = 'Delete {count objects';
  const out = formatMessage(broken, {
    locale: 'en',
    values: { count: 2 },
    id: 'x',
    onProblem: (p) => problems.push(p),
  });
  assert.equal(out, broken);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].code, 'syntax');
  assert.equal(problems[0].id, 'x');
  assert.equal(isValidMessage(broken), false);
});

test('the cached parse of a broken message still reports on every render', () => {
  // The cache is keyed by text; a second render of the same broken message
  // must not go quiet just because the failure was already recorded once.
  const problems: FormatProblem[] = [];
  const broken = 'Unbalanced {a';
  for (let index = 0; index < 3; index += 1) {
    formatMessage(broken, { locale: 'en', onProblem: (p) => problems.push(p) });
  }
  assert.equal(problems.length, 3);
});

test('a missing argument is reported, not merely rendered', () => {
  const problems: FormatProblem[] = [];
  formatMessage('Loading {file}', { locale: 'en', onProblem: (p) => problems.push(p) });
  assert.deepEqual(
    problems.map((p) => p.code),
    ['missing-argument'],
  );
});

test('the arguments a message needs can be listed, which is what guards a translation', () => {
  assert.deepEqual(messageArguments('Delete {count, plural, one {# object} other {# objects}} from {plate}'), [
    'count',
    'plate',
  ]);
  assert.deepEqual(messageArguments('no arguments here'), []);
  assert.deepEqual(messageArguments('broken {'), []);
});

test('unknown placeholder types are refused rather than rendered as text', () => {
  // Accepting them would let a translator invent `{v, currency}` and get a
  // silently different string in one language only.
  assert.equal(isValidMessage('{v, wobble, x}'), false);
  assert.equal(isValidMessage('{}'), false);
  assert.equal(isValidMessage('{count, plural}'), false);
});

console.log(`\nICU messages: ${passed} tests passed.`);

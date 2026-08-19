/**
 * Pseudo-localization — the two layout defects that only appear in translation (P10.4).
 *
 * Both are invisible in English and expensive to find late. A German label is
 * routinely 35% longer than its English source, so a button sized to "Slice"
 * clips "Aufschneiden"; and a right-to-left layout mirrors every row, so an
 * icon pinned with a physical `margin-left` ends up on the wrong side of its text.
 * Waiting
 * for a translator to report either means shipping it.
 *
 * So both are generated from the reference catalogue and run on every build:
 * `en-XA` expands and accents, `ar-XB` mirrors. The strings stay readable —
 * accented Latin rather than a different script — because a reviewer has to be
 * able to tell "this control is clipped" from "this control is in Greek".
 *
 * The rule that makes this safe is that ICU structure is *never* transformed:
 * placeholders, plural keys, and branch syntax pass through untouched, so a
 * pseudo-locale renders through the same code path as a real one. Accenting the
 * inside of `{count, plural, one {…}}` would produce a message that fails to
 * parse, and the run would then be testing the error path instead of layout.
 */

import { PSEUDO_LONG_LOCALE, PSEUDO_RTL_LOCALE } from './locales';

/**
 * Latin letters mapped to accented forms with the same silhouette. Chosen so a
 * reader can still tell what a control does — the point is finding clipped
 * boxes, not proving that unreadable text is unreadable.
 */
const ACCENTS: Readonly<Record<string, string>> = Object.freeze({
  a: 'ä',
  b: 'ƀ',
  c: 'ç',
  d: 'ð',
  e: 'é',
  f: 'ƒ',
  g: 'ĝ',
  h: 'ĥ',
  i: 'í',
  j: 'ĵ',
  k: 'ķ',
  l: 'ļ',
  m: 'ɱ',
  n: 'ñ',
  o: 'ö',
  p: 'þ',
  q: 'ɋ',
  r: 'ŕ',
  s: 'š',
  t: 'ţ',
  u: 'ü',
  v: 'ṽ',
  w: 'ŵ',
  x: 'ẋ',
  y: 'ý',
  z: 'ž',
  A: 'Å',
  B: 'Ɓ',
  C: 'Ç',
  D: 'Ð',
  E: 'É',
  F: 'Ƒ',
  G: 'Ĝ',
  H: 'Ĥ',
  I: 'Í',
  J: 'Ĵ',
  K: 'Ķ',
  L: 'Ļ',
  M: 'Ṁ',
  N: 'Ñ',
  O: 'Ö',
  P: 'Þ',
  Q: 'Ǫ',
  R: 'Ŕ',
  S: 'Š',
  T: 'Ţ',
  U: 'Ü',
  V: 'Ṽ',
  W: 'Ŵ',
  X: 'Ẋ',
  Y: 'Ý',
  Z: 'Ž',
});

/** Right-to-left mark. Wrapping in these is what makes a mirrored run mirror. */
const RLM = '‏';

/**
 * How much longer the pseudo-long locale renders than its source.
 *
 * 1.4 is not arbitrary: it is roughly the worst case the twenty shipped
 * languages produce for short UI labels — German and Russian expand most, and
 * a control that survives 40% survives them.
 */
export const PSEUDO_EXPANSION = 1.4;

/** The brackets that make a truncation visible: if you cannot see `]`, it clipped. */
const OPEN = '⟦';
const CLOSE = '⟧';

export interface PseudoOptions {
  /** Expand the text. Off produces a same-length accented string. */
  readonly expand?: boolean;
  /** Wrap in direction marks and brackets for a mirrored run. */
  readonly rtl?: boolean;
  /** Surround with brackets so truncation is visible. Default true. */
  readonly bracket?: boolean;
}

/**
 * Pseudo-localize one ICU message, leaving its structure intact.
 *
 * The parser here is intentionally separate from `icu.ts`'s: this one only
 * needs to know where the literal text is, and reusing the full parser would
 * mean re-serializing an AST, which is a second place for the syntax to drift.
 */
export function pseudoLocalize(message: string, options: PseudoOptions = {}): string {
  const expand = options.expand ?? true;
  const bracket = options.bracket ?? true;
  const transformed = transformLiteralText(message, (text) => accent(text, expand));
  if (!bracket) return options.rtl ? `${RLM}${transformed}${RLM}` : transformed;
  const wrapped = `${OPEN}${transformed}${CLOSE}`;
  return options.rtl ? `${RLM}${wrapped}${RLM}` : wrapped;
}

/** The catalogue a pseudo-locale serves, derived from the reference. */
export function pseudoCatalog(
  reference: Readonly<Record<string, string>>,
  locale: string,
): Readonly<Record<string, string>> {
  const rtl = locale === PSEUDO_RTL_LOCALE;
  const expand = locale === PSEUDO_LONG_LOCALE;
  const out: Record<string, string> = {};
  for (const [id, source] of Object.entries(reference)) {
    out[id] = pseudoLocalize(source, { expand, rtl });
  }
  return Object.freeze(out);
}

function accent(text: string, expand: boolean): string {
  let out = '';
  for (const char of text) out += ACCENTS[char] ?? char;
  if (!expand) return out;
  // Padding is appended rather than interleaved so the original stays readable
  // and the added width is obvious as added width.
  const letters = [...out].filter((char) => /\p{L}/u.test(char)).length;
  const extra = Math.max(0, Math.round(letters * (PSEUDO_EXPANSION - 1)));
  if (extra === 0) return out;
  return `${out}${' '}${'·'.repeat(extra)}`;
}

/**
 * Walk a message and hand only its literal runs to `transform`.
 *
 * The traversal mirrors `icu.ts`'s grammar rather than scanning for braces,
 * because the two kinds of text between braces are not interchangeable: a
 * branch *body* is literal and must be pseudo-localized, while a branch *key*
 * (`one`, `other`, `=0`) is syntax and accenting it produces a message that no
 * longer parses. An earlier brace-counting version did exactly that, and the
 * run then exercised the parse-failure path instead of layout.
 */
function transformLiteralText(message: string, transform: (text: string) => string): string {
  const cursor = { text: message, index: 0 };
  const out = transformRun(cursor, false, transform);
  return out + message.slice(cursor.index);
}

interface Cursor {
  readonly text: string;
  index: number;
}

/** Literal text, up to the end or — when nested — the `}` that closes a branch. */
function transformRun(cursor: Cursor, nested: boolean, transform: (text: string) => string): string {
  let out = '';
  let literal = '';
  const flush = () => {
    if (literal) {
      out += transform(literal);
      literal = '';
    }
  };
  while (cursor.index < cursor.text.length) {
    const char = cursor.text[cursor.index];
    if (char === "'" && cursor.text[cursor.index + 1] !== undefined) {
      const next = cursor.text[cursor.index + 1];
      if (next === "'" || next === '{' || next === '}') {
        // Quoted text is literal, but its quoting must survive verbatim or the
        // braces inside it become syntax on the next parse.
        flush();
        out += char + next;
        cursor.index += 2;
        continue;
      }
    }
    if (char === '}' && nested) break;
    if (char === '{') {
      flush();
      out += transformPlaceholder(cursor, transform);
      continue;
    }
    literal += char;
    cursor.index += 1;
  }
  flush();
  return out;
}

/** One `{…}`: its head is copied verbatim, its branch bodies are transformed. */
function transformPlaceholder(cursor: Cursor, transform: (text: string) => string): string {
  const start = cursor.index;
  cursor.index += 1; // '{'
  let commas = 0;
  while (cursor.index < cursor.text.length) {
    const char = cursor.text[cursor.index];
    if (char === '}') {
      cursor.index += 1;
      return cursor.text.slice(start, cursor.index);
    }
    if (char === ',') {
      commas += 1;
      cursor.index += 1;
      continue;
    }
    if (char === '{' && commas >= 2) {
      const head = cursor.text.slice(start, cursor.index);
      return head + transformBranches(cursor, transform);
    }
    cursor.index += 1;
  }
  return cursor.text.slice(start);
}

/** A branch list: keys and whitespace verbatim, bodies transformed. */
function transformBranches(cursor: Cursor, transform: (text: string) => string): string {
  let out = '';
  while (cursor.index < cursor.text.length) {
    const char = cursor.text[cursor.index];
    if (char === '}') {
      cursor.index += 1;
      return `${out}}`;
    }
    if (char === '{') {
      cursor.index += 1;
      const body = transformRun(cursor, true, transform);
      // The closing brace of the body; absent only in a malformed message,
      // which is copied through rather than repaired.
      const closed = cursor.text[cursor.index] === '}';
      if (closed) cursor.index += 1;
      out += `{${body}${closed ? '}' : ''}`;
      continue;
    }
    out += char;
    cursor.index += 1;
  }
  return out;
}

/** Strip pseudo-localization, so a test can assert on the source it wrapped. */
export function unpseudo(text: string): string {
  const reverse = new Map(Object.entries(ACCENTS).map(([plain, accented]) => [accented, plain]));
  let out = '';
  for (const char of text.replaceAll(RLM, '')) {
    if (char === OPEN || char === CLOSE || char === '·') continue;
    out += reverse.get(char) ?? char;
  }
  return out.replace(/ $/, '');
}

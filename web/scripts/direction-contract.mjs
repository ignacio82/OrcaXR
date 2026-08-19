#!/usr/bin/env node
/**
 * No physical direction in the app's CSS (P10.4.4).
 *
 * A right-to-left layout mirrors every row, and the properties that do not
 * mirror are exactly the ones nobody notices in English: `margin-left` pins an
 * icon to the side of its text, `text-align: left` holds a column against the
 * wrong edge, `border-right` draws a divider on the wrong side of a panel. Each
 * is invisible until someone reads the app in Arabic or Hebrew, and by then it
 * is thirty small defects rather than one.
 *
 * The logical equivalents — `margin-inline-start`, `text-align: start`,
 * `border-inline-end` — mirror by themselves, so this is a rule about writing
 * them rather than about remembering to test. It is checked statically because
 * a rendered check can only find the physical properties that happen to be on
 * screen in whatever state a smoke test reached, and the rest ship.
 *
 * Three things are deliberately allowed.
 *
 * **`left: 50%` and `right: 50%` are direction-neutral.** Fifty percent is the
 * same distance from either edge, and the centring idiom that pairs it with a
 * self-relative `translateX(-50%)` is correct in both directions — converting
 * it to `inset-inline-start` would actively break RTL, because the translate
 * would then push the box away from the centre rather than onto it.
 *
 * **A position can be genuinely physical**, and says so with a
 * `direction:physical` comment carrying its reason. A menu placed at a
 * pointer's viewport coordinate belongs where the pointer is in any writing
 * direction; mirroring it would open the menu across the screen from the thing
 * it was opened on. The marker sits at the point of use so the decision is
 * reviewed where it is made, not in a list nobody reads.
 *
 * **Prose is not code.** A comment explaining why `margin-left` is a hazard has
 * to be able to say `margin-left`.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptDirectory, '..');

/** Physical properties with a logical equivalent, and what to write instead. */
const REPLACEMENTS = new Map([
  ['margin-left', 'margin-inline-start'],
  ['margin-right', 'margin-inline-end'],
  ['padding-left', 'padding-inline-start'],
  ['padding-right', 'padding-inline-end'],
  ['border-left-width', 'border-inline-start-width'],
  ['border-right-width', 'border-inline-end-width'],
  ['border-left-color', 'border-inline-start-color'],
  ['border-right-color', 'border-inline-end-color'],
  ['border-left-style', 'border-inline-start-style'],
  ['border-right-style', 'border-inline-end-style'],
  ['border-left', 'border-inline-start'],
  ['border-right', 'border-inline-end'],
]);

const PROPERTY_PATTERN = new RegExp(`(?<![-\\w])(${[...REPLACEMENTS.keys()].join('|')})\\s*:`, 'g');
const TEXT_ALIGN_PATTERN = /text-align\s*:\s*(left|right)\b/g;
const FLOAT_PATTERN = /float\s*:\s*(left|right)\b/g;
const CLEAR_PATTERN = /clear\s*:\s*(left|right)\b/g;

/**
 * `left:`/`right:` captured *with* their value, so the direction-neutral cases
 * are recognised from the value. A `(?!50%)` lookahead in the pattern does not
 * work: `\s*` backtracks past the space it was meant to guard and matches anyway.
 */
const INSET_PATTERN = /(?<![-\w])(left|right)\s*:\s*([^;'"`}\n]*)/g;
const DIRECTION_NEUTRAL_INSET = /^50%$/;
const PHYSICAL_MARKER = /direction:physical/;

const findings = [];

inspectStylesheet();
for (const file of walk(join(webRoot, 'src'))) inspectInlineStyles(file);

if (findings.length > 0) {
  console.error(`Physical direction in CSS (${findings.length}); a right-to-left layout will not mirror these:`);
  for (const finding of findings) console.error(`  ${finding}`);
  process.exitCode = 1;
} else {
  console.log('Direction contract: the app stylesheet and every inline style use logical properties.');
}

/** The one `<style>` block; everything else is set from TypeScript. */
function inspectStylesheet() {
  const path = join(webRoot, 'index.html');
  const html = readFileSync(path, 'utf8');
  const open = html.indexOf('<style>');
  const close = html.indexOf('</style>');
  if (open < 0 || close < 0) {
    findings.push('index.html has no <style> block to check');
    return;
  }
  // The body begins on the same line as `<style>`, so that line is body line 1.
  const offset = html.slice(0, open).split('\n').length - 1;
  scan(html.slice(open + '<style>'.length, close), 'index.html', offset, 'css');
}

/**
 * Inline styles set from TypeScript — `style.cssText`, `setProperty`, template
 * literals. Scanned as text rather than parsed, because the requirement is that
 * a physical name never reaches a style string, whatever built it.
 */
function inspectInlineStyles(file) {
  scan(readFileSync(file, 'utf8'), relative(webRoot, file), 0, 'ts');
}

function scan(text, display, lineOffset, language) {
  const body = language === 'css' ? blankCssComments(text) : blankTsComments(text);
  const lines = body.split('\n');
  const rawLines = text.split('\n');
  const report = (index, message) => {
    findings.push(`${display}:${body.slice(0, index).split('\n').length + lineOffset} ${message}`);
  };

  for (const [pattern, describe] of [
    [PROPERTY_PATTERN, (match) => `uses ${match[1]}; write ${REPLACEMENTS.get(match[1])}`],
    [TEXT_ALIGN_PATTERN, (match) => `uses text-align: ${match[1]}; write ${match[1] === 'left' ? 'start' : 'end'}`],
    [FLOAT_PATTERN, (match) => `uses float: ${match[1]}; write inline-${match[1] === 'left' ? 'start' : 'end'}`],
    [CLEAR_PATTERN, (match) => `uses clear: ${match[1]}; write inline-${match[1] === 'left' ? 'start' : 'end'}`],
  ]) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(body); match; match = pattern.exec(body)) report(match.index, describe(match));
  }

  // Insets are reported only where a style is actually being written, so an
  // ordinary identifier named `left` in application code is not a finding.
  INSET_PATTERN.lastIndex = 0;
  for (let match = INSET_PATTERN.exec(body); match; match = INSET_PATTERN.exec(body)) {
    const index = body.slice(0, match.index).split('\n').length - 1;
    if (!looksLikeStyle(lines[index] ?? '')) continue;
    if (DIRECTION_NEUTRAL_INSET.test(match[2].trim())) continue;
    if (markedPhysical(rawLines, index)) continue;
    const property = match[1];
    report(match.index, `positions with ${property}: …; write inset-inline-${property === 'left' ? 'start' : 'end'}`);
  }
}

/**
 * The marker, anywhere in the statement the declaration belongs to or in the
 * comment block introducing it.
 *
 * Scoped to the statement rather than to the line because the declaration is
 * usually inside a template literal, which cannot carry a comment of its own —
 * the explanation has to sit above `element.style.cssText =`, several lines up.
 * The walk stops at the previous statement's end so a marker cannot silently
 * cover code it was not written for.
 */
function markedPhysical(rawLines, index) {
  let inComment = false;
  for (let cursor = index; cursor >= 0 && index - cursor <= 16; cursor -= 1) {
    const line = (rawLines[cursor] ?? '').trim();
    if (PHYSICAL_MARKER.test(line)) return true;
    if (line === '') return false;
    const isComment = /^(\/\/|\/\*|\*)/.test(line);
    if (isComment) {
      inComment = true;
      continue;
    }
    // A finished statement below a comment block means the block introduced
    // that statement, not this one.
    if (inComment) return false;
    if (cursor !== index && /[;}]$/.test(line)) return false;
  }
  return false;
}

/** A line that is plausibly a style declaration rather than TypeScript. */
function looksLikeStyle(line) {
  if (/\b(const|let|var|function|return|=>|import|interface|type)\b/.test(line)) return false;
  // `left: [-R, 0.06, 0]` is a point in the 3D scene. A bare number is a
  // coordinate, not a length, and has nothing to do with writing direction.
  if (/(left|right)\s*:\s*[[{]/.test(line)) return false;
  return /[:;]/.test(line) && /(\d(px|%|em|rem|vh|vw)|\b(auto|calc|var)\()/.test(line);
}

function blankCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '));
}

function blankTsComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, lead) => lead + ' '.repeat(match.length - lead.length));
}

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'generated') continue;
      yield* walk(target);
    } else if (entry.isFile() && target.endsWith('.ts') && !target.endsWith('.test.ts')) {
      yield target;
    }
  }
}

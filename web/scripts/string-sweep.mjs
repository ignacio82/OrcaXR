#!/usr/bin/env node
/**
 * What text an operator can still read that no translator can reach (P10.4.3).
 *
 * The action catalogue is extracted by construction, but the app says far more
 * than its menu labels: status lines, dialog prose, panel headings, tooltips,
 * confirmations. Each of those is an English literal at its use site, and there
 * is no way to notice one being added — a sweep that is only a person's
 * intention is a sweep that stops.
 *
 * So this counts them, and the count is committed. A file may hold no more
 * unextracted strings than the baseline records; adding one fails, removing one
 * requires the baseline to shrink with it. That is the whole mechanism, and it
 * is deliberately a ratchet rather than a pass/fail: the alternative on a
 * 47-file surface is a gate that is red for months and gets switched off.
 *
 * **The baseline is not a permitted-exceptions list.** P10.4.3 closes when it is
 * empty, and every entry in it is a surface an operator cannot read in their own
 * language. It exists to make the remaining work bounded and visible, not to
 * bless it.
 *
 * What counts as user-facing is deliberately narrow: a string literal assigned
 * to a property a person reads (`textContent`, `title`, `placeholder`), set as
 * an attribute they read (`aria-label`, `alt`), or handed to a call whose whole
 * purpose is to show text (`setStatus`, `showModal`, `confirm`). A string that
 * only ever reaches a log, a CSS declaration, or a DOM id is not text anybody
 * reads and is not counted — over-counting would bury the real ones.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import ts from 'typescript';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptDirectory, '..');
const sourceRoot = join(webRoot, 'src');
const baselinePath = join(scriptDirectory, 'string-sweep.baseline.json');

const write = process.argv.includes('--write');
const unknown = process.argv.slice(2).filter((argument) => argument !== '--write');
if (unknown.length > 0) throw new Error(`Unknown arguments: ${unknown.join(', ')}`);

/** Properties whose assigned value a person reads. */
const TEXT_PROPERTIES = new Set(['textContent', 'innerText', 'title', 'placeholder', 'alt']);
/** Attributes whose value a person reads, including through a screen reader. */
const TEXT_ATTRIBUTES = new Set([
  'title',
  'placeholder',
  'alt',
  'aria-label',
  'aria-description',
  'aria-roledescription',
]);
/** Calls that exist to put text in front of someone. */
const TEXT_CALLS = new Set(['setStatus', 'showModal', 'alert', 'confirm', 'prompt']);

const policy =
  'Every file below still holds text an operator reads that no translator can reach. A count may fall and must ' +
  'never rise; P10.4.3 closes when this object is empty. This is not a permitted-exceptions list.';

const counts = new Map();
const samples = new Map();

for (const file of walk(sourceRoot)) inspect(file);

const current = Object.fromEntries([...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const total = Object.values(current).reduce((sum, value) => sum + value, 0);

if (write) {
  const rendered = `${JSON.stringify({ schemaVersion: 1, policy, total, files: current }, null, 2)}\n`;
  writeFileSync(baselinePath, rendered);
  console.log(
    `String sweep baseline: ${total} unextracted user-facing strings across ${Object.keys(current).length} files.`,
  );
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
} catch (error) {
  console.error(`String sweep baseline is missing or malformed: ${error.message}`);
  process.exit(1);
}

const problems = [];
for (const [file, count] of Object.entries(current)) {
  const allowed = baseline.files?.[file] ?? 0;
  if (count > allowed) {
    const examples = (samples.get(file) ?? []).slice(0, 3).map((text) => `      ${JSON.stringify(text)}`);
    problems.push(
      `${file}: ${count} unextracted user-facing strings, baseline allows ${allowed}. ` +
        `Wrap them in t('id', 'English') and run \`npm run l10n:sync\`.\n${examples.join('\n')}`,
    );
  }
}
const stale = Object.entries(baseline.files ?? {}).filter(([file, allowed]) => (current[file] ?? 0) < allowed);

if (problems.length > 0) {
  console.error(`String sweep (P10.4.3) — text an operator reads that no translator can reach:`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exitCode = 1;
} else if (stale.length > 0) {
  // A ratchet that does not tighten is a ratchet that slips back: work done and
  // not recorded leaves room for the next string to be added for free.
  console.error('String sweep: strings were extracted without updating the baseline. Run `npm run l10n:sweep`:');
  for (const [file, allowed] of stale) console.error(`  ${file}: now ${current[file] ?? 0}, baseline still ${allowed}`);
  process.exitCode = 1;
} else {
  const remaining = Object.keys(current).length;
  console.log(
    remaining === 0
      ? 'String sweep: every user-facing string is extracted.'
      : `String sweep: ${total} unextracted user-facing strings across ${remaining} files, none added (P10.4.3).`,
  );
}

function inspect(file) {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const display = relative(webRoot, file);
  const found = [];

  const record = (value) => {
    if (isHumanText(value)) found.push(value);
  };
  const readText = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    // A template's literal chunks are the sentence; its holes are values.
    if (ts.isTemplateExpression(node)) {
      return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(' ');
    }
    return undefined;
  };

  const visit = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      TEXT_PROPERTIES.has(node.left.name.text)
    ) {
      const value = readText(node.right);
      if (value !== undefined) record(value);
    }
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : ts.isIdentifier(node.expression)
          ? node.expression.text
          : '';
      if (callee === 'setAttribute' && node.arguments.length === 2) {
        const [name, value] = node.arguments;
        if (ts.isStringLiteral(name) && TEXT_ATTRIBUTES.has(name.text)) {
          const read = readText(value);
          if (read !== undefined) record(read);
        }
      } else if (TEXT_CALLS.has(callee)) {
        for (const argument of node.arguments) {
          const read = readText(argument);
          if (read !== undefined) record(read);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  if (found.length > 0) {
    counts.set(display, found.length);
    samples.set(display, found);
  }
}

/**
 * Text a person reads, as opposed to an identifier that happens to be a string.
 *
 * A sentence has a space or terminal punctuation and at least one capital or
 * several words; `flex-start`, `oxr-panel`, and `application/json` do not, and
 * counting them would bury the strings that matter under hundreds that do not.
 */
function isHumanText(value) {
  const text = value.trim();
  if (text.length < 4) return false;
  if (!/[A-Za-z]/.test(text)) return false;
  if (/^[\w.@/-]+$/.test(text)) return false;
  if (/^[a-z][\w-]*$/.test(text)) return false;
  // A bare CSS declaration list or a URL is not prose.
  if (/^[a-z-]+\s*:/.test(text)) return false;
  if (/^https?:\/\//.test(text)) return false;
  return /\s/.test(text) || /[.!?…]/.test(text) || /[A-Z]/.test(text);
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

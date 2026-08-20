#!/usr/bin/env node
/**
 * Wrap the plain user-facing string literals in one file with `t` (P10.4.3).
 *
 * A developer tool, not a gate — `string-sweep.mjs` is the gate. This exists
 * because the sweep is 500 strings across 39 files and the mechanical part of
 * it (find the literal, invent a stable id, add the import) is the part most
 * likely to be done inconsistently by hand and least likely to be finished.
 *
 * It deliberately does *only* the unambiguous case: a plain string literal in a
 * position the gate already recognises as user-facing. Template literals are
 * left alone and reported, because turning `` `Loading ${name}` `` into
 * `t('id', 'Loading {name}', { name })` is a judgement about what the argument
 * should be called and how the sentence reads once a translator can reorder it.
 * A codemod that guessed at those would produce message ids that have to be
 * renamed later, and a renamed id is a translation thrown away.
 *
 * Usage: `node scripts/sweep-strings.mjs src/ui/dom/GcodePanel.ts [--write]`
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const args = process.argv.slice(2);
const write = args.includes('--write');
const targets = args.filter((argument) => argument !== '--write');
if (targets.length === 0) throw new Error('Name at least one file to sweep.');

const TEXT_PROPERTIES = new Set(['textContent', 'innerText', 'title', 'placeholder', 'alt']);
const TEXT_ATTRIBUTES = new Set([
  'title',
  'placeholder',
  'alt',
  'aria-label',
  'aria-description',
  'aria-roledescription',
]);
const TEXT_CALLS = new Set(['setStatus', 'showModal', 'alert', 'confirm', 'prompt']);

let totalWrapped = 0;
let totalTemplates = 0;
for (const target of targets) sweep(resolve(target));

console.log(
  `Swept ${targets.length} file(s): wrapped ${totalWrapped} literal(s); ` +
    `${totalTemplates} template(s) left for a human to phrase.`,
);

function sweep(file) {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const display = relative(process.cwd(), file);
  const namespace = messageNamespace(file);

  /** @type {{start: number, end: number, id: string, text: string}[]} */
  const edits = [];
  let templates = 0;
  const used = new Set();

  const consider = (node) => {
    if (ts.isStringLiteral(node)) {
      if (!isHumanText(node.text)) return;
      const id = uniqueId(namespace, node.text, used);
      edits.push({ start: node.getStart(source), end: node.getEnd(), id, text: node.text });
      return;
    }
    if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) templates += 1;
  };

  const visit = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      TEXT_PROPERTIES.has(node.left.name.text)
    ) {
      consider(node.right);
    }
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : ts.isIdentifier(node.expression)
          ? node.expression.text
          : '';
      if (callee === 'setAttribute' && node.arguments.length === 2) {
        const [name, value] = node.arguments;
        if (ts.isStringLiteral(name) && TEXT_ATTRIBUTES.has(name.text)) consider(value);
      } else if (TEXT_CALLS.has(callee)) {
        for (const argument of node.arguments) consider(argument);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  if (edits.length === 0) {
    console.log(`  ${display}: nothing to wrap (${templates} template(s))`);
    totalTemplates += templates;
    return;
  }

  let out = text;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    out = `${out.slice(0, edit.start)}t(${JSON.stringify(edit.id)}, ${JSON.stringify(edit.text)})${out.slice(edit.end)}`;
  }
  if (!/from '(\.\.\/)+l10n\/t'/.test(out)) out = addImport(out, file);

  console.log(`  ${display}: ${edits.length} wrapped, ${templates} template(s) left`);
  totalWrapped += edits.length;
  totalTemplates += templates;
  if (write) writeFileSync(file, out);
}

/** `src/ui/dom/GcodePanel.ts` → `ui.gcodePanel` */
function messageNamespace(file) {
  const parts = relative(resolve('src'), file).replace(/\.ts$/, '').split(/[/\\]/);
  const area = parts.length > 1 ? parts[0] : 'app';
  const name = parts[parts.length - 1];
  return `${camel(area)}.${camel(name)}`;
}

/**
 * A readable id from the text itself.
 *
 * Derived rather than sequential so a diff shows which string moved, and a
 * translator reading `ui.gcodePanel.noGcodeToShowYet` knows what they are
 * translating without opening the source.
 */
function uniqueId(namespace, text, used) {
  const slug =
    camel(
      text
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .trim()
        .split(/\s+/)
        .slice(0, 5)
        .join(' '),
    ) || 'message';
  let id = `${namespace}.${slug}`;
  for (let index = 2; used.has(id); index += 1) id = `${namespace}.${slug}${index}`;
  used.add(id);
  return id;
}

function camel(value) {
  const words = value.split(/[\s_-]+/).filter(Boolean);
  return words
    .map((word, index) => (index === 0 ? word[0].toLowerCase() + word.slice(1) : word[0].toUpperCase() + word.slice(1)))
    .join('')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/** Add the import after the last existing one, matching the file's own depth. */
function addImport(text, file) {
  const depth = relative(resolve('src'), file).split(/[/\\]/).length - 1;
  const specifier = `${'../'.repeat(depth) || './'}l10n/t`;
  const statement = `import { t } from '${specifier}';`;
  const imports = [...text.matchAll(/^import .*?;$/gm)];
  if (imports.length === 0) return `${statement}\n${text}`;
  const last = imports[imports.length - 1];
  const at = last.index + last[0].length;
  return `${text.slice(0, at)}\n${statement}${text.slice(at)}`;
}

function isHumanText(value) {
  const text = value.trim();
  if (text.length < 4) return false;
  if (!/[A-Za-z]/.test(text)) return false;
  if (/^[\w.@/-]+$/.test(text)) return false;
  if (/^[a-z][\w-]*$/.test(text)) return false;
  if (/^[a-z-]+\s*:/.test(text)) return false;
  if (/^https?:\/\//.test(text)) return false;
  return /\s/.test(text) || /[.!?…]/.test(text) || /[A-Z]/.test(text);
}

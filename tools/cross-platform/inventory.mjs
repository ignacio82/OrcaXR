// Snapshot current web scope without promoting any native capability.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRegistry } from '../../web/src/actions/catalog.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const target = resolve(root, 'contracts/generated/migration-inventory.json');
const writing = process.argv.includes('--write');
const old = writing ? undefined : JSON.parse(readFileSync(target, 'utf8'));
const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
const sourceCommit = old?.sourceCommit ?? git('rev-parse', 'HEAD');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function walk(path) {
  return readdirSync(path, {withFileTypes: true}).flatMap(entry => {
    const name = resolve(path, entry.name);
    return entry.isDirectory() ? walk(name) : [relative(root, name)];
  });
}
const paths = [
  ...walk(resolve(root, 'web/src/actions')).filter(path => !path.includes('/__tests__/')),
  'docs/parity/release-report.json',
  'web/src/settings/generated/engine-options.schema.json',
  'web/public/profiles/manifest.json', 'web/public/profiles/catalog.json',
  'web/src/l10n/generated/catalog-manifest.json',
].sort();
const sources = Object.fromEntries(paths.map(path => {
  const current = readFileSync(resolve(root, path));
  const committed = execFileSync('git', ['show', `${sourceCommit}:${path}`], {cwd: root, maxBuffer: 32 * 1024 * 1024});
  assert.equal(hash(current), hash(committed), `Commit ${path} first, then explicitly regenerate the scope snapshot`);
  return [path, hash(current)];
}));
const actions = buildRegistry().all().map(action => ({
  id: action.id, label: action.label, group: action.group, disclosure: action.disclosure,
  ...(action.menuSection ? {menuSection: action.menuSection} : {}),
  ...(action.shortcuts ? {shortcuts: action.shortcuts} : {}),
  ...(action.mcpTool ? {automationTool: action.mcpTool} : {}),
  ...(action.xrUnsupportedReason ? {webXrUnsupportedReason: action.xrUnsupportedReason} : {}),
  hasWebHandler: typeof action.run === 'function', webCapability: action.capability,
  nativeFlat: {status: 'unavailable', reason: 'Native workflow is not implemented.'},
  nativeXr: {status: 'unavailable', reason: 'Native workflow is not implemented.'},
}));
assert.equal(new Set(actions.map(action => action.id)).size, actions.length);
const counts = Object.fromEntries(['implemented', 'partial', 'blocked', 'unavailable'].map(status =>
  [status, actions.filter(action => action.webCapability.status === status).length]));
const output = {schemaVersion: 1, sourceCommit, sources, policy:
  'Metadata inventory only. Existing partial web and hardware gates remain open; this does not establish native support.',
  actionCount: actions.length, webStatusCounts: counts, actions};
const content = JSON.stringify(output, null, 2) + '\n';
if (writing) { mkdirSync(dirname(target), {recursive: true}); writeFileSync(target, content); }
else assert.equal(readFileSync(target, 'utf8'), content, 'Native migration scope drifted');
console.log(`${writing ? 'Generated' : 'Verified'} ${actions.length} action records from ${sourceCommit.slice(0, 7)}; native workflows remain unavailable`);

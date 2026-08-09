#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(join(root, 'index.html'), 'utf8');
const workspace = await readFile(join(root, 'src', 'workspace', 'OrcaWorkspace.ts'), 'utf8');
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));

const policy = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i)?.[1];
assert(policy, 'index.html must ship a Content Security Policy');
assert.match(policy, /script-src 'self' 'wasm-unsafe-eval'/);
assert.doesNotMatch(policy, /script-src[^;]*'unsafe-(?:inline|eval)'/);
assert.match(policy, /object-src 'none'/);
assert.match(policy, /frame-src 'none'/);

assert.doesNotMatch(html, /<script[^>]+src=["']https?:/i, 'remote scripts are forbidden');
assert.doesNotMatch(workspace, /\bnew\s+UIIcon\s*\(/, 'XR icons must use local UIImage assets');
assert.doesNotMatch(workspace, /\bUIIcon\s*,/, 'do not import the CDN-backed UIIcon class');

const exactPackages = {
  '@material-symbols/svg-400': '0.33.0',
  '@pmndrs/uikit': '1.0.74',
  xrblocks: '0.17.0',
};
for (const [name, expected] of Object.entries(exactPackages)) {
  const declared = packageJson.dependencies?.[name] ?? packageJson.devDependencies?.[name];
  assert.equal(declared, expected, `${name} must be exact-pinned`);
  assert.equal(lock.packages[`node_modules/${name}`]?.version, expected, `${name} lock drift`);
}

// The CLI engine's identity is its upstream commit plus the OrcaXR patches
// applied on top, so a patch added, removed, or edited without updating the
// pin would let an engine this build has never seen receive canonical work.
const { PINNED_ENGINE_PROVENANCE } = await import('../src/slicer/pinnedEngineProvenance.ts').catch(async () => {
  // The contract script runs without a TypeScript loader; read the literal.
  const source = await readFile(join(root, 'src/slicer/pinnedEngineProvenance.ts'), 'utf8');
  const pinned = {};
  const block = source.match(/cliPatches: Object\.freeze\(\{([\s\S]*?)\}\)/)?.[1] ?? '';
  for (const [, name, digest] of block.matchAll(/'([^']+\.patch)':\s*\n?\s*'([0-9a-f]{64})'/g)) {
    pinned[name] = digest;
  }
  return { PINNED_ENGINE_PROVENANCE: { cliPatches: pinned } };
});

const patchDirectory = join(root, '..', 'server', 'patches');
const patchFiles = (await readdir(patchDirectory)).filter((name) => name.endsWith('.patch')).sort();
const pinnedPatches = PINNED_ENGINE_PROVENANCE.cliPatches;
assert.deepEqual(
  patchFiles,
  Object.keys(pinnedPatches).sort(),
  'server/patches must match the CLI engine patches pinned in pinnedEngineProvenance.ts',
);
for (const name of patchFiles) {
  const digest = createHash('sha256')
    .update(await readFile(join(patchDirectory, name)))
    .digest('hex');
  assert.equal(digest, pinnedPatches[name], `${name} changed without updating its pinned digest`);
}

console.log(
  `Web security contract verified (CSP, local XR assets, exact UI pins, ${patchFiles.length} pinned engine patches).`,
);

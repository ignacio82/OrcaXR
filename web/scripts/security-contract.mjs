#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

console.log('Web security contract verified (CSP, local XR assets, exact UI pins).');

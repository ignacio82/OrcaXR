#!/usr/bin/env node
// Mutate generated inputs, without instantiating an engine or altering originals.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.argv.length, 3, 'Expected a generated fixture manifest path');
const manifestPath = resolve(process.argv[2]);
const original = JSON.parse(readFileSync(manifestPath, 'utf8'));
const runner = fileURLToPath(new URL('./slice-reference.mjs', import.meta.url));
let passed = 0;
function check(label, mutate, accepted) {
  const temporary = mkdtempSync(resolve(tmpdir(), 'orcaxr-slice-input-'));
  try {
    const manifest = structuredClone(original);
    for (const fixture of manifest.fixtures) for (const kind of ['archive', 'overrides']) {
      copyFileSync(resolve(dirname(manifestPath), fixture[kind].path), resolve(temporary, fixture[kind].path));
    }
    mutate(manifest, temporary);
    const path = resolve(temporary, 'manifest.json');
    writeFileSync(path, JSON.stringify(manifest));
    const result = spawnSync(process.execPath, [runner, path, '--check-inputs'],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 64 * 1024 });
    assert.equal(result.error, undefined, 'input guard process completed within its bounds');
    assert.equal(result.signal, null);
    assert.equal(result.status === 0, accepted, label);
    passed += 1;
    console.log(`Input guard passed: ${label}`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
check('valid captured inputs', () => {}, true);
check('changed archive bytes', (manifest, directory) => {
  const path = resolve(directory, manifest.fixtures[0].archive.path);
  const bytes = readFileSync(path);
  bytes[bytes.length - 1] ^= 1;
  writeFileSync(path, bytes);
}, false);
check('changed override bytes', (manifest, directory) =>
  writeFileSync(resolve(directory, manifest.fixtures[0].overrides.path), '{"wall_loops":"9"}\n'), false);
check('missing later fixture', (manifest, directory) =>
  rmSync(resolve(directory, manifest.fixtures.at(-1).archive.path)), false);
check('duplicate case instead of required feature', (manifest) => { manifest.fixtures[1] = manifest.fixtures[0]; }, false);
check('archive path escapes capture directory', (manifest) => { manifest.fixtures[0].archive.path = '../plain.3mf'; }, false);
check('indirect archive', (manifest, directory) => {
  const path = resolve(directory, manifest.fixtures[0].archive.path);
  rmSync(path);
  symlinkSync(resolve(dirname(manifestPath), manifest.fixtures[0].archive.path), path);
}, false);
console.log(`Verified ${passed} canonical slice input guard cases`);

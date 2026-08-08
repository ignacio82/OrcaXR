#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generated = await readFile(join(root, 'dist', 'sw.js'), 'utf8');
const staticWorker = await readFile(join(root, 'public', 'coi-serviceworker.js'), 'utf8');
const iconFiles = (await readdir(join(root, 'public', 'icons', 'material'))).filter((file) => file.endsWith('.svg'));

assert.match(generated, /orcaxr-slicer/, 'PWA must keep a separate slicer cache');
assert.match(generated, /orcaxr-settings-schema/, 'PWA must keep a bounded runtime settings-schema cache');
assert.doesNotMatch(
  generated,
  /url:["'][^"']*slicer\/(?:slic3r\.mjs|slic3r\.wasm)/,
  'slicer artifacts must not be precached',
);
for (const file of iconFiles) {
  assert(generated.includes(`icons/material/${file}`), `${file} must be available offline`);
}
assert.match(staticWorker, /SLICER_CACHE/);
assert.match(staticWorker, /shell-v2/, 'schema v2 requires the v2 static shell/runtime cache contract');
assert.doesNotMatch(staticWorker, /shell-v1/, 'the schema-v1 shell cache must be retired');
assert.match(staticWorker, /precacheShell/);
assert.match(staticWorker, /cache\.match\(req/);

console.log(`Offline contract verified (${iconFiles.length} XR icons, NetworkFirst slicer).`);

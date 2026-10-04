#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generated = await readFile(join(root, 'dist', 'sw.js'), 'utf8');
const staticWorker = await readFile(join(root, 'public', 'coi-serviceworker.js'), 'utf8');
const iconFiles = (await readdir(join(root, 'public', 'icons', 'material'))).filter((file) => file.endsWith('.svg'));

assert.match(generated, /SKIP_WAITING/, 'application updates must wait for an explicit message');
assert.doesNotMatch(generated, /clientsClaim\(/, 'updates must not automatically replace controlled clients');
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
assert.match(staticWorker, /shell-v3/, 'Rust preview requires the v3 static shell/runtime cache contract');
assert.doesNotMatch(staticWorker, /shell-v[12]/, 'old static shell caches must be retired');
assert.match(staticWorker, /SKIP_WAITING/, 'static updates must use the unsaved-work guard');
assert.doesNotMatch(staticWorker, /precacheShell\(\)\.then/, 'install must not activate an update automatically');
const preview = JSON.parse(await readFile(join(root, 'dist', 'core-preview-assets.json'), 'utf8'));
assert.equal(preview.schemaVersion, 1);
assert.equal(preview.workerProtocol, 2);
assert.ok(preview.assets.some((asset) => /gcodePreview\.worker-.*\.js$/.test(asset)));
assert.ok(preview.assets.some((asset) => /WorkerGcodePreviewSession-.*\.js$/.test(asset)));
assert.ok(preview.assets.includes(`core/${preview.coreSet}/orcaxr_core_bg.wasm`));
assert.ok(preview.assets.includes(`core/${preview.coreSet}/core-wasm-manifest.json`));
for (const asset of preview.assets) {
  await readFile(join(root, 'dist', asset));
  assert.ok(generated.includes(asset), `${asset} must be precached for the first offline preview`);
}
assert.match(staticWorker, /precacheShell/);
assert.match(staticWorker, /cache\.match\(req/);

console.log(`Offline contract verified (${iconFiles.length} XR icons, NetworkFirst slicer).`);

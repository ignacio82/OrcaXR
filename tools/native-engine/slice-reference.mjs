#!/usr/bin/env node
// Generate browser-engine references for the exact canonical fixture bytes.
// Each slice runs in a separate owned process so its WASM heap/workers terminate.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readArtifactManifest, verifyArtifactSet } from '../../wasm/artifact-set.mjs';
import { parseGcodeText } from '../parity-oracles/gcode.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const canonical = readArtifactManifest(resolve(root, 'wasm/artifact-provenance.json'));
const engineSet = verifyArtifactSet(resolve(root, 'wasm/dist'), canonical);

if (process.argv[2] === '--case') {
  const [archive, overrides, output, archiveSha, overridesSha] = process.argv.slice(3);
  assert.ok(archive && overrides && output && process.argv.length === 8);
  const archiveBytes = readFileSync(archive);
  const overrideBytes = readFileSync(overrides);
  assert.equal(sha(archiveBytes), archiveSha);
  assert.equal(sha(overrideBytes), overridesSha);
  const createEngine = (await import(pathToFileURL(resolve(engineSet.directory, 'slic3r.mjs')).href)).default;
  const engine = await createEngine({ print: () => {}, printErr: () => {} });
  engine.FS.writeFile('/tmp/native-reference.3mf', archiveBytes);
  const gcode = engine.sliceProjectSync('/tmp/native-reference.3mf', 1, overrideBytes.toString('utf8'));
  assert.equal(typeof gcode, 'string');
  assert.ok(!gcode.startsWith('ORCAXR_ERROR:') && gcode.length > 0, 'reference slice completed');
  assert.ok(Buffer.byteLength(gcode) <= 128 * 1024 * 1024, 'reference output bound');
  assert.ok(!existsSync(output), 'the reference output is new');
  writeFileSync(output + '.partial', gcode, { flag: 'wx' });
  renameSync(output + '.partial', output);
  // This is an isolated test process. Its engine workers must not outlive the
  // completed file handoff, and there is no live editor state to preserve.
  process.exit(0);
}

assert.ok(process.argv.length === 3 || (process.argv.length === 4 && process.argv[3] === '--check-inputs'),
  'Expected a generated fixture manifest path and optional --check-inputs');
const manifestPath = resolve(process.argv[2]);
const fixtureRoot = dirname(manifestPath);
const fixtureBytes = readFileSync(manifestPath);
const fixtures = JSON.parse(fixtureBytes);
assert.equal(fixtures.schemaVersion, 1);
assert.equal(fixtures.evidenceKind, 'generated-canonical-slice-inputs-only');
assert.equal(fixtures.slicingQualified, false);
const expectedCases = ['plain', 'color-paint', 'fullspectrum-paint', 'object-walls', 'part-infill',
  'height-range', 'support-bare', 'support-enforced', 'support-automatic', 'support-blocked', 'wave-overhang'];
assert.deepEqual(fixtures.fixtures.map(({ id }) => id).sort(), [...expectedCases].sort());
// Validate every captured input before creating or replacing reference outputs.
// A later corrupt fixture must not leave a partially regenerated evidence set.
const prepared = fixtures.fixtures.map((fixture) => {
  const paths = {};
  for (const kind of ['archive', 'overrides']) {
    const entry = fixture[kind];
    assert.equal(entry.path, fixture.id + (kind === 'archive' ? '.3mf' : '.json'));
    const path = resolve(fixtureRoot, entry.path);
    const stat = lstatSync(path);
    assert.ok(stat.isFile() && stat.size > 0 && stat.size <= (kind === 'archive' ? 512 : 1) * 1024 * 1024,
      'fixture input is a bounded regular file');
    const bytes = readFileSync(path);
    assert.equal(bytes.length, entry.bytes);
    assert.equal(sha(bytes), entry.sha256);
    paths[kind] = path;
  }
  return { fixture, paths };
});
if (process.argv[3] === '--check-inputs') {
  console.log(`Verified ${prepared.length} canonical fixture input pairs`);
  process.exit(0);
}
const identity = { fixtureManifestSha256: sha(fixtureBytes), engineIdentity: engineSet.identity,
  runnerSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
  oracleSha256: sha(readFileSync(resolve(root, 'tools/parity-oracles/gcode.mjs'))) };
const output = resolve(here, 'build/references', sha(JSON.stringify(identity)));
mkdirSync(output, { recursive: true });
const reportPath = resolve(output, 'manifest.json');
rmSync(reportPath, { force: true });
const entries = [];
const gcodeById = new Map();
for (const { fixture, paths } of prepared) {
  const destination = resolve(output, fixture.id + '.gcode');
  // A failed/repeated diagnostic owns only its recipe directory and never
  // publishes a result manifest before all cases and semantic checks pass.
  rmSync(destination, { force: true });
  rmSync(destination + '.partial', { force: true });
  try {
    execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--case', paths.archive, paths.overrides, destination,
      fixture.archive.sha256, fixture.overrides.sha256],
      { cwd: root, timeout: 180_000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new Error(`Reference engine failed or exceeded its bounds for fixture ${fixture.id}`);
  }
  const gcode = readFileSync(destination, 'utf8');
  const summary = parseGcodeText(gcode);
  assert.ok(summary.layers.length > 0 && summary.extrusion.total > 0, 'the reference contains a real print');
  entries.push({ id: fixture.id, path: fixture.id + '.gcode', sha256: sha(gcode), bytes: Buffer.byteLength(gcode), summary });
  gcodeById.set(fixture.id, gcode);
  console.log(`Reference slice passed: ${fixture.id}`);
}
// Assert actual feature effects separately from future native/reference agreement.
const tools = (id) => (gcodeById.get(id).match(/^T\d+\s*$/gm) ?? []).length;
const material = (id) => {
  const match = /^; filament used \[mm\] = ([\d.]+)/m.exec(gcodeById.get(id));
  assert.ok(match);
  return Number(match[1]);
};
const support = (id) => /^;TYPE:Support\b/m.test(gcodeById.get(id));
assert.ok(tools('color-paint') > tools('plain'), 'physical facet paint adds tool changes');
assert.ok(tools('fullspectrum-paint') > tools('plain'), 'mixed facet paint adds tool changes');
assert.ok(material('object-walls') > material('plain'), 'object walls affect material');
assert.ok(material('part-infill') > material('plain'), 'part infill affects material');
assert.equal(support('support-bare'), false);
assert.equal(support('support-enforced'), true);
assert.equal(support('support-automatic'), true);
assert.equal(support('support-blocked'), false);
assert.ok(material('support-enforced') > material('support-bare'), 'support contributes material');
assert.ok(material('support-automatic') > material('support-blocked'), 'blocker removes automatic support material');
const zCounts = (id) => {
  let z = 0;
  let band = 0;
  let above = 0;
  for (const match of gcodeById.get(id).matchAll(/^G1\s+Z(-?[\d.]+)/gm)) {
    const next = Number(match[1]);
    if (!Number.isFinite(next) || next === z) continue;
    z = next;
    if (z <= 6) band += 1;
    else if (z <= 20) above += 1;
  }
  return { band, above };
};
const ordinary = zCounts('plain');
const ranged = zCounts('height-range');
assert.ok(ordinary.band > 0 && ranged.band >= ordinary.band * 1.5, 'height-range override adds layers in its band');
assert.equal(ranged.above, ordinary.above, 'layers above the band retain their height');
const waveGcode = gcodeById.get('wave-overhang');
const waveBlocks = [...waveGcode.matchAll(/^; WAVE_OVERHANG_START\r?\n([\s\S]*?)^; WAVE_OVERHANG_END/gm)];
assert.ok(waveBlocks.length >= 20, 'the wave fixture fills the shelf with real wave paths');
// The captured U1 profile uses relative extrusion. A header or marker alone is
// insufficient evidence: every block must contain a positive XY extrusion.
assert.ok(/^M83\b/m.test(waveGcode) && !/^M82\b/m.test(waveGcode), 'the fixture uses relative extrusion');
for (const [, block] of waveBlocks) {
  const moves = [...block.matchAll(/^G1\s+([^;\n]+)/gm)].map(([, move]) =>
    Object.fromEntries([...move.matchAll(/([XYZEF])(-?[\d.]+)/g)].map(([, key, value]) => [key, Number(value)])));
  assert.ok(moves.some((move) => (move.X !== undefined || move.Y !== undefined) && move.E > 0),
    'every wave block extrudes along a real path');
}
assert.ok(!/^; WAVE_OVERHANG_START/m.test(gcodeById.get('support-bare')), 'the same shape emits no waves when disabled');
const report = { schemaVersion: 1, evidenceKind: 'published-wasm-fixture-reference-only', ...identity,
  engineArtifacts: engineSet.artifacts, fixtures: entries, nativeSlicingQualified: false };
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(`Verified canonical slice reference set: ${reportPath}`);

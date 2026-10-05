#!/usr/bin/env node
// Run through the repository's pinned tsx loader. Fixture archives come from
// the existing canonical serializer and engine test harness, not a second model.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CUBE_FACES, baseSliceConfig, buildSliceArchive } from '../../web/src/project/__tests__/sliceHarness.ts';
import { createProjectFixture } from '../../web/src/project/__tests__/fixtures.ts';
import { contentDigest } from '../../web/src/project/assets.ts';
import { projectFingerprint } from '../../web/src/project/domain/canonical.ts';
import { emptyFacetAnnotations } from '../../web/src/project/domain/model.ts';
import { Bbs3mfProjectSerializer } from '../../web/src/project/serialization/Bbs3mfProjectSerializer.ts';
import { ProfileCatalog } from '../../web/src/slicer/ProfileLoader.ts';
import { readSafeZip } from '../../web/src/project/serialization/deterministicZip.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const catalog = ProfileCatalog.fromRaw(JSON.parse(await readFile(resolve(root, 'web/public/profiles/catalog.json'), 'utf8')));
assert.ok(catalog.find('Snapmaker U1 (0.4 nozzle)', '', ''), 'the requested pinned fixture profile exists');
const rangeId = createProjectFixture().ids.range;
// The same closed L-section used by the existing wave test: a 15 mm shelf
// attached to a 10 mm pillar, with 20 mm depth. The support harness's two boxes
// touch only at an edge and cannot seed wave paths from a supported region.
// Use one manifold solid for every overhang comparison here.
const armBottom = [4, 5];
async function buildCantileverArchive(options) {
  const profile = [[0, 0], [10, 0], [10, 8], [25, 8], [25, 11], [0, 11]];
  const points = [0, 20].flatMap((y) => profile.map(([x, z]) => [x, y, z]));
  const faces = [];
  for (let i = 0; i < 6; i += 1) {
    const j = (i + 1) % 6;
    faces.push([i, j + 6, j], [i, i + 6, j + 6]);
  }
  for (const [i, j, k] of [[0, 1, 2], [0, 2, 5], [2, 3, 4], [2, 4, 5]]) {
    faces.push([i, j, k], [i + 6, k + 6, j + 6]);
  }
  const edges = new Map();
  let signedVolume6 = 0;
  for (const face of faces) {
    for (let i = 0; i < 3; i += 1) {
      const a = face[i], b = face[(i + 1) % 3];
      const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
      const edge = edges.get(key) ?? { uses: 0, winding: 0 };
      edge.uses += 1;
      edge.winding += a < b ? 1 : -1;
      edges.set(key, edge);
    }
    const [a, b, c] = face.map((index) => points[index]);
    signedVolume6 += a[0] * (b[1] * c[2] - b[2] * c[1]) +
      a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  assert.ok([...edges.values()].every(({ uses, winding }) => uses === 2 && winding === 0));
  assert.equal(signedVolume6 / 6, 3100, 'closed outward-facing cantilever volume in mm³');
  const bytes = new Uint8Array(faces.length * 36);
  const view = new DataView(bytes.buffer);
  faces.flatMap((face) => face.flatMap((index) => points[index])).forEach((value, index) =>
    view.setFloat32(index * 4, value, true));
  const { state, asset } = createProjectFixture();
  const descriptor = { ...asset.descriptor, digest: contentDigest(bytes), byteLength: bytes.length,
    sourceFilename: 'closed-cantilever.stl', mesh: { triangleCount: faces.length,
      positions: { byteOffset: 0, byteLength: bytes.length, componentType: 'float32',
        componentCount: 3, count: faces.length * 3 } } };
  state.sourceAssets = [descriptor];
  state.config = { ...(await baseSliceConfig()), ...options.config };
  for (const plate of state.plates) {
    plate.config = {};
    for (const object of plate.objects) {
      object.config = {};
      object.layerRanges = [];
      for (const volume of object.volumes) {
        volume.source = { assetId: descriptor.id, topologyRevision: 0, triangleCount: faces.length };
        volume.config = {};
        const empty = emptyFacetAnnotations(0);
        volume.annotations = options.annotations ? options.annotations(empty) : empty;
      }
    }
  }
  return (await new Bbs3mfProjectSerializer().serialize({ state,
    assets: [{ descriptor, bytes }], sourceRevision: 1, sourceHash: projectFingerprint(state) })).bytes;
}
function paint(state, mixed) {
  const filament = mixed ? state.filaments.mixed[0] : state.filaments.physical[1];
  assert.ok(filament);
  for (const plate of state.plates) for (const object of plate.objects) for (const volume of object.volumes) {
    volume.annotations.color = [{ triangles: [...CUBE_FACES.top], value: filament.id }];
  }
}
const manualSupport = { enable_support: '1', support_type: 'normal(manual)' };
const automaticSupport = { enable_support: '1', support_type: 'normal(auto)' };
const cases = [
  { id: 'plain', options: {}, intent: 'Baseline canonical project with physical and mixed filament definitions' },
  { id: 'color-paint', options: { mutate: (state) => paint(state, false) }, intent: 'Physical filament assignment on top facets' },
  { id: 'fullspectrum-paint', options: { mutate: (state) => paint(state, true) }, intent: 'Stable mixed filament assignment on top facets' },
  { id: 'object-walls', options: { objectConfig: { wall_loops: 5 } }, intent: 'Object-scoped wall count' },
  { id: 'part-infill', options: { partConfig: { sparse_infill_density: '60%' } }, intent: 'Part-scoped infill density' },
  { id: 'height-range', options: { config: { layer_height: '0.2' }, mutate: (state) => {
    for (const plate of state.plates) for (const object of plate.objects) {
      object.layerRanges = [{ id: rangeId, minZMm: 0, maxZMm: 6, config: { layer_height: 0.1 } }];
    }
  } }, intent: 'Fine layers below 6 mm with normal layers above the band' },
  { id: 'support-bare', options: { cantilever: true, config: manualSupport }, intent: 'Manual-support baseline on a real overhang' },
  { id: 'support-enforced', options: { cantilever: true, config: manualSupport,
    annotations: (empty) => ({ ...empty, support: [{ triangles: armBottom, value: 'enforce' }] }) },
    intent: 'Painted support under the cantilever arm' },
  { id: 'support-automatic', options: { cantilever: true, config: automaticSupport },
    intent: 'Automatic-support baseline that a painted blocker must remove' },
  { id: 'support-blocked', options: { cantilever: true, config: automaticSupport,
    annotations: (empty) => ({ ...empty, support: [{ triangles: armBottom, value: 'block' }] }) },
    intent: 'Painted blocker removes otherwise automatic support under the same arm' },
  { id: 'wave-overhang', options: { cantilever: true,
    config: { wave_overhangs: '1', wave_overhangs_instead_of_bridges: '1', wave_overhang_debug_gcode: '1' } },
    intent: 'Current shared wave-overhang implementation on a cantilever' },
];

// Bind transitive project/profile source inputs conservatively. This is build
// provenance, separate from the canonical FNV source/project identities.
const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard',
  'web/src', 'web/public/profiles', 'web/package-lock.json', 'tools/native-engine/generate-slice-fixtures.mjs'],
  { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const sourceInputs = Object.fromEntries(await Promise.all([...new Set(paths)].sort().map(async (path) =>
  [path, sha(await readFile(resolve(root, path)))])));
const sourceIdentity = sha(JSON.stringify(sourceInputs));
const directory = resolve(root, 'tools/native-engine/build/fixtures', sourceIdentity);
await mkdir(directory, { recursive: true });
await rm(resolve(directory, 'manifest.json'), { force: true });
const entries = [];
for (const fixture of cases) {
  const build = fixture.options.cantilever ? buildCantileverArchive : buildSliceArchive;
  const bytes = await build({ ...fixture.options,
    config: { layer_height: '0.2', ...(fixture.options.config ?? {}) } });
  const files = readSafeZip(bytes);
  const envelope = JSON.parse(new TextDecoder().decode(files.get('Metadata/orcaxr/project-v1.json')));
  assert.equal(envelope.state.plates.length, 1);
  assert.ok(files.has('Metadata/project_settings.config'));
  assert.ok(files.has('Metadata/model_settings.config'));
  const archive = fixture.id + '.3mf';
  const overrides = fixture.id + '.json';
  const overrideBytes = Buffer.from('{}\n');
  await writeFile(resolve(directory, archive), bytes);
  await writeFile(resolve(directory, overrides), overrideBytes);
  entries.push({ id: fixture.id, intent: fixture.intent,
    archive: { path: archive, bytes: bytes.length, sha256: sha(bytes) },
    overrides: { path: overrides, bytes: overrideBytes.length, sha256: sha(overrideBytes) } });
}
const manifest = { schemaVersion: 1, evidenceKind: 'generated-canonical-slice-inputs-only',
  hostSourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  inputSetSha256: sourceIdentity, sourceInputs, fixtures: entries, slicingQualified: false };
await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Generated ${entries.length} canonical slice fixtures: ${directory}`);

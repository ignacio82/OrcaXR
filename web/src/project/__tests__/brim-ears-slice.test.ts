/**
 * What the engine does with a placed brim ear (parity P5.3.6).
 *
 * P5.3.6's Accept clause is "placed ears reach the engine and the sliced result
 * shows them". Nothing had ever asked the slicer, so this does — headlessly,
 * through the same pinned WASM engine the app ships, which is the first time
 * this repo has driven the engine outside a browser.
 *
 * The answer is that the first half holds and the second does not, and both
 * halves are asserted here rather than assumed:
 *
 * - The archive carries `Metadata/brim_ear_points.txt` in the pinned format,
 *   keyed by the 1-based model-object index the pinned reader looks up
 *   (`bbs_3mf.cpp:2021`, `m_brim_ear_points.find(object.second + 1)`).
 * - `brim_type` reaches the engine as `painted`, which is the value that
 *   consumes *placed* points; `brim_ears` (`btEar`) is the automatic corner
 *   detector and ignores them (`Brim.cpp:929-930`).
 * - And yet the sliced result contains no brim at all, and the first layer
 *   extrudes exactly as much without the ears as with them.
 *
 * That last assertion is deliberately a tripwire on a known gap rather than a
 * claim that the behaviour is correct. When placed ears do start reaching the
 * print, this test fails, and whoever fixed it updates the claim here and in
 * `docs/parity.md` instead of the gap quietly closing unrecorded.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { resolve } from 'node:path';

import { Bbs3mfProjectSerializer } from '../serialization/Bbs3mfProjectSerializer';
import { contentDigest } from '../assets';
import { cloneProjectState, projectFingerprint } from '../domain/canonical';
import { emptyFacetAnnotations } from '../domain/model';
import { ProfileCatalog } from '../../slicer/ProfileLoader';
import { createProjectFixture } from './fixtures';
import type { BrimEarPoint } from '../domain/model';
import type { ProjectArchiveSnapshot } from '..';

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const CUBE_MM = 20;

/** A closed axis-aligned cube, as the indexed float32 mesh the archive stores. */
function cubeMesh(): { bytes: Uint8Array; triangleCount: number } {
  const p: [number, number, number][] = [
    [0, 0, 0],
    [CUBE_MM, 0, 0],
    [CUBE_MM, CUBE_MM, 0],
    [0, CUBE_MM, 0],
    [0, 0, CUBE_MM],
    [CUBE_MM, 0, CUBE_MM],
    [CUBE_MM, CUBE_MM, CUBE_MM],
    [0, CUBE_MM, CUBE_MM],
  ];
  const faces = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [1, 2, 6],
    [1, 6, 5],
    [2, 3, 7],
    [2, 7, 6],
    [3, 0, 4],
    [3, 4, 7],
  ];
  const vertices = faces.flat().map((index) => p[index]);
  const bytes = new Uint8Array(vertices.length * 12);
  const view = new DataView(bytes.buffer);
  vertices.forEach((vertex, vertexIndex) => {
    vertex.forEach((coordinate, component) => {
      view.setFloat32(vertexIndex * 12 + component * 4, coordinate, true);
    });
  });
  return { bytes, triangleCount: faces.length };
}

/** The flattened engine config for a real catalog profile, so the slice is a real slice. */
async function baseConfig(): Promise<Record<string, string>> {
  const raw = JSON.parse(
    await readFile(resolve(import.meta.dirname, '../../../public/profiles/catalog.json'), 'utf8'),
  ) as unknown;
  const catalog = ProfileCatalog.fromRaw(raw);
  const profile = catalog.find('Snapmaker U1 (0.4 nozzle)', '', '') ?? catalog.profiles[0];
  assert.ok(profile, 'the bundled catalog offers a profile to slice with');
  return { ...profile.config };
}

/**
 * The shared fixture with its triangle swapped for a cube and its config taken
 * from a real profile — starting from the fixture is what keeps this a valid
 * canonical state rather than a hand-built approximation of one.
 */
async function buildArchive(ears: readonly BrimEarPoint[]): Promise<Uint8Array> {
  const fixture = createProjectFixture();
  const mesh = cubeMesh();
  const descriptor = {
    ...fixture.asset.descriptor,
    digest: contentDigest(mesh.bytes),
    byteLength: mesh.bytes.byteLength,
    sourceFilename: 'cube.stl',
    mesh: {
      positions: {
        byteOffset: 0,
        byteLength: mesh.bytes.byteLength,
        componentType: 'float32',
        componentCount: 3,
        count: mesh.triangleCount * 3,
      },
      triangleCount: mesh.triangleCount,
    },
  } as typeof fixture.asset.descriptor;

  const config = await baseConfig();
  // `painted` is the value that consumes *placed* points: the pinned engine
  // gates them on `brim_type == btPainted` (Brim.cpp:929), while `brim_ears`
  // (btEar) is the automatic corner detector that ignores them. Getting this
  // wrong produces a clean slice with no ear and no error, which is exactly
  // why this test compares two runs rather than trusting one.
  config.brim_type = 'painted';
  config.brim_width = '0';

  const state = cloneProjectState(fixture.state);
  state.config = config as never;
  state.sourceAssets = [descriptor];
  for (const plate of state.plates) {
    plate.config = {};
    for (const object of plate.objects) {
      object.config = {};
      object.layerRanges = [];
      if (ears.length > 0) object.brimEars = ears.map((ear) => ({ ...ear }));
      else delete object.brimEars;
      for (const volume of object.volumes) {
        volume.source = { assetId: descriptor.id, topologyRevision: 0, triangleCount: mesh.triangleCount };
        volume.config = {};
        volume.annotations = emptyFacetAnnotations(0);
      }
    }
  }

  const snapshot: ProjectArchiveSnapshot = {
    state,
    assets: [{ descriptor, bytes: mesh.bytes }],
    sourceRevision: 1,
    sourceHash: projectFingerprint(state),
  };
  const serialized = await new Bbs3mfProjectSerializer().serialize(snapshot);
  return serialized.bytes;
}

async function slice(archive: Uint8Array, label: string): Promise<string> {
  const createEngine = (await import('../../../public/slicer/slic3r.mjs')).default;
  const engine = await createEngine();
  engine.FS.writeFile(`/tmp/${label}.3mf`, archive);
  const output = engine.sliceProjectSync(`/tmp/${label}.3mf`, 1, '{}');
  if (output.startsWith('ORCAXR_ERROR:')) throw new Error(output.slice('ORCAXR_ERROR:'.length).trim());
  return output;
}

/**
 * Extrusion on the first printed layer — the layer a brim lives on.
 *
 * Counting from the top of the file would measure the start G-code's purge
 * line, which is identical in both runs and would hide the difference; the
 * first `;LAYER_CHANGE` is the boundary between that and the print.
 */
function firstLayerExtrusion(gcode: string): number {
  let total = 0;
  let previous = 0;
  let started = false;
  for (const line of gcode.split('\n')) {
    if (/^;LAYER_CHANGE/.test(line)) {
      if (started) break;
      started = true;
      continue;
    }
    if (!started) continue;
    const match = /^G1\b.*\sE(-?[\d.]+)/.exec(line);
    if (!match) continue;
    const value = Number.parseFloat(match[1]);
    if (!Number.isFinite(value)) continue;
    if (value > previous) total += value - previous;
    previous = value;
  }
  return total;
}

await test('the archive carries placed ears, and the engine currently prints none', async () => {
  const half = CUBE_MM / 2;
  const corners: BrimEarPoint[] = [
    { positionMm: [-half, -half, 0], headFrontRadiusMm: 5 },
    { positionMm: [half, -half, 0], headFrontRadiusMm: 5 },
    { positionMm: [half, half, 0], headFrontRadiusMm: 5 },
    { positionMm: [-half, half, 0], headFrontRadiusMm: 5 },
  ];

  // Half of the Accept clause: the ears are in the archive the engine reads,
  // in the pinned format, under the id the pinned reader resolves.
  const archive = await buildArchive(corners);
  const files = unzipSync(archive);
  const earFile = files['Metadata/brim_ear_points.txt'];
  assert.ok(earFile, 'the archive carries the ear points file');
  const earText = new TextDecoder().decode(earFile);
  assert.match(earText, /^brim_points_format_version=0\n/);
  assert.match(earText, /^object_id=1\|/m, 'the pinned reader looks up a 1-based model-object index');
  assert.equal(
    (earText.match(/-?\d+\.\d{6}/g) ?? []).length,
    corners.length * 4,
    'four values per ear: x, y, z, and the front radius',
  );

  const withEars = await slice(archive, 'with-ears');
  const withoutEars = await slice(await buildArchive([]), 'without-ears');
  assert.ok(withEars.length > 1000 && withoutEars.length > 1000, 'both runs produced real G-code');
  assert.match(withEars, /^; brim_type = painted$/m, 'the value that consumes placed points reached the engine');

  // The other half, which does not hold yet. Asserted as observed so it trips
  // the moment it changes, in either direction.
  assert.equal(/;TYPE:Brim/i.test(withEars), false, 'KNOWN GAP: placed ears produce no brim in the sliced result');
  assert.equal(
    firstLayerExtrusion(withEars),
    firstLayerExtrusion(withoutEars),
    'KNOWN GAP: the first layer is identical with and without ears',
  );
});

console.log(`\nBrim ear slicing: ${passed} tests passed.`);

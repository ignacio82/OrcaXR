/**
 * A height-range override reaches the engine and changes the print (P2.5, P7.1).
 *
 * This is the same class of claim the brim-ear bug hid in: the range is written
 * into `Metadata/layer_config_ranges.xml`, the archive round-trips, and the
 * pinned reader resolves it by the same 1-based model-object index that silently
 * dropped every brim ear (`bbs_3mf.cpp:2016`). An archive assertion proves the
 * file, not the feature — so this asks the engine.
 *
 * The override is `layer_height`, because its effect is unambiguous in the
 * output: halving it below a given Z must roughly double the number of layers
 * printed under that Z, and leave the layers above it alone. A setting whose
 * effect had to be inferred from extrusion widths would make a null result
 * indistinguishable from a weak one.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { unzipSync } from 'fflate';

import { Bbs3mfProjectSerializer } from '../serialization/Bbs3mfProjectSerializer';
import { contentDigest } from '../assets';
import { cloneProjectState, projectFingerprint } from '../domain/canonical';
import { emptyFacetAnnotations } from '../domain/model';
import { ProfileCatalog } from '../../slicer/ProfileLoader';
import { createProjectFixture } from './fixtures';
import type { ProjectArchiveSnapshot } from '..';

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const CUBE_MM = 20;
const RANGE_TOP_MM = 6;
const BASE_LAYER_MM = 0.2;
const RANGE_LAYER_MM = 0.1;

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

async function baseConfig(): Promise<Record<string, string>> {
  const raw = JSON.parse(
    await readFile(resolve(import.meta.dirname, '../../../public/profiles/catalog.json'), 'utf8'),
  ) as unknown;
  const catalog = ProfileCatalog.fromRaw(raw);
  const profile = catalog.find('Snapmaker U1 (0.4 nozzle)', '', '') ?? catalog.profiles[0];
  assert.ok(profile);
  return { ...profile.config };
}

async function buildArchive(withRange: boolean): Promise<Uint8Array> {
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
  config.layer_height = String(BASE_LAYER_MM);

  const state = cloneProjectState(fixture.state);
  state.config = config as never;
  state.sourceAssets = [descriptor];
  for (const plate of state.plates) {
    plate.config = {};
    for (const object of plate.objects) {
      object.config = {};
      // Reuse the fixture's own stable range id: the canonical validator
      // refuses an invented one, and rightly so.
      const rangeId = fixture.state.plates[0].objects[0].layerRanges[0]?.id;
      assert.ok(rangeId, 'the fixture provides a stable range id');
      object.layerRanges = withRange
        ? [{ id: rangeId, minZMm: 0, maxZMm: RANGE_TOP_MM, config: { layer_height: RANGE_LAYER_MM } }]
        : [];
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
  return (await new Bbs3mfProjectSerializer().serialize(snapshot)).bytes;
}

async function slice(archive: Uint8Array, label: string): Promise<string> {
  const createEngine = (await import('../../../public/slicer/slic3r.mjs')).default;
  const engine = await createEngine();
  engine.FS.writeFile(`/tmp/${label}.3mf`, archive);
  const output = engine.sliceProjectSync(`/tmp/${label}.3mf`, 1, '{}');
  if (output.startsWith('ORCAXR_ERROR:')) throw new Error(output.slice('ORCAXR_ERROR:'.length).trim());
  return output;
}

/** How many layers the program prints below `limitMm`, read from its own Z moves. */
function layersBelow(gcode: string, limitMm: number): number {
  let layers = 0;
  let z = 0;
  for (const line of gcode.split('\n')) {
    const match = /^G1\s+Z(-?[\d.]+)/.exec(line);
    if (!match) continue;
    const next = Number.parseFloat(match[1]);
    if (!Number.isFinite(next) || next === z) continue;
    z = next;
    if (z <= limitMm) layers += 1;
  }
  return layers;
}

await test('a height range reaches the engine and changes the layers in its band', async () => {
  const archive = await buildArchive(true);
  const files = unzipSync(archive);
  const rangeFile = files['Metadata/layer_config_ranges.xml'];
  assert.ok(rangeFile, 'the archive carries the height-range file');
  const rangeText = new TextDecoder().decode(rangeFile);
  assert.match(rangeText, /layer_height/, 'and the override it holds');

  const withRange = await slice(archive, 'with-range');
  const withoutRange = await slice(await buildArchive(false), 'without-range');

  const bandWith = layersBelow(withRange, RANGE_TOP_MM);
  const bandWithout = layersBelow(withoutRange, RANGE_TOP_MM);
  assert.ok(bandWith > 0 && bandWithout > 0, 'both runs print inside the band');

  // Halving the layer height in the band must roughly double its layer count.
  // The bound is loose on purpose: the first layer keeps its own height and the
  // engine may snap the band edge, so an exact ratio would be a claim about
  // rounding rather than about the override being applied.
  assert.ok(bandWith >= bandWithout * 1.5, `the override must thicken the band: ${bandWith} layers vs ${bandWithout}`);

  // And it is confined to the band: the two programs must still reach the same
  // top, or the override leaked into the whole object.
  const topWith = layersBelow(withRange, CUBE_MM);
  const topWithout = layersBelow(withoutRange, CUBE_MM);
  assert.ok(
    topWith - bandWith === topWithout - bandWithout,
    `above the band both runs print the same layers: ${topWith - bandWith} vs ${topWithout - bandWithout}`,
  );
});

console.log(`\nLayer range slicing: ${passed} tests passed.`);

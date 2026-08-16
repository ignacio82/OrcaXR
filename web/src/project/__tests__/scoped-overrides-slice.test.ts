/**
 * Scoped overrides reach the engine and change the print (P2.5, P6.5, P7.1).
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

interface ArchiveOptions {
  readonly range?: boolean;
  readonly objectConfig?: Record<string, unknown>;
  readonly plateConfig?: Record<string, unknown>;
  readonly partConfig?: Record<string, unknown>;
}

async function buildArchive(options: ArchiveOptions = {}): Promise<Uint8Array> {
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
    plate.config = (options.plateConfig ?? {}) as never;
    for (const object of plate.objects) {
      object.config = (options.objectConfig ?? {}) as never;
      // Reuse the fixture's own stable range id: the canonical validator
      // refuses an invented one, and rightly so.
      const rangeId = fixture.state.plates[0].objects[0].layerRanges[0]?.id;
      assert.ok(rangeId, 'the fixture provides a stable range id');
      object.layerRanges =
        options.range === true
          ? [{ id: rangeId, minZMm: 0, maxZMm: RANGE_TOP_MM, config: { layer_height: RANGE_LAYER_MM } }]
          : [];
      for (const volume of object.volumes) {
        volume.source = { assetId: descriptor.id, topologyRevision: 0, triangleCount: mesh.triangleCount };
        volume.config = (options.partConfig ?? {}) as never;
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

async function slice(archive: Uint8Array, label: string, overrides: Record<string, string> = {}): Promise<string> {
  const createEngine = (await import('../../../public/slicer/slic3r.mjs')).default;
  const engine = await createEngine();
  engine.FS.writeFile(`/tmp/${label}.3mf`, archive);
  const output = engine.sliceProjectSync(`/tmp/${label}.3mf`, 1, JSON.stringify(overrides));
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
  const archive = await buildArchive({ range: true });
  const files = unzipSync(archive);
  const rangeFile = files['Metadata/layer_config_ranges.xml'];
  assert.ok(rangeFile, 'the archive carries the height-range file');
  const rangeText = new TextDecoder().decode(rangeFile);
  assert.match(rangeText, /layer_height/, 'and the override it holds');

  const withRange = await slice(archive, 'with-range');
  const withoutRange = await slice(await buildArchive(), 'without-range');

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

await test('an object-scope override reaches the engine and changes the walls', async () => {
  // Same class of claim, different scope: P6.5 proves the canonical state and
  // the generated config, and the archive round-trips — none of which says the
  // engine honoured it. `wall_loops` is chosen because its effect is countable:
  // more loops means more inner-wall extrusion sections in the program.
  const plain = await slice(await buildArchive(), 'walls-default');
  const thick = await slice(await buildArchive({ objectConfig: { wall_loops: 5 } }), 'walls-five');

  // Counting `;TYPE:Inner wall` markers would count *sections*, one per layer
  // either way; the loops live inside them. The engine's own filament total is
  // the honest measure of "more wall".
  const filamentUsed = (gcode: string): number => {
    const match = /^; filament used \[mm\] = ([\d.]+)/m.exec(gcode);
    assert.ok(match, 'the engine reports its own filament total');
    return Number.parseFloat(match[1]);
  };
  assert.ok(filamentUsed(plain) > 0, 'the default run extrudes at all');
  assert.ok(
    filamentUsed(thick) > filamentUsed(plain),
    `five wall loops must use more filament than the default: ${filamentUsed(thick)} vs ${filamentUsed(plain)}`,
  );

  // And the object override is what did it, not a project-wide change: the
  // programs still print the same number of layers.
  assert.equal(
    layersBelow(thick, CUBE_MM),
    layersBelow(plain, CUBE_MM),
    'an object override must not change the layer count',
  );
});

await test('a part scope reaches the engine; a plate scope is discarded by the WASM entry', async () => {
  // The remaining two of P6.5's five scopes. Both are measured with the
  // engine's own reported totals rather than by counting section markers,
  // which count once per layer whatever the setting says.
  const filamentUsed = (gcode: string): number => {
    const match = /^; filament used \[mm\] = ([\d.]+)/m.exec(gcode);
    assert.ok(match, 'the engine reports its own filament total');
    return Number.parseFloat(match[1]);
  };

  const plain = await slice(await buildArchive(), 'scope-default');

  // A plate-scope override has to use a key the plate actually owns: the
  // generated table gives it exactly eight, and infill density is not among
  // them — a first attempt used one and the serializer rightly dropped it.
  // `spiral_mode` is unmistakable in the totals: a vase is one wall and no
  // infill, so it uses far less material for the same solid.
  //
  // KNOWN GAP, with a located cause. The archive does carry plate settings —
  // `buildBbsCore` writes them under `<plate>` in `model_settings.config` — and
  // the engine does parse them, into `PlateDataPtrs`. But the WASM entry point
  // deletes that structure immediately after loading and never applies it
  // (`wasm/slic3r_wasm.cpp:346`), so the slice runs on the project config
  // alone. Closing it needs a change to the C++ entry and a rebuilt engine
  // artifact, which is not something a test can do.
  //
  // Asserted as observed so it trips the moment the behaviour changes.
  const vasePlate = await slice(await buildArchive({ plateConfig: { spiral_mode: '1' } }), 'scope-plate');
  assert.equal(
    filamentUsed(vasePlate),
    filamentUsed(plain),
    'the archive alone does not carry a plate override into the slice',
  );

  // The route the fix uses: the engine slices exactly one plate, so that
  // plate's own overrides are handed to it through the same override channel
  // every slice already uses. This proves the mechanism reaches the print.
  const vaseByOverride = await slice(await buildArchive(), 'scope-plate-override', { spiral_mode: '1' });
  assert.ok(
    filamentUsed(vaseByOverride) < filamentUsed(plain) / 2,
    `the override channel must reach the print: ${filamentUsed(vaseByOverride)} vs ${filamentUsed(plain)}`,
  );

  // A part-scope override on the only volume in the object.
  const densePart = await slice(await buildArchive({ partConfig: { sparse_infill_density: '60%' } }), 'scope-part');
  assert.ok(
    filamentUsed(densePart) > filamentUsed(plain),
    `a part override must reach the print: ${filamentUsed(densePart)} vs ${filamentUsed(plain)}`,
  );

  // The part override changes what fills the solid, not its height.
  assert.equal(layersBelow(densePart, CUBE_MM), layersBelow(plain, CUBE_MM));
});

console.log(`\nScoped override slicing: ${passed} tests passed.`);

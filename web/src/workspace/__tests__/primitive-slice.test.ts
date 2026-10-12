/**
 * Every stock primitive slices, on any plate, alone and as one plate of
 * Slice All Plates.
 *
 * The primitives were stored as the triangle soup three's generators hand
 * over (`toNonIndexed()`): no two triangles shared a vertex, and the shapes
 * that wrap around repeat their seam vertices with float noise. The pinned
 * engine sliced only the cube; a cylinder, cone, sphere or disc came back as
 * "The print is empty. The model is not printable with current print
 * settings.", and a torus lost layers. On Android this surfaced as Slice All
 * Plates failing for a cylinder added on a second plate. The controller now
 * welds a geometry into one closed surface before storing it
 * (`meshWeld.ts`), and the shared core's primitives do the same.
 *
 * Each claim is put to the shipped engine: the plate the browser projects
 * for a slice (`projectPlateArchiveForSlice`, the archive both Android routes
 * slice too) is serialized and sliced, and every layer the engine reports
 * must carry extrusion.
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { seededRandom, UuidIdSource, type PlateId } from '../../project/domain/ids';
import {
  primitiveFileName,
  primitiveGeometry,
  PRIMITIVE_KINDS,
  type PrimitiveKind,
} from '../../project/objects/primitives';
import { weldTriangleMesh } from '../../project/meshWeld';
import { Bbs3mfProjectSerializer } from '../../project/serialization/Bbs3mfProjectSerializer';
import { projectPlateArchiveForSlice } from '../../project/slicing/plateProjection';
import { selectPlateIds } from '../../project/slicing/SliceJobCoordinator';
import { baseSliceConfig, sliceArchive } from '../../project/__tests__/sliceHarness';
import { CanonicalWorkspaceController } from '../CanonicalWorkspaceController';
import { geometryBedPlacement } from '../geometryPlacement';
import { workspaceBed } from '../WorkspaceBed';

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function workspace() {
  const controller = CanonicalWorkspaceController.createEmpty({
    idSource: new UuidIdSource(seededRandom(0x51ce)),
    clock: () => '2026-10-11T00:00:00.000Z',
    parent: new THREE.Scene(),
    mapping: { bedSizeMm: [270, 270], worldUnitsPerMm: 0.00175 },
  });
  const current = controller.getSlicingConfiguration();
  await controller.applySlicingConfiguration({
    ...current,
    config: { ...current.config, ...(await baseSliceConfig()) },
  });
  return controller;
}

/** `OrcaWorkspace.addPrimitive`: the shape centred on the placement area and resting on the bed, on the active plate. */
async function addPrimitive(controller: CanonicalWorkspaceController, kind: PrimitiveKind) {
  const geometry = primitiveGeometry(kind);
  const name = primitiveFileName(kind);
  const area = workspaceBed(controller.getSlicingConfiguration().config).areaMm;
  return controller.importGeometry(geometry, {
    name,
    sourceFilename: name,
    transform: geometryBedPlacement(geometry, area),
  });
}

/** The project as a slice reads it. */
const stateOf = (controller: CanonicalWorkspaceController) => controller.createCanonicalSliceSource().capture().state;

/** The plates a slice of [scope] slices (`selectPlateIds`). */
function plan(controller: CanonicalWorkspaceController, scope: 'current-plate' | 'all-plates'): PlateId[] {
  const state = stateOf(controller);
  return selectPlateIds(state.activePlateId, state.plates, scope);
}

/** The plate as a slice of it reads it, through the shipped engine. */
async function slicePlate(controller: CanonicalWorkspaceController, plateId: PlateId, label: string): Promise<string> {
  const projection = projectPlateArchiveForSlice(controller.createCanonicalSliceSource().capture(), plateId);
  return sliceArchive((await new Bbs3mfProjectSerializer().serialize(projection.archive)).bytes, label);
}

/**
 * The engine's stated layer count; each layer it changes to carries extrusion
 * (an "empty layer" is one it does not) but the last two, where a cone's apex
 * is narrower than any line. The markers may fall a few short of the stated
 * total, as the status line's own count does.
 */
function layers(gcode: string): number {
  const stated = /^; total layers count = (\d+)/m.exec(gcode);
  assert.ok(stated, 'the engine states its layer count');
  const total = Number(stated[1]);
  const blocks = gcode.split(/^;LAYER_CHANGE$/m).slice(1);
  assert.ok(
    blocks.length > 0 && blocks.length <= total && blocks.length >= total - 5,
    `${blocks.length} of ${total} layers`,
  );
  blocks.slice(0, Math.max(1, blocks.length - 2)).forEach((block, index) => {
    assert.match(block, /^G1 [^;\n]*E[\d.]+/m, `layer ${index + 1} of ${blocks.length} extrudes nothing`);
  });
  return total;
}

/** Each undirected edge is shared by exactly two triangles, in opposite directions. */
function closed(positions: Float32Array, indices: Uint32Array): boolean {
  const edges = new Map<string, number>();
  for (let corner = 0; corner < indices.length; corner += 3) {
    for (const [a, b] of [
      [indices[corner], indices[corner + 1]],
      [indices[corner + 1], indices[corner + 2]],
      [indices[corner + 2], indices[corner]],
    ]) {
      edges.set(`${a}:${b}`, (edges.get(`${a}:${b}`) ?? 0) + 1);
    }
  }
  return (
    positions.length > 0 &&
    [...edges].every(([edge, count]) => count === 1 && edges.get(edge.split(':').reverse().join(':')) === 1)
  );
}

await test('the stored mesh of every primitive is one closed surface', async () => {
  for (const kind of PRIMITIVE_KINDS) {
    const soup = Float32Array.from(primitiveGeometry(kind).getAttribute('position').array);
    const corners = Uint32Array.from({ length: soup.length / 3 }, (_, index) => index);
    assert.ok(!closed(soup, corners), `${kind}: the generator's soup is open, as the engine received it`);
    const welded = weldTriangleMesh(soup, corners);
    assert.equal(welded.indices.length, corners.length, `${kind}: every triangle kept`);
    assert.ok(closed(welded.positions, welded.indices), `${kind}: welded into one closed surface`);
  }
});

await test('every primitive slices, every layer extruding', async () => {
  const controller = await workspace();
  try {
    for (const [index, kind] of PRIMITIVE_KINDS.entries()) {
      const plateId = index === 0 ? stateOf(controller).activePlateId : await controller.addPlate();
      await addPrimitive(controller, kind);
      const count = layers(await slicePlate(controller, plateId, `primitive-${kind}`));
      // Its height in layers no thicker than 0.2 mm nor thinner than 0.05 mm:
      // 20 mm, a torus 5 mm, a disc 0.2 mm.
      const height = kind === 'disc' ? 0.2 : kind === 'torus' ? 5 : 20;
      assert.ok(count >= Math.floor(height / 0.2) && count <= Math.ceil(height / 0.05) + 2, `${kind}: ${count} layers`);
    }
  } finally {
    controller.dispose();
  }
});

await test('a cylinder added on a second plate slices alone and with Slice All Plates', async () => {
  // The Android outputs smoke's journey: a cube, a second plate, a cylinder on
  // it while it is active, then the first plate active again.
  const controller = await workspace();
  try {
    const first = stateOf(controller).activePlateId;
    await addPrimitive(controller, 'cube');
    const second = await controller.addPlate();
    assert.equal(stateOf(controller).activePlateId, second, 'the new plate is active');
    await addPrimitive(controller, 'cylinder');
    // Sliced alone, as Slice slices the active plate.
    assert.deepEqual(plan(controller, 'current-plate'), [second]);
    assert.ok(layers(await slicePlate(controller, second, 'second-alone')) >= 90);
    await controller.activatePlate(first);
    // Slice All Plates: both, in plate order, each its own archive.
    const plates = plan(controller, 'all-plates');
    assert.deepEqual(plates, [first, second]);
    for (const plateId of plates) assert.ok(layers(await slicePlate(controller, plateId, `all-${plateId}`)) >= 90);
  } finally {
    controller.dispose();
  }
});

console.log(`primitive-slice: ${passed} passed`);

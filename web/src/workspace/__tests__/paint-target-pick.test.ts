import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import * as THREE from 'three';
import { ActionContext } from '../../actions/ActionContext';
import { UiState } from '../../actions/UiState';
import { getThreeProjectEntity } from '../../project/surfaces/ThreeProjectSurface';
import { measureSurfaceFeatures, type SurfaceFeature } from '../../project/objects/measure';
import type { CanonicalWorkspaceController } from '../CanonicalWorkspaceController';

class TestAudioContext {
  readonly destination = {};
  readonly listener = {};
  readonly currentTime = 0;

  createGain() {
    return {
      gain: { value: 1, setTargetAtTime() {} },
      connect() {},
      disconnect() {},
    };
  }
}

class TestHtmlElement {}

const browserGlobals: Readonly<Record<string, unknown>> = {
  window: {
    location: { search: '' },
    AudioContext: TestAudioContext,
    addEventListener() {},
    removeEventListener() {},
  },
  document: {},
  navigator: {},
  HTMLElement: TestHtmlElement,
  customElements: { define() {}, get() {} },
  crypto: webcrypto,
};
for (const [name, value] of Object.entries(browserGlobals)) {
  Object.defineProperty(globalThis, name, { value, configurable: true });
}

const [{ OrcaWorkspace }, { buildRegistry }, xb] = await Promise.all([
  import('../OrcaWorkspace'),
  import('../../actions/catalog'),
  import('xrblocks'),
]);

let passed = 0;
async function test(name: string, run: () => Promise<void>) {
  await run();
  passed++;
  console.log(`  ✓ ${name}`);
}

interface PaintInternals {
  canonicalProject: CanonicalWorkspaceController;
  paintStroke: { volumeId: string } | null;
  beginPaintStroke(raycaster: THREE.Raycaster, pointerId: number): boolean;
}

await test('a paint stroke starts on the nearest part the ray meets, not the first in scene order', async () => {
  const registry = buildRegistry();
  const workspace = new OrcaWorkspace(registry);
  workspace.actionContext = new ActionContext(workspace, new UiState(), registry);
  const internals = workspace as unknown as PaintInternals;
  try {
    const controller = internals.canonicalProject;
    const geometry = new THREE.BoxGeometry(10, 10, 10);
    controller.importBufferGeometry(geometry, { name: 'First' });
    controller.importBufferGeometry(geometry, { name: 'Second' });
    geometry.dispose();
    const root = controller.surface.root;
    const meshes = root.children.flatMap((group) => group.children.filter((c) => c instanceof THREE.Mesh));
    assert.equal(meshes.length, 2);
    const [first, second] = meshes;
    // Both import at the same place; set the second part 30 mm aside (the
    // instance group is in printer millimetres).
    second.parent!.position.x += 30;
    root.updateMatrixWorld(true);
    const centre = (mesh: THREE.Object3D) => new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
    const [a, b] = [centre(first), centre(second)];
    // From beyond the second part, through it and on to the first.
    const direction = a.clone().sub(b).normalize();
    const origin = b.clone().addScaledVector(direction, -a.distanceTo(b) * 4);
    const raycaster = new THREE.Raycaster(origin, direction);
    assert.ok(raycaster.intersectObject(first, false).length > 0, 'the ray meets the first part');
    assert.ok(internals.beginPaintStroke(raycaster, 1));
    assert.equal(internals.paintStroke?.volumeId, getThreeProjectEntity(second)?.volumeId);
  } finally {
    workspace.dispose();
  }
});

await test('lay flat turns the nearest part the ray meets, not the first in scene order', async () => {
  const registry = buildRegistry();
  const workspace = new OrcaWorkspace(registry);
  workspace.actionContext = new ActionContext(workspace, new UiState(), registry);
  const internals = workspace as unknown as PaintInternals & {
    layPickedFacetOnBed(raycaster: THREE.Raycaster): Promise<boolean>;
  };
  // Lay flat is an instance action; the gesture supplies the instance.
  workspace.actionContext.ui.update({ hasSelection: true, hasInstanceSelection: true, modelCount: 2 });
  try {
    const controller = internals.canonicalProject;
    const geometry = new THREE.BoxGeometry(10, 10, 10);
    controller.importBufferGeometry(geometry, { name: 'First' });
    controller.importBufferGeometry(geometry, { name: 'Second' });
    geometry.dispose();
    const root = controller.surface.root;
    const meshes = root.children.flatMap((group) => group.children.filter((c) => c instanceof THREE.Mesh));
    const [first, second] = meshes;
    // Set the second part 30 mm aside in the canonical project, so the
    // display and the transform the lay-flat edit starts from agree.
    const instances = meshes.map((mesh) => getThreeProjectEntity(mesh)!.instanceId);
    const before = new Map(
      instances.map((id) => [id, JSON.stringify(controller.getInstanceTransform(id)?.rotation)] as const),
    );
    const secondInstance = getThreeProjectEntity(second)!.instanceId;
    const moved = controller.getInstanceTransform(secondInstance)!;
    await controller.setInstanceTransforms([
      {
        instanceId: secondInstance,
        transform: {
          ...moved,
          translationMm: [moved.translationMm[0] + 30, moved.translationMm[1], moved.translationMm[2]],
        },
      },
    ]);
    root.updateMatrixWorld(true);
    const centre = (mesh: THREE.Object3D) => new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
    const [a, b] = [centre(first), centre(second)];
    const direction = a.clone().sub(b).normalize();
    const origin = b.clone().addScaledVector(direction, -a.distanceTo(b) * 4);
    assert.ok(await internals.layPickedFacetOnBed(new THREE.Raycaster(origin, direction)));
    const changed = instances.filter(
      (id) => JSON.stringify(controller.getInstanceTransform(id)?.rotation) !== before.get(id),
    );
    assert.deepEqual(changed, [secondInstance]);
  } finally {
    workspace.dispose();
  }
});

await test('a measure pick takes the nearest part the ray meets, not the first in scene order', async () => {
  const registry = buildRegistry();
  const workspace = new OrcaWorkspace(registry);
  workspace.actionContext = new ActionContext(workspace, new UiState(), registry);
  const internals = workspace as unknown as PaintInternals & {
    pickMeasureFeature(raycaster: THREE.Raycaster): boolean;
    measurePicks: { feature: { kind: string; origin?: number[]; point?: number[] }; instanceId?: string }[];
  };
  try {
    const controller = internals.canonicalProject;
    const geometry = new THREE.BoxGeometry(10, 10, 10);
    controller.importBufferGeometry(geometry, { name: 'First' });
    controller.importBufferGeometry(geometry, { name: 'Second' });
    geometry.dispose();
    const root = controller.surface.root;
    const meshes = root.children.flatMap((group) => group.children.filter((c) => c instanceof THREE.Mesh));
    const [first, second] = meshes;
    const secondInstance = getThreeProjectEntity(second)!.instanceId;
    const moved = controller.getInstanceTransform(secondInstance)!;
    await controller.setInstanceTransforms([
      {
        instanceId: secondInstance,
        transform: {
          ...moved,
          translationMm: [moved.translationMm[0] + 30, moved.translationMm[1], moved.translationMm[2]],
        },
      },
    ]);
    root.updateMatrixWorld(true);
    const centre = (mesh: THREE.Object3D) => new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
    const [a, b] = [centre(first), centre(second)];
    const direction = a.clone().sub(b).normalize();
    const origin = b.clone().addScaledVector(direction, -a.distanceTo(b) * 4);
    assert.ok(internals.pickMeasureFeature(new THREE.Raycaster(origin, direction)));
    assert.equal(internals.measurePicks.length, 1);
    assert.equal(internals.measurePicks[0].instanceId, secondInstance);
  } finally {
    workspace.dispose();
  }
});

await test('a measure pick records the instance the ray met among an object’s instances', async () => {
  const registry = buildRegistry();
  const workspace = new OrcaWorkspace(registry);
  workspace.actionContext = new ActionContext(workspace, new UiState(), registry);
  const internals = workspace as unknown as PaintInternals & {
    pickMeasureFeature(raycaster: THREE.Raycaster): boolean;
    measurePicks: { instanceId?: string }[];
  };
  try {
    const controller = internals.canonicalProject;
    const geometry = new THREE.BoxGeometry(10, 10, 10);
    controller.importBufferGeometry(geometry, { name: 'Box' });
    geometry.dispose();
    const root = controller.surface.root;
    const meshes = () => root.children.flatMap((group) => group.children.filter((c) => c instanceof THREE.Mesh));
    const original = getThreeProjectEntity(meshes()[0])!.instanceId;
    controller.selectInstance(original);
    await controller.duplicateSelectedInstance();
    const all = meshes();
    assert.equal(all.length, 2);
    const copy = all.map((mesh) => getThreeProjectEntity(mesh)!.instanceId).find((id) => id !== original)!;
    const placed = controller.getInstanceTransform(original)!;
    await controller.setInstanceTransforms([
      {
        instanceId: copy,
        transform: {
          ...placed,
          translationMm: [placed.translationMm[0] + 30, placed.translationMm[1], placed.translationMm[2]],
        },
      },
    ]);
    root.updateMatrixWorld(true);
    const centre = (id: string) =>
      new THREE.Box3()
        .setFromObject(meshes().find((mesh) => getThreeProjectEntity(mesh)!.instanceId === id)!)
        .getCenter(new THREE.Vector3());
    // From beyond the copy, through it and on to the original.
    const [a, b] = [centre(original), centre(copy)];
    const direction = a.clone().sub(b).normalize();
    const origin = b.clone().addScaledVector(direction, -a.distanceTo(b) * 4);
    assert.ok(internals.pickMeasureFeature(new THREE.Raycaster(origin, direction)));
    assert.equal(internals.measurePicks[0].instanceId, copy);
  } finally {
    workspace.dispose();
  }
});

await test('a measure pick on a mesh replaced by one of the same counts reads the new mesh', async () => {
  const registry = buildRegistry();
  const workspace = new OrcaWorkspace(registry);
  workspace.actionContext = new ActionContext(workspace, new UiState(), registry);
  const internals = workspace as unknown as PaintInternals & {
    pickMeasureFeature(raycaster: THREE.Raycaster): boolean;
    measurePicks: { feature: unknown }[];
    measureExtractors: Map<string, unknown>;
  };
  try {
    const controller = internals.canonicalProject;
    const geometry = new THREE.BoxGeometry(10, 10, 10);
    controller.importBufferGeometry(geometry, { name: 'Box' });
    geometry.dispose();
    const root = controller.surface.root;
    const display = () => root.children.flatMap((group) => group.children.filter((c) => c instanceof THREE.Mesh))[0];
    const pick = () => {
      root.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(display());
      const [centre, size] = [bounds.getCenter(new THREE.Vector3()), bounds.getSize(new THREE.Vector3())];
      // From well beyond +X, slightly off the face centre (the scene is in
      // metres, so offsets follow the part's own size).
      const origin = centre.clone().add(new THREE.Vector3(size.x * 20, size.y * 0.1, size.z * 0.05));
      internals.measurePicks = [];
      assert.ok(internals.pickMeasureFeature(new THREE.Raycaster(origin, new THREE.Vector3(-1, 0, 0))));
      return internals.measurePicks[0].feature;
    };
    pick();
    // The same mesh twice the size: equal vertex and facet counts.
    const volumeId = getThreeProjectEntity(display())!.volumeId!;
    const mesh = controller.getVolumeMesh(volumeId)!;
    await controller.applyRepairedVolumeMesh(
      volumeId,
      mesh.vertices.flatMap((vertex) => vertex.map((c) => c * 2)),
      mesh.triangles.flat(),
    );
    const cached = pick();
    internals.measureExtractors.clear();
    assert.deepEqual(cached, pick());
  } finally {
    workspace.dispose();
  }
});

await test('measure picks are in printer millimetres, not the scaled scene', async () => {
  const registry = buildRegistry();
  const workspace = new OrcaWorkspace(registry);
  workspace.actionContext = new ActionContext(workspace, new UiState(), registry);
  const internals = workspace as unknown as PaintInternals & {
    pickMeasureFeature(raycaster: THREE.Raycaster): boolean;
    measurePicks: { feature: SurfaceFeature }[];
  };
  try {
    const controller = internals.canonicalProject;
    const geometry = new THREE.BoxGeometry(10, 10, 10);
    controller.importBufferGeometry(geometry, { name: 'Box' });
    geometry.dispose();
    const root = controller.surface.root;
    root.updateMatrixWorld(true);
    const display = root.children.flatMap((group) => group.children.filter((c) => c instanceof THREE.Mesh))[0];
    const bounds = new THREE.Box3().setFromObject(display);
    const [centre, size] = [bounds.getCenter(new THREE.Vector3()), bounds.getSize(new THREE.Vector3())];
    // The two faces across scene X, which is printer X.
    for (const side of [1, -1]) {
      const origin = centre.clone().add(new THREE.Vector3(side * size.x * 20, size.y * 0.1, size.z * 0.05));
      assert.ok(internals.pickMeasureFeature(new THREE.Raycaster(origin, new THREE.Vector3(-side, 0, 0))));
    }
    const [first, second] = internals.measurePicks.map(({ feature }) => feature);
    assert.equal(first.kind, 'plane');
    assert.equal(second.kind, 'plane');
    const result = measureSurfaceFeatures(first, second);
    const distance = (result.distanceStrict ?? result.distanceInfinite)!.distance;
    assert.ok(Math.abs(distance - 10) < 1e-6, `the 10 mm box measures ${distance} mm across`);
    // Printer frame: Z up, so these faces' normals are ±X with no Z part.
    for (const feature of [first, second]) {
      assert.ok(feature.kind === 'plane' && Math.abs(Math.abs(feature.normal[0]) - 1) < 1e-9);
    }
  } finally {
    workspace.dispose();
  }
});

await test('Erase all painting erases the selected instance’s model parts and skips helper volumes', async () => {
  const registry = buildRegistry();
  const workspace = new OrcaWorkspace(registry);
  workspace.actionContext = new ActionContext(workspace, new UiState(), registry);
  const internals = workspace as unknown as PaintInternals & {
    paintService: {
      submitTriangles(request: {
        volumeId: string;
        triangleIndices: number[];
        channel: 'support';
        value: string;
        mode: 'paint';
      }): Promise<{ status: string }>;
    };
  };
  try {
    const controller = internals.canonicalProject;
    const geometry = new THREE.BoxGeometry(10, 10, 10);
    controller.importBufferGeometry(geometry, { name: 'First' });
    controller.importBufferGeometry(geometry, { name: 'Second' });
    geometry.dispose();
    const displays = () =>
      controller.surface.root.children.flatMap((group) => group.children.filter((c) => c instanceof THREE.Mesh));
    const [first, second] = displays().map((mesh) => getThreeProjectEntity(mesh)!);
    // A modifier on the first object: a helper volume, never painted.
    controller.selectInstance(first.instanceId);
    await controller.addHelperVolume('parameter-modifier');
    workspace.setPaintChannel('support');
    for (const entity of [first, second]) {
      const result = await internals.paintService.submitTriangles({
        volumeId: entity.volumeId!,
        triangleIndices: [0, 1, 2],
        channel: 'support',
        value: 'enforce',
        mode: 'paint',
      });
      assert.equal(result.status, 'applied');
    }
    const painted = () => [...controller.getFacetOverlayByVolume('support').keys()].sort();
    assert.deepEqual(painted(), [first.volumeId, second.volumeId].sort());

    // A selected instance scopes the erase to its object, as a selected object does.
    controller.selectInstance(second.instanceId);
    assert.equal(await workspace.eraseAllPaint(), 1);
    assert.deepEqual(painted(), [first.volumeId]);

    // With nothing selected every model part is erased; the modifier is not refused mid-way.
    controller.clearSelection();
    assert.equal(await workspace.eraseAllPaint(), 1);
    assert.deepEqual(painted(), []);
  } finally {
    workspace.dispose();
  }
});

interface StrokeInternals extends PaintInternals {
  paintStroke: { volumeId: string; triangles: Set<number> } | null;
  paintSettings: Record<string, unknown>;
  cancelPaintStroke(): void;
}

/**
 * Two copies of [geometry] side by side, the second placed by [transform]
 * (scale and rotation over its import placement); [paint] strokes one of them
 * at a point of its own mesh, looking straight down the bed's Z from above
 * (or along [view] in the part's own frame), and answers the source facets
 * the brush took with their corners in bed millimetres.
 */
async function withPlacedCopies(
  geometry: THREE.BufferGeometry,
  transform: { scale: [number, number, number]; rotation?: [number, number, number, number] },
  run: (
    paint: (
      copy: 0 | 1,
      settings: Record<string, unknown>,
      local: THREE.Vector3,
      view?: THREE.Vector3,
    ) => {
      triangles: Set<number>;
      bed: (triangle: number) => THREE.Vector3[];
      hitBedZ: number;
    },
  ) => void,
): Promise<void> {
  const registry = buildRegistry();
  const workspace = new OrcaWorkspace(registry);
  workspace.actionContext = new ActionContext(workspace, new UiState(), registry);
  const internals = workspace as unknown as StrokeInternals;
  try {
    const controller = internals.canonicalProject;
    controller.importBufferGeometry(geometry, { name: 'First' });
    controller.importBufferGeometry(geometry, { name: 'Second' });
    const root = controller.surface.root;
    const meshes = () =>
      root.children.flatMap((group) => group.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh));
    const second = getThreeProjectEntity(meshes()[1])!.instanceId;
    const placed = controller.getInstanceTransform(second)!;
    await controller.setInstanceTransforms([
      {
        instanceId: second,
        transform: {
          translationMm: [placed.translationMm[0] + 80, placed.translationMm[1], placed.translationMm[2]],
          rotation: transform.rotation ?? placed.rotation,
          scale: transform.scale,
        },
      },
    ]);
    root.updateMatrixWorld(true);
    run((copy, settings, local, view = new THREE.Vector3(0, 0, -1)) => {
      const display = meshes()[copy];
      // Printer millimetres: the instance group's matrix after the part's.
      const toBed = display.parent!.matrix.clone().multiply(display.matrix);
      const target = display.localToWorld(local.clone());
      const eye = display.localToWorld(local.clone().addScaledVector(view, -40));
      xb.core.camera.position.copy(eye);
      xb.core.camera.updateMatrixWorld(true);
      internals.paintSettings = settings;
      const raycaster = new THREE.Raycaster(eye, target.clone().sub(eye).normalize());
      assert.ok(internals.beginPaintStroke(raycaster, 1), 'the ray meets the part');
      const stroke = internals.paintStroke!;
      assert.equal(stroke.volumeId, getThreeProjectEntity(display)!.volumeId);
      const triangles = new Set(stroke.triangles);
      internals.cancelPaintStroke();
      const index = display.geometry.index!;
      const positions = display.geometry.getAttribute('position');
      const bed = (triangle: number) =>
        [0, 1, 2].map((corner) =>
          new THREE.Vector3().fromBufferAttribute(positions, index.getX(triangle * 3 + corner)).applyMatrix4(toBed),
        );
      return { triangles, bed, hitBedZ: local.clone().applyMatrix4(toBed).z };
    });
  } finally {
    workspace.dispose();
  }
}

await test('a 200% part takes a brush of the size set on the bed, not twice it', async () => {
  // A 20 × 20 mm plate on a 0.5 mm grid.
  const geometry = new THREE.BoxGeometry(20, 20, 2, 40, 40, 1);
  await withPlacedCopies(geometry, { scale: [2, 2, 2] }, (paint) => {
    geometry.computeBoundingBox();
    const top = new THREE.Vector3(0.3, 0.2, geometry.boundingBox!.max.z);
    // 2 mm on the unscaled plate, 4 mm on the bed over the 200% one: the same
    // 2 mm of either part's own mesh.
    const unscaled = paint(0, { tool: 'circle', radiusMm: 2 }, top);
    const scaled = paint(1, { tool: 'circle', radiusMm: 4 }, top);
    assert.ok(unscaled.triangles.size > 8, `the brush takes ${unscaled.triangles.size} facets`);
    assert.deepEqual([...scaled.triangles].sort(), [...unscaled.triangles].sort());
    // The radius it was given, on the bed: 2 mm reaches no facet of the 200%
    // plate more than 2 mm (and a facet's 1 mm diagonal) from the hit.
    const small = paint(1, { tool: 'circle', radiusMm: 2 }, top);
    const centre = top.clone().multiplyScalar(2);
    for (const triangle of small.triangles) {
      const nearest = Math.min(
        ...small.bed(triangle).map((corner) => Math.hypot(corner.x - centre.x - 80, corner.y - centre.y)),
      );
      assert.ok(nearest < 2 + Math.SQRT2, `facet ${triangle} lies ${nearest} mm from the hit`);
    }
    assert.ok(small.triangles.size < unscaled.triangles.size);
  });
  geometry.dispose();
});

await test('a band on a stretched or turned part is the height set in bed Z', async () => {
  // A 10 mm column on a 0.25 mm grid up its sides.
  const geometry = new THREE.BoxGeometry(4, 4, 10, 1, 1, 40);
  geometry.computeBoundingBox();
  const side = new THREE.Vector3(geometry.boundingBox!.max.x, 0.1, 0.6);
  const facing = new THREE.Vector3(-1, 0, 0);
  const halfTurn = Math.SQRT1_2;
  for (const transform of [
    // Stretched twice up Z: 1 mm on the bed is half a millimetre of the part.
    { scale: [1, 1, 2] as [number, number, number] },
    // Laid on its side: the part's Z runs along the bed's Y, so the band
    // crosses the column instead of running up it.
    {
      scale: [1, 1, 1] as [number, number, number],
      rotation: [halfTurn, 0, 0, halfTurn] as [number, number, number, number],
    },
  ]) {
    await withPlacedCopies(geometry, transform, (paint) => {
      const band = paint(1, { tool: 'heightRange', heightRangeMm: 1 }, side, facing);
      assert.ok(band.triangles.size > 0);
      for (const triangle of band.triangles) {
        const z = band.bed(triangle).map((corner) => corner.z);
        // Every facet the band takes meets [hit, hit + 1 mm] of bed Z.
        assert.ok(
          Math.min(...z) <= band.hitBedZ + 1 + 0.02 && Math.max(...z) >= band.hitBedZ - 0.02,
          `facet ${triangle} spans ${Math.min(...z)}–${Math.max(...z)} mm against a band from ${band.hitBedZ} mm`,
        );
      }
    });
  }
  geometry.dispose();
});

console.log(`\nWorkspace paint target picking: ${passed} tests passed.`);

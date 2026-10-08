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

const [{ OrcaWorkspace }, { buildRegistry }] = await Promise.all([
  import('../OrcaWorkspace'),
  import('../../actions/catalog'),
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

console.log(`\nWorkspace paint target picking: ${passed} tests passed.`);

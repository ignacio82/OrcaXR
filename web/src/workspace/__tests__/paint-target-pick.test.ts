import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import * as THREE from 'three';
import { ActionContext } from '../../actions/ActionContext';
import { UiState } from '../../actions/UiState';
import { getThreeProjectEntity } from '../../project/surfaces/ThreeProjectSurface';
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

console.log(`\nWorkspace paint target picking: ${passed} tests passed.`);

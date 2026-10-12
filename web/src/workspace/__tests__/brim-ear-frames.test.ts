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

interface BrimEarInternals {
  canonicalProject: CanonicalWorkspaceController;
  autoPlaceBrimEars(): Promise<boolean>;
  placeBrimEar(raycaster: THREE.Raycaster): boolean;
  getBrimEarSnapshot(): { readonly stranded: readonly number[] };
  setTool(tool: string): void;
}

/** Two boxes in one mesh: a 10 mm cube and a 6 mm cube 20 mm along X. */
function twoBoxes(): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const box = (at: [number, number, number], size: number) => {
    const offset = positions.length / 3;
    for (const [x, y, z] of [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ])
      positions.push(at[0] + x * size, at[1] + y * size, at[2] + z * size);
    for (const t of [
      [0, 2, 1],
      [0, 3, 2],
      [4, 5, 6],
      [4, 6, 7],
      [0, 1, 5],
      [0, 5, 4],
      [3, 7, 6],
      [3, 6, 2],
      [0, 4, 7],
      [0, 7, 3],
      [1, 2, 6],
      [1, 6, 5],
    ])
      indices.push(...t.map((v) => v + offset));
  };
  box([0, 0, 0], 10);
  box([20, 2, 0], 6);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}

/** A workspace holding the two boxes as one object split into its two parts. */
async function splitBoxes() {
  const registry = buildRegistry();
  const workspace = new OrcaWorkspace(registry);
  workspace.actionContext = new ActionContext(workspace, new UiState(), registry);
  const internals = workspace as unknown as BrimEarInternals;
  const controller = internals.canonicalProject;
  controller.importBufferGeometry(twoBoxes(), { name: 'Boxes' });
  const root = controller.surface.root;
  const instanceId = getThreeProjectEntity(root.children[0])!.instanceId;
  const objectId = getThreeProjectEntity(root.children[0])!.objectId;
  const before = controller.getObjectModelMesh(objectId)!;
  controller.selectInstance(instanceId);
  await controller.splitSelectedToParts();
  controller.selectInstance(instanceId);
  root.updateMatrixWorld(true);
  return { workspace, internals, controller, root, objectId, before };
}

/** The bottom corners of a mesh in its own frame, as sorted "x,y" keys. */
function bottomCorners(mesh: { positions: readonly number[] }): string[] {
  let base = Infinity;
  for (let i = 2; i < mesh.positions.length; i += 3) base = Math.min(base, mesh.positions[i]);
  const keys = new Set<string>();
  for (let i = 0; i < mesh.positions.length; i += 3)
    if (Math.abs(mesh.positions[i + 2] - base) < 1e-6)
      keys.add(`${mesh.positions[i].toFixed(3)},${mesh.positions[i + 1].toFixed(3)}`);
  return [...keys].sort();
}

await test('automatic brim ears land on every part’s corners in object space', async () => {
  const { workspace, internals, controller, objectId, before } = await splitBoxes();
  try {
    const object = controller['session'].project
      .getSnapshot()
      .state.plates.flatMap((plate) => plate.objects)
      .find((candidate) => candidate.id === objectId)!;
    assert.equal(object.volumes.length, 2);
    assert.ok(object.volumes.every((volume) => volume.transform.translationMm.some((v) => v !== 0)));
    // Split parts are recentred: their own frames are not the object's.
    const statuses: string[] = [];
    workspace.onStatusChanged = (status) => statuses.push(status);
    assert.ok(await internals.autoPlaceBrimEars());
    // The placement's status is the last word: opening the tool for its discs once replaced it.
    assert.match(
      statuses.at(-1) ?? '',
      /^Placed \d+ brim ears on the corners that would lift; one undo removes them all\.$/,
    );
    const ears = controller.getBrimEars(objectId);
    assert.deepEqual(
      ears.map((ear) => `${ear.positionMm[0].toFixed(3)},${ear.positionMm[1].toFixed(3)}`).sort(),
      bottomCorners(before),
    );
    assert.deepEqual(internals.getBrimEarSnapshot().stranded, []);
  } finally {
    workspace.dispose();
  }
});

await test('a placed brim ear sits where the ray met the part, in object space', async () => {
  const { workspace, internals, controller, root, objectId } = await splitBoxes();
  try {
    const instance = root.children[0];
    // Straight down onto the small cube's top: object (23, 5), base Z.
    const target = instance.localToWorld(new THREE.Vector3(23, 5, 6));
    const origin = target.clone().add(new THREE.Vector3(0, 1, 0));
    assert.ok(internals.placeBrimEar(new THREE.Raycaster(origin, new THREE.Vector3(0, -1, 0))));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const [ear] = controller.getBrimEars(objectId);
    assert.ok(Math.abs(ear.positionMm[0] - 23) < 1e-4 && Math.abs(ear.positionMm[1] - 5) < 1e-4, `${ear.positionMm}`);
    assert.ok(Math.abs(ear.positionMm[2]) < 1e-6, 'the ear takes the object’s base height');
  } finally {
    workspace.dispose();
  }
});

await test('brim ear discs draw at their printed size, not scaled by the scene', async () => {
  const { workspace, internals, controller, root, objectId } = await splitBoxes();
  try {
    await controller.addBrimEar(objectId, { positionMm: [5, 5, 0], headFrontRadiusMm: 4 });
    internals.setTool('brim_ears');
    root.updateMatrixWorld(true);
    const discs: THREE.Mesh[] = [];
    root.traverse((node) => {
      if (node.name === 'brimEarPreview') node.traverse((d) => d instanceof THREE.Mesh && discs.push(d));
    });
    assert.equal(discs.length, 1, 'one disc per ear and instance');
    // In printer millimetres (the root's own frame) the disc is 8 mm across.
    const toPrinter = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const bounds = new THREE.Box3().setFromObject(discs[0]).applyMatrix4(toPrinter);
    const size = bounds.getSize(new THREE.Vector3());
    assert.ok(Math.abs(size.x - 8) < 0.05 && Math.abs(size.y - 8) < 0.05, `${size.toArray()}`);
  } finally {
    workspace.dispose();
  }
});

console.log(`\nWorkspace brim ear frames: ${passed} tests passed.`);

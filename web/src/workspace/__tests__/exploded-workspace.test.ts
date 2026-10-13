/**
 * The exploded assembly view and the Measure tool in the workspace (P5.3.2).
 *
 * Each test fails on the workspace as it was. The explosion composed its
 * offsets from a baseline captured the first time a part was exploded, and
 * every project change put the parts back where the project places them
 * while the factor still read exploded, so a moved part jumped back to its
 * old place on the next adjustment. A measure pick read the exploded display,
 * so a measurement — and an alignment computed from it — was off by the
 * explosion. The measured line was drawn by a snapshot of two picks and never
 * taken away, so Clear, an alignment and leaving the tool left it standing.
 * And a new project kept the old one's picks and explosion.
 */
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import * as THREE from 'three';
import { ActionContext } from '../../actions/ActionContext';
import { UiState } from '../../actions/UiState';
import type { InstanceId } from '../../project/domain/ids';
import { projectExplosion } from '../../project/objects/assembly';
import type { SurfaceFeature } from '../../project/objects/measure';
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
  // The measured line's label is a canvas sprite: a canvas that draws nothing is enough here.
  document: {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ fillRect() {}, fillText() {} }),
    }),
  },
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

interface Internals {
  canonicalProject: CanonicalWorkspaceController;
  measurePicks: { feature: SurfaceFeature; instanceId?: InstanceId }[];
  measureAnnotation: THREE.Group | null;
  pickMeasureFeature(raycaster: THREE.Raycaster): boolean;
}

/** Two 10 mm spheres 30 mm apart: [run] gets their instances and a ray straight down onto either as drawn. */
async function twoSpheres(
  run: (scene: {
    workspace: InstanceType<typeof OrcaWorkspace>;
    internals: Internals;
    controller: CanonicalWorkspaceController;
    first: InstanceId;
    second: InstanceId;
    group: (id: InstanceId) => THREE.Object3D;
    down: (id: InstanceId) => THREE.Raycaster;
    settle: () => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const registry = buildRegistry();
  const workspace = new OrcaWorkspace(registry);
  workspace.actionContext = new ActionContext(workspace, new UiState(), registry);
  const internals = workspace as unknown as Internals;
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  try {
    const controller = internals.canonicalProject;
    const geometry = new THREE.SphereGeometry(10, 24, 16);
    controller.importBufferGeometry(geometry, { name: 'First' });
    controller.importBufferGeometry(geometry, { name: 'Second' });
    geometry.dispose();
    const root = controller.surface.root;
    const [first, second] = root.children.map((group) => getThreeProjectEntity(group)!.instanceId as InstanceId);
    const placed = controller.getInstanceTransform(second)!;
    await controller.setInstanceTransforms([
      {
        instanceId: second,
        transform: {
          ...placed,
          translationMm: [placed.translationMm[0] + 30, placed.translationMm[1], placed.translationMm[2]],
        },
      },
    ]);
    await settle();
    const group = (id: InstanceId) => controller.surface.getInstanceGroup(id)!;
    const down = (id: InstanceId) => {
      root.updateMatrixWorld(true);
      const centre = new THREE.Box3().setFromObject(group(id)).getCenter(new THREE.Vector3());
      const origin = centre.clone().add(new THREE.Vector3(0.0002, 1, 0.0001));
      return new THREE.Raycaster(origin, centre.clone().sub(origin).normalize());
    };
    await run({ workspace, internals, controller, first, second, group, down, settle });
  } finally {
    workspace.dispose();
  }
}

/** Where the exploded view should draw [id] at [factor]: its canonical translation plus its offset from the pair's centre. */
function exploded(controller: CanonicalWorkspaceController, ids: InstanceId[], id: InstanceId, factor: number) {
  const parts = ids.map((part) => ({
    id: part as string,
    centerMm: controller.getInstanceTransform(part)!.translationMm,
  }));
  const offset = projectExplosion(parts, factor).find((o) => o.id === id)!.offsetMm;
  const t = controller.getInstanceTransform(id)!.translationMm;
  return [t[0] + offset[0], t[1] + offset[1], t[2] + offset[2]];
}

await test('an edit re-explodes the view from where the parts now stand', async () => {
  await twoSpheres(async ({ workspace, controller, first, second, group, settle }) => {
    assert.ok(workspace.setExplosionFactor(2));
    const placed = controller.getInstanceTransform(second)!;
    await controller.setInstanceTransforms([
      {
        instanceId: second,
        transform: { ...placed, translationMm: [placed.translationMm[0] + 10, placed.translationMm[1], 5] },
      },
    ]);
    await settle();
    assert.equal(workspace.getExplosionFactor(), 2, 'the factor stays');
    for (const id of [first, second]) {
      assert.deepEqual(
        group(id).position.toArray(),
        exploded(controller, [first, second], id, 2),
        `${id} drawn exploded`,
      );
    }
    // And a later adjustment composes from there, not from where the part first stood.
    assert.ok(workspace.setExplosionFactor(3));
    assert.deepEqual(group(second).position.toArray(), exploded(controller, [first, second], second, 3));
    assert.ok(workspace.setExplosionFactor(1));
    assert.deepEqual(group(second).position.toArray(), [...controller.getInstanceTransform(second)!.translationMm]);
  });
});

await test('a pick in an exploded view measures where the project places the part', async () => {
  await twoSpheres(async ({ workspace, internals, controller, second, down }) => {
    workspace.measureTool();
    assert.ok(internals.pickMeasureFeature(down(second)));
    const assembled = JSON.stringify(internals.measurePicks[0].feature);
    workspace.measureTool();
    assert.ok(workspace.setExplosionFactor(3));
    assert.ok(internals.pickMeasureFeature(down(second)), 'the exploded part is picked where it is drawn');
    assert.equal(
      JSON.stringify(internals.measurePicks[0].feature),
      assembled,
      'and measured where the project places it',
    );
    assert.ok(controller.getInstanceTransform(second));
  });
});

await test('the measured line follows its parts and goes with Clear and the tool', async () => {
  await twoSpheres(async ({ workspace, internals, first, second, down }) => {
    workspace.measureTool();
    assert.ok(internals.pickMeasureFeature(down(first)));
    assert.equal(internals.measureAnnotation, null, 'one pick draws no line');
    assert.ok(internals.pickMeasureFeature(down(second)));
    assert.ok(internals.measureAnnotation, 'two picks draw the line');
    const line = () => {
      const segment = internals.measureAnnotation!.children[0] as THREE.Line;
      const position = segment.geometry.getAttribute('position');
      return [position.getX(0), position.getX(1)];
    };
    const [from, to] = line();
    // Exploded, each end moves with its part.
    assert.ok(workspace.setExplosionFactor(3));
    const [fromExploded, toExploded] = line();
    assert.ok(fromExploded < from && toExploded > to, 'the ends move apart with the parts');
    workspace.clearMeasureSelection();
    workspace.getMeasureSnapshot();
    assert.equal(internals.measureAnnotation, null, 'Clear takes the line away');
    assert.ok(internals.pickMeasureFeature(down(first)));
    assert.ok(internals.pickMeasureFeature(down(second)));
    assert.ok(internals.measureAnnotation);
    workspace.setTool('move');
    assert.equal(internals.measureAnnotation, null, 'leaving the tool takes the line away');
  });
});

await test('a new project starts assembled, with no picks', async () => {
  await twoSpheres(async ({ workspace, internals, first, down, settle }) => {
    workspace.measureTool();
    assert.ok(internals.pickMeasureFeature(down(first)));
    assert.ok(workspace.setExplosionFactor(2));
    workspace.onRequestNewProjectConfirmation = async () => true;
    assert.ok(await workspace.newProject());
    await settle();
    assert.equal(workspace.getExplosionFactor(), 1);
    assert.deepEqual(internals.measurePicks, []);
  });
});

console.log(`\nExploded workspace: ${passed} tests passed.`);

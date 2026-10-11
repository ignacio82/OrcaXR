import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import * as THREE from 'three';
import { ActionContext } from '../../actions/ActionContext';
import { UiState } from '../../actions/UiState';
import type { InstanceId, ObjectId, VolumeId } from '../../project/domain/ids';
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

/** The gesture in flight, read afresh (an assertion that it was null does not narrow a later read). */
const stroke = (internals: PickInternals) => internals.paintStroke;

/** The status a pick on a previewed part answers. */
const REFUSED = 'That part shows a simplify preview; apply or cancel it first.';

interface PickInternals {
  canonicalProject: CanonicalWorkspaceController;
  lastStatusText: string;
  paintStroke: { volumeId: string } | null;
  measurePicks: { instanceId?: string }[];
  beginPaintStroke(raycaster: THREE.Raycaster, pointerId: number): boolean;
  cancelPaintStroke(): void;
  pickMeasureFeature(raycaster: THREE.Raycaster): boolean;
  layPickedFacetOnBed(raycaster: THREE.Raycaster): Promise<boolean>;
  placeBrimEar(raycaster: THREE.Raycaster): boolean;
}

/** One sphere's identities. */
interface Part {
  instanceId: InstanceId;
  volumeId: VolumeId;
  objectId: ObjectId;
}

/**
 * Two spheres 30 mm apart, the second selected — what a click on it selects —
 * and its simplify preview drawn: [run] gets rays onto either and through the
 * previewed one onto the other.
 */
async function withPreview(
  run: (scene: {
    workspace: InstanceType<typeof OrcaWorkspace>;
    internals: PickInternals;
    controller: CanonicalWorkspaceController;
    first: Part;
    second: Part;
    onto: (part: 'first' | 'second') => THREE.Raycaster;
    through: () => THREE.Raycaster;
  }) => Promise<void>,
): Promise<void> {
  const registry = buildRegistry();
  const workspace = new OrcaWorkspace(registry);
  workspace.actionContext = new ActionContext(workspace, new UiState(), registry);
  // Lay flat is an instance action; the gesture supplies the instance.
  workspace.actionContext.ui.update({ hasSelection: true, hasInstanceSelection: true, modelCount: 2 });
  const internals = workspace as unknown as PickInternals;
  try {
    const controller = internals.canonicalProject;
    const geometry = new THREE.SphereGeometry(10, 24, 16);
    controller.importBufferGeometry(geometry, { name: 'First' });
    controller.importBufferGeometry(geometry, { name: 'Second' });
    geometry.dispose();
    const root = controller.surface.root;
    const displays = () =>
      root.children.flatMap((group) => group.children.filter((c): c is THREE.Mesh => c instanceof THREE.Mesh));
    const [first, second] = displays().map((display): Part => {
      const entity = getThreeProjectEntity(display)!;
      return { instanceId: entity.instanceId, volumeId: entity.volumeId!, objectId: entity.objectId };
    });
    const placed = controller.getInstanceTransform(second.instanceId)!;
    await controller.setInstanceTransforms([
      {
        instanceId: second.instanceId,
        transform: {
          ...placed,
          translationMm: [placed.translationMm[0] + 30, placed.translationMm[1], placed.translationMm[2]],
        },
      },
    ]);
    controller.selectInstance(second.instanceId);
    assert.ok(workspace.previewSimplify({ useCount: true, decimateRatio: 50, maxError: 1 }));
    assert.equal(workspace.getSimplifySnapshot().parts, 1, 'only the clicked sphere is previewed');
    root.updateMatrixWorld(true);
    const centre = (volumeId: VolumeId) =>
      new THREE.Box3()
        .setFromObject(displays().find((display) => getThreeProjectEntity(display)!.volumeId === volumeId)!)
        .getCenter(new THREE.Vector3());
    const [a, b] = [centre(first.volumeId), centre(second.volumeId)];
    const spacing = a.distanceTo(b);
    // Straight down onto a sphere's top, a little off its pole.
    const onto = (part: 'first' | 'second') => {
      const target = part === 'first' ? a : b;
      const origin = target.clone().add(new THREE.Vector3(spacing * 0.03, spacing * 4, spacing * 0.02));
      return new THREE.Raycaster(origin, target.clone().sub(origin).normalize());
    };
    // From beyond the previewed sphere, through it and on to the other.
    const through = () => {
      const direction = a.clone().sub(b).normalize();
      return new THREE.Raycaster(b.clone().addScaledVector(direction, -spacing * 4), direction);
    };
    await run({ workspace, internals, controller, first, second, onto, through });
  } finally {
    workspace.dispose();
  }
}

await test('a paint stroke never starts on a previewed part', async () => {
  await withPreview(async ({ workspace, internals, first, onto, through }) => {
    workspace.setPaintChannel('support');
    internals.lastStatusText = '';
    assert.equal(internals.beginPaintStroke(onto('second'), 1), false);
    assert.equal(internals.paintStroke, null);
    assert.equal(internals.lastStatusText, REFUSED);
    // The previewed part hides the one behind it: the stroke does not reach through.
    assert.equal(internals.beginPaintStroke(through(), 1), false);
    assert.equal(internals.paintStroke, null);
    // A part the preview leaves alone still paints.
    assert.ok(internals.beginPaintStroke(onto('first'), 1));
    assert.equal(stroke(internals)?.volumeId, first.volumeId);
    internals.cancelPaintStroke();
  });
});

await test('a measure pick never reads a previewed part', async () => {
  await withPreview(async ({ internals, first, onto, through }) => {
    internals.lastStatusText = '';
    assert.equal(internals.pickMeasureFeature(onto('second')), false);
    assert.equal(internals.pickMeasureFeature(through()), false);
    assert.deepEqual(internals.measurePicks, []);
    assert.equal(internals.lastStatusText, REFUSED);
    assert.ok(internals.pickMeasureFeature(onto('first')));
    const picks = internals.measurePicks as { instanceId?: string }[];
    assert.equal(picks.length, 1);
    assert.equal(picks[0].instanceId, first.instanceId);
  });
});

await test('lay flat never turns a part by a previewed facet', async () => {
  await withPreview(async ({ internals, controller, second, onto }) => {
    const before = JSON.stringify(controller.getInstanceTransform(second.instanceId));
    internals.lastStatusText = '';
    assert.equal(await internals.layPickedFacetOnBed(onto('second')), false);
    assert.equal(JSON.stringify(controller.getInstanceTransform(second.instanceId)), before);
    assert.equal(internals.lastStatusText, REFUSED);
  });
});

await test('a brim ear is never placed on a previewed part', async () => {
  await withPreview(async ({ internals, controller, second, onto }) => {
    internals.lastStatusText = '';
    assert.equal(internals.placeBrimEar(onto('second')), false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(controller.getBrimEars(second.objectId), []);
    assert.equal(internals.lastStatusText, REFUSED);
  });
});

await test('once the preview is cancelled the part takes every tool again', async () => {
  await withPreview(async ({ workspace, internals, controller, second, onto }) => {
    assert.ok(workspace.cancelSimplifyPreview());
    assert.ok(internals.beginPaintStroke(onto('second'), 1));
    assert.equal(internals.paintStroke?.volumeId, second.volumeId);
    internals.cancelPaintStroke();
    assert.ok(internals.pickMeasureFeature(onto('second')));
    assert.equal(internals.measurePicks[0].instanceId, second.instanceId);
    assert.ok(internals.placeBrimEar(onto('second')));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(controller.getBrimEars(second.objectId).length, 1);
  });
});

console.log(`\nSimplify preview picks: ${passed} tests passed.`);

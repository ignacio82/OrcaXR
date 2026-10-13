/**
 * The wipe tower's ghost is drawn from the shared plan (`wipeTowerGhost.ts`):
 * the footprint the slice preflight checks and the plate's tallest model part.
 *
 * Each test fails on the ghost the workspace used to draw. It read the tower's
 * width and margin from the profile's base configuration, so a plate's own
 * `prime_tower_width` and brim — which the preflight and the auto-placer
 * honour — were drawn as the project's; and it measured only the first part
 * of each model (the one display mesh it took per instance), so a taller
 * second part rose out of a ghost the engine would print taller, while a
 * modifier listed first would have set the height of a tower nothing prints.
 */
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import * as THREE from 'three';
import { ActionContext } from '../../actions/ActionContext';
import { UiState } from '../../actions/UiState';
import { InMemoryAssetRepository } from '../../project/assets';
import { entityId, seededRandom, UuidIdSource } from '../../project/domain/ids';
import {
  createEmptyProject,
  emptyFacetAnnotations,
  type ProjectState,
  type Transform,
  type VolumeRole,
} from '../../project/domain/model';
import { assertValidProjectState } from '../../project/domain/validation';
import { encodeIndexedMeshAsset } from '../../project/meshCodec';
import { wipeTowerFootprint } from '../../project/objects/wipeTowerPlacement';
import { Bbs3mfProjectSerializer } from '../../project/serialization/Bbs3mfProjectSerializer';
import { EditorSession } from '../../project/session';
import { CURRENT_THREE_WORLD_UNITS_PER_MM } from '../../project/surfaces/ThreeProjectSurface';
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

interface GhostInternals {
  canonicalProject: CanonicalWorkspaceController;
  wipeTowerGhost: THREE.Group | null;
  bedMm: { x: number; y: number };
}

const IDENTITY: Transform = { translationMm: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };

/** The controller's live canonical state. */
const live = (controller: CanonicalWorkspaceController): ProjectState =>
  (controller as unknown as { session: EditorSession }).session.project.getSnapshot().state;

/** An axis-aligned box of [size] standing on its own origin. */
function box(id: string, size: [number, number, number]) {
  const corners = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
  ];
  const triangles = [
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
  ];
  return encodeIndexedMeshAsset({
    id: entityId<'asset'>(id),
    positions: corners.flatMap((corner) => corner.map((value, axis) => value * size[axis])),
    indices: triangles.flat(),
  });
}

/**
 * One object on a plate with an enabled tower at (20, 30): a 10 mm cube, a
 * part beside it 40 mm tall, and a 70 mm modifier listed first. The plate
 * states its own tower width and brim; the project another width and none.
 */
async function towered(
  run: (workspace: InstanceType<typeof OrcaWorkspace>, internals: GhostInternals) => Promise<void>,
) {
  const short = box('import:asset:ghost-short', [10, 10, 10]);
  const tall = box('import:asset:ghost-tall', [10, 10, 40]);
  const tallest = box('import:asset:ghost-tallest', [10, 10, 70]);
  const state: ProjectState = createEmptyProject({
    idSource: new UuidIdSource(seededRandom(0x6057)),
    now: '2026-10-12T00:00:00.000Z',
  });
  state.config = { printable_area: ['0x0', '270x0', '270x270', '0x270'], prime_tower_width: 50 };
  const plate = state.plates[0];
  plate.config = { prime_tower_width: '25', prime_tower_brim_width: 2 };
  plate.wipeTower = { enabled: true, positionMm: [20, 30], rotationDeg: 0 };
  const volume = (key: string, payload: ReturnType<typeof box>, role: VolumeRole, x: number) => ({
    id: entityId<'volume'>(`import:volume:${key}`),
    name: key,
    role,
    source: { assetId: payload.descriptor.id, topologyRevision: 0, triangleCount: 12 },
    transform: { ...IDENTITY, translationMm: [x, 0, 0] as [number, number, number] },
    config: {},
    annotations: emptyFacetAnnotations(0),
  });
  plate.objects = [
    {
      id: entityId<'object'>('import:object:ghost'),
      name: 'Ghost',
      config: {},
      volumes: [
        volume('modifier', tallest, 'parameter-modifier', 0),
        volume('short', short, 'model', 0),
        volume('tall', tall, 'model', 15),
      ],
      instances: [
        {
          id: entityId<'instance'>('import:instance:ghost'),
          transform: { ...IDENTITY, translationMm: [150, 150, 0] },
          printable: true,
        },
      ],
      layerRanges: [],
    },
  ];
  state.sourceAssets = [tallest.descriptor, short.descriptor, tall.descriptor];
  assertValidProjectState(state);
  const assets = new InMemoryAssetRepository();
  for (const payload of [tallest, short, tall]) assets.put(payload.descriptor, payload.bytes);
  const serializer = new Bbs3mfProjectSerializer();
  const source = new EditorSession({ initialState: state, assets, serializer });
  const { serialized } = await source.serializeSnapshot(undefined, { purpose: 'manual' });

  const registry = buildRegistry();
  const workspace = new OrcaWorkspace(registry);
  workspace.actionContext = new ActionContext(workspace, new UiState(), registry);
  const internals = workspace as unknown as GhostInternals;
  try {
    assert.deepEqual(await internals.canonicalProject.openCanonical3mf(serialized.bytes), []);
    await run(workspace, internals);
  } finally {
    workspace.dispose();
  }
}

/** The drawn box's side and height, the outlined footprint's side and the box's centre, in printer millimetres. */
function measured(internals: GhostInternals) {
  const vis = CURRENT_THREE_WORLD_UNITS_PER_MM;
  const group = internals.wipeTowerGhost;
  assert.ok(group, 'the ghost is drawn');
  const [body, , footprint] = group.children as THREE.Mesh[];
  const size = (body.geometry as THREE.BoxGeometry).parameters;
  const plane = footprint?.geometry;
  plane?.computeBoundingBox();
  return {
    width: size.width / vis,
    height: size.height / vis,
    footprint: plane?.boundingBox ? (plane.boundingBox.max.x - plane.boundingBox.min.x) / vis : undefined,
    centre: group.position.clone().divideScalar(vis),
  };
}

const near = (actual: number | undefined, expected: number) =>
  actual !== undefined && Math.abs(actual - expected) < 1e-6;

await test('the ghost wears the footprint the preflight checks: the plate’s own width and brim', async () => {
  await towered(async (workspace, internals) => {
    workspace.rebuildWipeTowerGhost();
    const drawn = measured(internals);
    const state = live(internals.canonicalProject);
    const authority = wipeTowerFootprint(state, state.plates[0], [20, 30]);
    assert.equal(authority.widthMm, 25);
    assert.equal(authority.marginMm, 2);
    assert.ok(near(drawn.width, 25), `drawn ${drawn.width} mm wide`);
    assert.ok(near(drawn.footprint, 29), `footprint ${drawn.footprint} mm`);
    // The body's front-left corner is the tower's position.
    assert.ok(near(drawn.centre.x, 20 + 12.5 - internals.bedMm.x / 2), `centre x ${drawn.centre.x}`);
    assert.ok(near(drawn.centre.z, internals.bedMm.y / 2 - (30 + 12.5)), `centre z ${drawn.centre.z}`);
  });
});

await test('the ghost rises to the tallest model part, never a modifier', async () => {
  await towered(async (workspace, internals) => {
    workspace.rebuildWipeTowerGhost();
    const drawn = measured(internals);
    assert.ok(near(drawn.height, 40), `${drawn.height} mm tall`);
    assert.ok(near(drawn.centre.y, 20), 'standing on the bed');
  });
});

await test('a plate without a model part stands the ghost at 30 mm; a disabled tower draws none', async () => {
  await towered(async (workspace, internals) => {
    const controller = internals.canonicalProject;
    const plateId = live(controller).plates[0].id;
    await controller.deleteAllObjectsOnPlate(plateId);
    workspace.rebuildWipeTowerGhost();
    assert.ok(near(measured(internals).height, 30));
    assert.equal(controller.wipeTowerGhost(plateId)?.standIn, true);
    await controller.setPlateWipeTower(plateId, { enabled: false, positionMm: [20, 30], rotationDeg: 0 });
    workspace.rebuildWipeTowerGhost();
    assert.equal(internals.wipeTowerGhost, null);
  });
});

console.log(`\nWipe tower ghost: ${passed} tests passed.`);

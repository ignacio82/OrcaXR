/**
 * Every placement lands inside the box the slice preflight checks, on printers
 * whose printable area does not start at the bed corner: the Snapmaker U1's
 * bundled profile (its area starts at 0.5 × 1 mm) and a deliberately large
 * offset, whose bed far corner's half lies outside the area altogether. Each
 * placement reads the workspace's bed (`workspaceBed`) as `OrcaWorkspace`
 * passes it, and the live preflight of the project as authored judges the
 * result.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { seededRandom, UuidIdSource, type InstanceId } from '../../project/domain/ids';
import type { ConfigMap, ProjectState } from '../../project/domain/model';
import { primitiveFileName, primitiveGeometry, type PrimitiveKind } from '../../project/objects/primitives';
import { scaleInstancesToFitPrintVolume } from '../../project/objects/transformOperations';
import type { InstanceTransformChange } from '../../project/objects/transformCommands';
import { runCanonicalSlicePreflight } from '../../project/slicing/preflight';
import { InMemoryAssetRepository } from '../../project/assets';
import { authoredProjectPreflightTarget } from '../AuthoredSlicingTarget';
import { CanonicalWorkspaceController } from '../CanonicalWorkspaceController';
import { geometryBedPlacement } from '../geometryPlacement';
import { deriveLiveProfilePreflightConstraints, LiveProfileSlicePreflight } from '../ProfilePreflightConstraints';
import { workspaceBed } from '../WorkspaceBed';

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const u1Profile = JSON.parse(
  readFileSync(
    new URL('../../../public/profiles/Snapmaker/machine/Snapmaker U1 (0.4 nozzle).json', import.meta.url),
    'utf8',
  ),
) as ConfigMap;
const U1: ConfigMap = { printable_area: u1Profile.printable_area, printable_height: u1Profile.printable_height };
/** An area well away from the bed corner: half its far corner, (150, 130), is outside it. */
const FAR: ConfigMap = { printable_area: ['180x150', '300x150', '300x260', '180x260'], printable_height: '100' };

async function workspaceOn(config: ConfigMap) {
  const controller = CanonicalWorkspaceController.createEmpty({
    idSource: new UuidIdSource(seededRandom(0xb0c5)),
    clock: () => '2026-10-11T00:00:00.000Z',
    parent: new THREE.Scene(),
    mapping: { bedSizeMm: [270, 270], worldUnitsPerMm: 0.00175 },
  });
  const current = controller.getSlicingConfiguration();
  await controller.applySlicingConfiguration({ ...current, config: { ...current.config, ...config } });
  return controller;
}

/** The bed as `OrcaWorkspace.placementBed` reads it as an action runs. */
const bedOf = (controller: CanonicalWorkspaceController) => workspaceBed(controller.getSlicingConfiguration().config);

/** The project as a slice reads it. */
const snapshotOf = (controller: CanonicalWorkspaceController) => controller.createCanonicalSliceSource().capture();

/** [state] with [changes] applied. */
function withChanges(state: ProjectState, changes: readonly InstanceTransformChange[]): ProjectState {
  const next = structuredClone(state) as ProjectState;
  for (const change of changes)
    for (const plate of next.plates)
      for (const object of plate.objects)
        for (const instance of object.instances)
          if (instance.id === change.instanceId) instance.transform = structuredClone(change.transform);
  return next;
}

/** The instances the live preflight (the project as authored) finds outside its build volume or below the bed. */
function outside(controller: CanonicalWorkspaceController): string[] {
  const preflight = new LiveProfileSlicePreflight(
    deriveLiveProfilePreflightConstraints(authoredProjectPreflightTarget(controller.getSlicingConfiguration())),
  );
  const snapshot = snapshotOf(controller);
  const result = preflight.evaluate(snapshot, snapshot.state.activePlateId);
  return result.issues
    .filter((issue) => issue.code === 'instance-outside-build-volume' || issue.code === 'instance-below-build-plate')
    .map((issue) => issue.message);
}

/** `OrcaWorkspace.addPrimitive`: the shape centred on the placement area and resting on the bed. */
async function addPrimitive(controller: CanonicalWorkspaceController, kind: PrimitiveKind) {
  const geometry = primitiveGeometry(kind);
  const name = primitiveFileName(kind);
  return controller.importGeometry(geometry, {
    name,
    sourceFilename: name,
    transform: geometryBedPlacement(geometry, bedOf(controller).areaMm),
  });
}

/** A binary STL of one 100 × 100 × 10 mm wedge: it fits either area, but not centred on half its far corner. */
function wedgeStl(): Uint8Array {
  const corners = [
    [
      [0, 0, 0],
      [100, 0, 0],
      [0, 100, 0],
    ],
    [
      [0, 0, 0],
      [0, 100, 0],
      [0, 0, 10],
    ],
    [
      [0, 0, 0],
      [0, 0, 10],
      [100, 0, 0],
    ],
    [
      [100, 0, 0],
      [0, 0, 10],
      [0, 100, 0],
    ],
  ];
  const bytes = new Uint8Array(84 + corners.length * 50);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, corners.length, true);
  corners.forEach((triangle, index) => {
    let offset = 84 + index * 50 + 12;
    for (const [x, y, z] of triangle) {
      view.setFloat32(offset, x, true);
      view.setFloat32(offset + 4, y, true);
      view.setFloat32(offset + 8, z, true);
      offset += 12;
    }
  });
  return bytes;
}

await test("a cube scaled to the U1's build volume is one the preflight accepts", async () => {
  const controller = await workspaceOn(U1);
  const bed = bedOf(controller);
  assert.deepEqual(bed.volumeMm, { minMm: [0.5, 1, 0], maxMm: [270.5, 271, 270.05] }, 'the bundled U1 box');
  const cube = await addPrimitive(controller, 'cube');
  assert.deepEqual(outside(controller), []);

  // The defect: fitted to the far corner and centred on its half, the cube
  // overhung the area's near edges and the preflight refused it.
  const { state, assets: payloads } = snapshotOf(controller);
  const assets = new InMemoryAssetRepository();
  for (const asset of payloads) assets.put(asset.descriptor, asset.bytes);
  const fromCorner = scaleInstancesToFitPrintVolume(state, assets, [cube.instanceId], {
    minMm: [0, 0, 0],
    maxMm: [bed.sizeMm[0], bed.sizeMm[1], 270.05],
  });
  const refused = runCanonicalSlicePreflight({
    state: withChanges(state, fromCorner),
    assets,
    plateId: state.activePlateId,
    constraints: deriveLiveProfilePreflightConstraints(
      authoredProjectPreflightTarget(controller.getSlicingConfiguration()),
    ).constraints,
  });
  assert.ok(
    refused.issues.some((issue) => issue.code === 'instance-outside-build-volume'),
    'the corner-based box is the one the preflight refused',
  );

  assert.equal(await controller.scaleInstancesToFitPrintVolume([cube.instanceId], bed.volumeMm!), 1);
  assert.deepEqual(outside(controller), [], 'fitted to the box the preflight checks, it is accepted');
  controller.dispose();
});

for (const [name, config] of [
  ['the U1', U1],
  ['a far offset', FAR],
] as const) {
  await test(`every placement on ${name}'s printable area stays inside the preflight's volume`, async () => {
    const controller = await workspaceOn(config);
    const ids: InstanceId[] = [];
    const cube = await addPrimitive(controller, 'cube');
    ids.push(cube.instanceId);
    assert.deepEqual(outside(controller), [], 'a primitive lands on the area');
    const sphere = await addPrimitive(controller, 'sphere');
    ids.push(sphere.instanceId);
    assert.deepEqual(outside(controller), [], 'and the next');

    const volume = bedOf(controller).volumeMm!;
    assert.equal(await controller.scaleInstancesToFitPrintVolume([cube.instanceId], volume), 1);
    assert.deepEqual(outside(controller), [], 'scaled to fit');
    assert.equal(await controller.undoAsync(), true);

    await controller.centerInstancesOnPlate(ids, bedOf(controller).areaMm);
    assert.deepEqual(outside(controller), [], 'centred');
    const arranged = await controller.arrangePlate(controller.getSummary().activePlateId, {
      bedAreaMm: bedOf(controller).areaMm,
    });
    assert.equal(arranged.unplacedInstanceIds.length, 0);
    assert.deepEqual(outside(controller), [], 'arranged');
    const filled = await controller.fillPlateWithInstances(cube.instanceId, { bedAreaMm: bedOf(controller).areaMm }, 8);
    assert.ok(filled.created > 0);
    assert.deepEqual(outside(controller), [], 'filled');

    const prepared = await controller.prepareModelImport(
      wedgeStl(),
      { filename: 'wedge.stl' },
      { placement: { bedAreaMm: bedOf(controller).areaMm, dropToBed: true } },
    );
    await controller.confirmImport(prepared, {
      confirmed: true,
      acknowledgedNoticeIds: prepared.preview.requiredAcknowledgementIds,
    });
    assert.deepEqual(outside(controller), [], 'an import lands on the area');
    controller.dispose();
  });
}

console.log(`\nPlacements inside the preflight's build volume: ${passed} tests passed.`);

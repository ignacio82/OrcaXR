/**
 * Preview and apply are the same decimation (P5.3.5).
 *
 * The Accept clause asks that "the preview matches the applied result", and
 * decimation is the one edit where that cannot be checked after the fact — what
 * it removed is gone. So `prepareSimplifyVolume` computes without committing
 * and `applyPreparedSimplify` installs exactly what it produced. These traces
 * pin that the split really does that: that preview touches nothing, that apply
 * installs the previewed mesh rather than a second run of the same settings,
 * and that the guard still refuses a volume that moved underneath.
 */

import assert from 'node:assert/strict';
import * as THREE from 'three';

import type { EntityId, IdSource, VolumeId } from '../../project/domain/ids';
import { BbsProjectImportParser } from '../../project/import/BbsProjectImportParser';
import { CanonicalWorkspaceController } from '../CanonicalWorkspaceController';
import { decodeIndexedMeshAsset } from '../../project/meshCodec';

const NOW = '2026-08-01T12:00:00.000Z';
const MAPPING = { bedSizeMm: [270, 270] as const, worldUnitsPerMm: 0.00175 };

let passed = 0;

async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

class SequenceIdSource implements IdSource {
  private nextNumber = 1;

  next<Kind extends string>(kind: Kind): EntityId<Kind> {
    return `import:simplify-preview:${kind}-${this.nextNumber++}` as EntityId<Kind>;
  }
}

function controller(): CanonicalWorkspaceController {
  return CanonicalWorkspaceController.createEmpty({
    idSource: new SequenceIdSource(),
    clock: () => NOW,
    parent: new THREE.Scene(),
    mapping: MAPPING,
    projectImportParser: new BbsProjectImportParser(),
  });
}

/** A sphere: dense enough that a 50 % ratio has plenty to collapse. */
function sphere(): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(10, 24, 16);
  return geometry.index ? geometry : geometry.toNonIndexed();
}

function firstVolume(workspace: CanonicalWorkspaceController): VolumeId {
  const state = workspace.createCanonicalSliceSource().capture().state;
  const volume = state.plates[0]?.objects[0]?.volumes[0];
  assert.ok(volume, 'the imported project has a volume');
  return volume.id;
}

function meshOf(
  workspace: CanonicalWorkspaceController,
  volumeId: VolumeId,
): {
  positions: readonly number[];
  indices: readonly number[];
} {
  const snapshot = workspace.createCanonicalSliceSource().capture();
  const state = snapshot.state;
  const volume = state.plates
    .flatMap((plate) => plate.objects)
    .flatMap((object) => object.volumes)
    .find((entry) => entry.id === volumeId);
  assert.ok(volume, 'the volume is still in the project');
  const asset = snapshot.assets.find((entry) => entry.descriptor.id === volume.source.assetId);
  assert.ok(asset, 'the volume has a stored mesh');
  const decoded = decodeIndexedMeshAsset(asset);
  return {
    positions: decoded.vertices.flat(),
    indices: decoded.triangles.flat(),
  };
}

await test('preparing a decimation changes nothing at all', () => {
  const workspace = controller();
  workspace.importBufferGeometry(sphere(), { name: 'Ball' });
  const volumeId = firstVolume(workspace);
  const before = meshOf(workspace, volumeId);
  const historyBefore = workspace.getSummary().history.undoCount;

  const prepared = workspace.prepareSimplifyVolume(volumeId, {
    useCount: true,
    decimateRatio: 50,
    maxError: 1,
  });
  assert.ok(prepared, 'a sphere at 50 % has something to collapse');
  assert.ok(prepared.afterTriangles < prepared.beforeTriangles, 'and it collapsed some of it');

  const after = meshOf(workspace, volumeId);
  assert.deepEqual(after.indices, before.indices, 'the stored mesh is untouched');
  assert.equal(workspace.getSummary().history.undoCount, historyBefore, 'and no command was recorded');
});

await test('apply installs exactly the mesh the preview computed', () => {
  const workspace = controller();
  workspace.importBufferGeometry(sphere(), { name: 'Ball' });
  const volumeId = firstVolume(workspace);

  const prepared = workspace.prepareSimplifyVolume(volumeId, {
    useCount: true,
    decimateRatio: 50,
    maxError: 1,
  });
  assert.ok(prepared);
  const result = workspace.applyPreparedSimplify(prepared);

  const installed = meshOf(workspace, volumeId);
  // Not "close enough" — the same triangles. This is the whole reason prepare
  // and apply were split apart, so the assertion is exact on purpose.
  assert.deepEqual(installed.indices, [...prepared.indices], 'the installed triangles are the previewed ones');
  // Vertices are exact too, once through the one lossy step in the path: the
  // asset stores float32 and the decimation works in float64. Asserting the
  // rounding rather than tolerating a delta keeps this a statement about the
  // storage format instead of a licence for the two to drift.
  assert.deepEqual(
    installed.positions,
    prepared.positions.map((value) => Math.fround(value)),
    'and the vertices are the previewed ones at storage precision',
  );
  assert.equal(result.afterTriangles, prepared.afterTriangles);
  assert.equal(installed.indices.length / 3, prepared.afterTriangles);
});

await test('the error mode stops where the error limit says, not where a ratio does', () => {
  const workspace = controller();
  workspace.importBufferGeometry(sphere(), { name: 'Ball' });
  const volumeId = firstVolume(workspace);

  const tight = workspace.prepareSimplifyVolume(volumeId, {
    useCount: false,
    decimateRatio: 50,
    maxError: 0.01,
  });
  const loose = workspace.prepareSimplifyVolume(volumeId, {
    useCount: false,
    decimateRatio: 50,
    maxError: 5,
  });
  assert.ok(loose, 'a generous error budget collapses something');
  // A null prepare means nothing collapsed at all, which for this comparison is
  // the source count: the tight budget kept every triangle.
  const tightCount = tight ? tight.afterTriangles : loose.beforeTriangles;
  assert.ok(
    loose.afterTriangles < tightCount,
    `a looser error limit removes more: ${loose.afterTriangles} vs ${tightCount}`,
  );
  assert.ok(loose.maxError <= 5, 'and never accepts a collapse past its own limit');
});

await test('the ratio mode is driven by count, so the same ratio lands on the same count', () => {
  const workspace = controller();
  workspace.importBufferGeometry(sphere(), { name: 'Ball' });
  const volumeId = firstVolume(workspace);

  const half = workspace.prepareSimplifyVolume(volumeId, { useCount: true, decimateRatio: 50, maxError: 1 });
  const quarter = workspace.prepareSimplifyVolume(volumeId, { useCount: true, decimateRatio: 25, maxError: 1 });
  assert.ok(half && quarter);
  assert.ok(
    half.afterTriangles < quarter.afterTriangles,
    `removing half leaves fewer than removing a quarter: ${half.afterTriangles} vs ${quarter.afterTriangles}`,
  );
  // Preparing twice with the same settings is the same answer, which is what
  // lets a preview be trusted across a re-render.
  const again = workspace.prepareSimplifyVolume(volumeId, { useCount: true, decimateRatio: 50, maxError: 1 });
  assert.ok(again);
  assert.deepEqual([...again.indices], [...half.indices]);
});

await test('a prepared decimation is refused once the volume has moved on', () => {
  const workspace = controller();
  workspace.importBufferGeometry(sphere(), { name: 'Ball' });
  const volumeId = firstVolume(workspace);

  const stale = workspace.prepareSimplifyVolume(volumeId, { useCount: true, decimateRatio: 50, maxError: 1 });
  assert.ok(stale);
  // Someone else decimates first. The prepared result now describes a topology
  // that is no longer there, and installing it would silently undo their edit.
  workspace.simplifyVolume(volumeId, { useCount: true, decimateRatio: 30, maxError: 1 });
  assert.throws(() => workspace.applyPreparedSimplify(stale), /topolog|guard|stale|revision/i);
});

await test('undo after an applied preview restores the original mesh exactly', () => {
  const workspace = controller();
  workspace.importBufferGeometry(sphere(), { name: 'Ball' });
  const volumeId = firstVolume(workspace);
  const before = meshOf(workspace, volumeId);

  const prepared = workspace.prepareSimplifyVolume(volumeId, { useCount: true, decimateRatio: 50, maxError: 1 });
  assert.ok(prepared);
  workspace.applyPreparedSimplify(prepared);
  assert.notDeepEqual(meshOf(workspace, volumeId).indices, before.indices);

  workspace.undo();
  assert.deepEqual(meshOf(workspace, volumeId).indices, before.indices, 'undo puts every triangle back');
  assert.deepEqual(meshOf(workspace, volumeId).positions, before.positions);
});

console.log(`\nSimplify preview: ${passed} tests passed.`);

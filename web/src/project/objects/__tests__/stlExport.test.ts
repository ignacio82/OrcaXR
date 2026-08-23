import assert from 'node:assert/strict';

import { createProjectFixture } from '../../__tests__/fixtures';
import { InMemoryAssetRepository } from '../../assets';
import { cloneProjectState } from '../../domain/canonical';
import { entityId } from '../../domain/ids';
import { emptyFacetAnnotations, identityTransform } from '../../domain/model';
import { encodeIndexedMeshAsset } from '../../meshCodec';
import { exportCanonicalInstancesAsBinaryStl, exportCanonicalVolumeAsBinaryStl } from '../stlExport';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function harness() {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  const asset = encodeIndexedMeshAsset({
    id: fixture.ids.asset,
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    sourceFilename: 'triangle.stl',
  });
  state.sourceAssets = [asset.descriptor];
  const volume = state.plates[0].objects[0].volumes[0];
  volume.source = { assetId: asset.descriptor.id, topologyRevision: 0, triangleCount: 1 };
  volume.transform = { ...identityTransform(), translationMm: [1, 2, 3] };
  const instance = state.plates[0].objects[0].instances[0];
  instance.transform = {
    translationMm: [10, 20, 30],
    rotation: [0, 0, 0, 1],
    scale: [-2, 1, 1],
  };
  const assets = new InMemoryAssetRepository();
  assets.put(asset.descriptor, asset.bytes);
  return { fixture, state, assets };
}

function vectorAt(view: DataView, offset: number): number[] {
  return [view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true)];
}

test('writes deterministic transformed binary facets and corrects mirrored winding', () => {
  const { fixture, state, assets } = harness();
  const first = exportCanonicalInstancesAsBinaryStl(state, assets, [fixture.ids.instance]);
  const second = exportCanonicalInstancesAsBinaryStl(state, assets, [fixture.ids.instance]);
  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.bytes.byteLength, 134);
  assert.equal(first.triangleCount, 1);
  assert.equal(first.instanceCount, 1);
  assert.deepEqual(first.volumeIds, [fixture.ids.volume]);

  const view = new DataView(first.bytes.buffer, first.bytes.byteOffset, first.bytes.byteLength);
  assert.equal(view.getUint32(80, true), 1);
  assert.deepEqual(vectorAt(view, 84), [0, 0, 1]);
  assert.deepEqual(vectorAt(view, 96), [8, 22, 33]);
  assert.deepEqual(vectorAt(view, 108), [8, 23, 33]);
  assert.deepEqual(vectorAt(view, 120), [6, 22, 33]);
  assert.equal(view.getUint16(132, true), 0);
});

test('merges an exact stable-ID set while excluding non-printing modifiers', () => {
  const { fixture, state, assets } = harness();
  const secondId = entityId<'instance'>('import:stl-export:second');
  state.plates[0].objects[0].instances.push({
    id: secondId,
    transform: { ...identityTransform(), translationMm: [0, 0, 5] },
    printable: true,
  });
  const modifierId = entityId<'volume'>('import:stl-export:modifier');
  state.plates[0].objects[0].volumes.push({
    ...state.plates[0].objects[0].volumes[0],
    id: modifierId,
    name: 'Ignored modifier',
    role: 'parameter-modifier',
    transform: identityTransform(),
    config: {},
    annotations: emptyFacetAnnotations(0),
  });

  const result = exportCanonicalInstancesAsBinaryStl(state, assets, [fixture.ids.instance, secondId]);
  assert.equal(result.triangleCount, 2);
  assert.equal(result.instanceCount, 2);
  assert.deepEqual(result.volumeIds, [fixture.ids.volume, fixture.ids.volume]);
  assert.equal(result.bytes.byteLength, 184);
});

test('fails closed for CSG, duplicate or unknown targets, stale counts, and asset drift', () => {
  const { fixture, state, assets } = harness();
  assert.throws(() => exportCanonicalInstancesAsBinaryStl(state, assets, []), /at least one instance/i);
  assert.throws(
    () => exportCanonicalInstancesAsBinaryStl(state, assets, [fixture.ids.instance, fixture.ids.instance]),
    /duplicate instance/i,
  );
  assert.throws(
    () => exportCanonicalInstancesAsBinaryStl(state, assets, [entityId<'instance'>('import:stl-export:missing')]),
    /unknown instance/i,
  );

  const stale = cloneProjectState(state);
  stale.plates[0].objects[0].volumes[0].source.triangleCount = 2;
  assert.throws(
    () => exportCanonicalInstancesAsBinaryStl(stale, assets, [fixture.ids.instance]),
    /triangle count differs/i,
  );

  const mismatched = cloneProjectState(state);
  mismatched.sourceAssets[0].sourceFilename = 'different.stl';
  assert.throws(
    () => exportCanonicalInstancesAsBinaryStl(mismatched, assets, [fixture.ids.instance]),
    /metadata differs/i,
  );

  const csg = cloneProjectState(state);
  csg.plates[0].objects[0].volumes[0].role = 'negative-volume';
  assert.throws(
    () => exportCanonicalInstancesAsBinaryStl(csg, assets, [fixture.ids.instance]),
    /requires canonical CSG/i,
  );
});

test('exportCanonicalVolumeAsBinaryStl exports single volume in local space without instance transforms', () => {
  const { fixture, state, assets } = harness();
  const bytes = exportCanonicalVolumeAsBinaryStl(state, assets, fixture.ids.volume);
  assert.equal(bytes.byteLength, 84 + 50);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(80, true), 1);
  // First vertex is at local (0, 0, 0)
  assert.equal(view.getFloat32(84 + 12, true), 0);
  assert.equal(view.getFloat32(84 + 16, true), 0);
  assert.equal(view.getFloat32(84 + 20, true), 0);
});

console.log(`\nCanonical binary STL export: ${passed} tests passed.`);

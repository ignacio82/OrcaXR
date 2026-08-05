import assert from 'node:assert/strict';

import { InMemoryAssetRepository } from '../../assets';
import { cloneProjectState } from '../../domain/canonical';
import { entityId } from '../../domain/ids';
import { identityTransform } from '../../domain/model';
import { encodeIndexedMeshAsset } from '../../meshCodec';
import { createProjectFixture } from '../../__tests__/fixtures';
import { computeCanonicalInstanceBounds } from '../bounds';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function assertVec3Close(actual: readonly number[], expected: readonly number[]): void {
  assert.equal(actual.length, 3);
  for (let axis = 0; axis < 3; axis += 1) {
    assert.ok(Math.abs(actual[axis] - expected[axis]) < 1e-12, `axis ${axis}: ${actual[axis]} !== ${expected[axis]}`);
  }
}

function harness() {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  const asset = encodeIndexedMeshAsset({
    id: fixture.ids.asset,
    positions: [0, 0, -1, 2, 0, 3, 0, 4, 1],
  });
  state.sourceAssets = [asset.descriptor];
  state.plates[0].objects[0].volumes[0].source.triangleCount = 1;
  const assets = new InMemoryAssetRepository();
  assets.put(asset.descriptor, asset.bytes);
  return { fixture, state, assets };
}

test('composes canonical volume and instance TRS without reading a render projection', () => {
  const { fixture, state, assets } = harness();
  const quarterTurn = [0, 0, Math.SQRT1_2, Math.SQRT1_2] as const;
  state.plates[0].objects[0].volumes[0].transform = {
    translationMm: [1, 2, 3],
    rotation: quarterTurn,
    scale: [2, 1, 0.5],
  };
  state.plates[0].objects[0].instances[0].transform = {
    translationMm: [10, 20, 30],
    rotation: [0, 0, 0, 1],
    scale: [1, 2, 1],
  };

  const bounds = computeCanonicalInstanceBounds(state, assets, [fixture.ids.instance]);
  assertVec3Close(bounds.min, [7, 24, 32.5]);
  assertVec3Close(bounds.max, [11, 32, 34.5]);
  assert.equal(Object.isFrozen(bounds), true);
  assert.equal(Object.isFrozen(bounds.min), true);
});

test('transforms canonical vertices rather than overestimating from local box corners', () => {
  const { fixture, state, assets } = harness();
  const halfAngle = Math.PI / 8;
  state.plates[0].objects[0].volumes[0].transform = {
    ...identityTransform(),
    rotation: [0, 0, Math.sin(halfAngle), Math.cos(halfAngle)],
  };

  const bounds = computeCanonicalInstanceBounds(state, assets, [fixture.ids.instance]);
  assertVec3Close(bounds.min, [-2 * Math.SQRT2, 0, -1]);
  assertVec3Close(bounds.max, [Math.SQRT2, 2 * Math.SQRT2, 3]);
});

test('unions an exact stable-ID set and rejects duplicate, missing, or mismatched assets', () => {
  const { fixture, state, assets } = harness();
  const secondId = entityId<'instance'>('import:bounds:second');
  state.plates[0].objects[0].instances.push({
    id: secondId,
    transform: { ...identityTransform(), translationMm: [20, -2, 5] },
    printable: true,
  });
  assert.deepEqual(computeCanonicalInstanceBounds(state, assets, [fixture.ids.instance, secondId]), {
    min: [0, -2, -1],
    max: [22, 4, 8],
  });
  assert.throws(() => computeCanonicalInstanceBounds(state, assets, []), /at least one instance/i);
  assert.throws(
    () => computeCanonicalInstanceBounds(state, assets, [fixture.ids.instance, fixture.ids.instance]),
    /duplicate instance/i,
  );
  assert.throws(
    () => computeCanonicalInstanceBounds(state, assets, [entityId<'instance'>('import:bounds:missing')]),
    /unknown instance/i,
  );

  const mismatched = cloneProjectState(state);
  mismatched.sourceAssets[0].sourceFilename = 'different.stl';
  assert.throws(() => computeCanonicalInstanceBounds(mismatched, assets, [fixture.ids.instance]), /metadata differs/i);

  state.plates[0].objects[0].volumes[0].role = 'parameter-modifier';
  assert.throws(
    () => computeCanonicalInstanceBounds(state, assets, [fixture.ids.instance], { volumeRoles: ['model'] }),
    /no bounded mesh geometry/i,
  );
});

console.log(`\nCanonical instance bounds: ${passed} tests passed.`);

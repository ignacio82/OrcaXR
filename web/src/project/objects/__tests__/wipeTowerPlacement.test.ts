import assert from 'node:assert/strict';

import { InMemoryAssetRepository } from '../..';
import {
  aabbLInfClearance,
  parseBias,
  planWipeTowerPlacement,
  scoreWipeTower,
  WipeTowerPlacementError,
} from '../wipeTowerPlacement';
import { createProjectFixture } from '../../__tests__/fixtures';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

test('Chebyshev clearance distance calculation', () => {
  const a = { xMin: 0, yMin: 0, xMax: 10, yMax: 10 };
  const b = { xMin: 20, yMin: 0, xMax: 30, yMax: 10 };
  assert.equal(aabbLInfClearance(a, b), 10);

  const diag = { xMin: 20, yMin: 20, xMax: 30, yMax: 30 };
  assert.equal(aabbLInfClearance(a, diag), 10);

  const overlap = { xMin: 5, yMin: 5, xMax: 15, yMax: 15 };
  assert.ok(aabbLInfClearance(a, overlap) < 0);
});

test('parseBias converts bias strings robustly', () => {
  assert.equal(parseBias('back_left'), 'back_left');
  assert.equal(parseBias('back-left'), 'back_left');
  assert.equal(parseBias('BACK_RIGHT'), 'back_right');
  assert.equal(parseBias('front-left'), 'front_left');
  assert.equal(parseBias('front_right'), 'front_right');
  assert.equal(parseBias('largest_clearance'), 'largest_clearance');
  assert.equal(parseBias('largest'), 'largest_clearance');
  assert.equal(parseBias('max'), 'largest_clearance');
  assert.equal(parseBias(null), 'back_left');
  assert.equal(parseBias('unknown'), 'back_left');
});

test('scoreWipeTower on empty bed chooses back-left by default', () => {
  const pick = scoreWipeTower([], 256, 256, { towerW: 60, towerD: 60 });
  assert.equal(pick.label, 'back-left');
  assert.equal(pick.xMm, 1);
  assert.equal(pick.yMm, 195);
  assert.equal(pick.clearanceMm, Infinity);
});

test('scoreWipeTower chooses high-clearance candidate avoiding parts', () => {
  // Part occupying the back-left quadrant [0..100, 150..256]
  const parts = [{ xMin: 0, yMin: 150, xMax: 100, yMax: 256 }];
  const pick = scoreWipeTower(parts, 256, 256, { towerW: 60, towerD: 60, bias: 'back_left' });

  // Back-left overlaps or has small clearance with part, so it should pick another candidate (e.g. back-right or front-left)
  assert.notEqual(pick.label, 'back-left');
  assert.ok(pick.clearanceMm > 30);
});

test('planWipeTowerPlacement computes bounds and returns placement result', () => {
  const fixture = createProjectFixture();
  const state = fixture.state;
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const plateId = state.activePlateId;

  const result = planWipeTowerPlacement(state, assets, plateId, {
    bedSizeMm: [256, 256],
  });

  assert.equal(result.plateId, plateId);
  assert.equal(result.state.enabled, true);
  assert.ok(Array.isArray(result.state.positionMm));
  assert.equal(result.state.positionMm.length, 2);
  assert.ok(Number.isFinite(result.state.positionMm[0]));
  assert.ok(Number.isFinite(result.state.positionMm[1]));
});

test('planWipeTowerPlacement fails closed on invalid inputs', () => {
  const fixture = createProjectFixture();
  const state = fixture.state;
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);

  assert.throws(
    () => planWipeTowerPlacement(state, assets, 'non-existent-plate' as any, { bedSizeMm: [256, 256] }),
    (err: any) => err instanceof WipeTowerPlacementError && err.code === 'unknown-plate',
  );

  // Clear printable area from config and provide no bedSizeMm
  const stateNoBed = JSON.parse(JSON.stringify(state));
  delete stateNoBed.config.printable_area;
  delete stateNoBed.plates[0].config.printable_area;

  assert.throws(
    () => planWipeTowerPlacement(stateNoBed, assets, state.activePlateId),
    (err: any) => err instanceof WipeTowerPlacementError && err.code === 'invalid-bed',
  );
});

console.log(`\nWipeTowerPlacement domain tests: ${passed} tests passed.`);

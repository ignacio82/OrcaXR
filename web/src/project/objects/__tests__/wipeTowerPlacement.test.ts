import assert from 'node:assert/strict';

import { InMemoryAssetRepository } from '../..';
import {
  aabbLInfClearance,
  parseBias,
  planWipeTowerPlacement,
  printableAreaRect,
  scoreWipeTower,
  wipeTowerFootprintMarginMm,
  WipeTowerPlacementError,
  type AabbXY,
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

const SQUARE_BED: AabbXY = { xMin: 0, yMin: 0, xMax: 256, yMax: 256 };

/** The Snapmaker U1's own printable area — the bed this bug was found on. */
const U1_BED: AabbXY = { xMin: 0.5, yMin: 1, xMax: 270.5, yMax: 271 };

function contains(bed: AabbXY, box: AabbXY): boolean {
  return box.xMin >= bed.xMin && box.yMin >= bed.yMin && box.xMax <= bed.xMax && box.yMax <= bed.yMax;
}

test('scoreWipeTower on empty bed chooses back-left by default', () => {
  const pick = scoreWipeTower([], SQUARE_BED, { towerW: 60, towerD: 60 });
  assert.equal(pick.label, 'back-left');
  assert.equal(pick.xMm, 1);
  assert.equal(pick.yMm, 195);
  assert.equal(pick.clearanceMm, Infinity);
});

test('scoreWipeTower chooses high-clearance candidate avoiding parts', () => {
  // Part occupying the back-left quadrant [0..100, 150..256]
  const parts = [{ xMin: 0, yMin: 150, xMax: 100, yMax: 256 }];
  const pick = scoreWipeTower(parts, SQUARE_BED, { towerW: 60, towerD: 60, bias: 'back_left' });

  // Back-left overlaps or has small clearance with part, so it should pick another candidate (e.g. back-right or front-left)
  assert.notEqual(pick.label, 'back-left');
  assert.ok(pick.clearanceMm > 30);
});

test('the reserved footprint lands on the bed for every candidate and bias', () => {
  // The defect this suite exists to prevent: a tower whose body is on the bed
  // while the brim and the rib wall it drags with it are not.
  const parts = [{ xMin: 100, yMin: 100, xMax: 160, yMax: 160 }];
  for (const bias of ['back_left', 'back_right', 'front_left', 'front_right', 'largest_clearance'] as const) {
    for (const marginMm of [0, 5, 13]) {
      const pick = scoreWipeTower(parts, U1_BED, { towerW: 30, towerD: 30, marginMm, bias });
      assert.ok(
        contains(U1_BED, pick.footprint),
        `${bias} @ margin ${marginMm}: footprint ${JSON.stringify(pick.footprint)} escapes the bed`,
      );
      // The engine is handed the body corner, and the body sits inside its
      // own footprint by exactly the reserved margin.
      assert.equal(pick.xMm, pick.footprint.xMin + marginMm);
      assert.equal(pick.yMm, pick.footprint.yMin + marginMm);
    }
  }
});

test('a bed whose printable area starts away from the origin is not treated as one that does', () => {
  // `printable_area = 0.5x1 … 270.5x271`. Placing against the left/front edge
  // must respect x ≥ 0.5 and y ≥ 1, not x ≥ 0 and y ≥ 0.
  const pick = scoreWipeTower([], U1_BED, { towerW: 30, towerD: 30, marginMm: 0, bias: 'front_left' });
  assert.equal(pick.xMm, 1.5, 'left inset is measured from the printable edge, not from zero');
  assert.equal(pick.yMm, 2);
});

test('a bed too small for the inset still keeps the footprint on it', () => {
  const tight: AabbXY = { xMin: 0, yMin: 0, xMax: 31, yMax: 31 };
  const pick = scoreWipeTower([], tight, { towerW: 30, towerD: 30, marginMm: 5 });
  // 30 + 2×5 = 40 mm of footprint cannot fit 31 mm of bed, so the placement is
  // clamped to the corner rather than pushed off the near edge as well.
  assert.equal(pick.footprint.xMin, 0);
  assert.equal(pick.footprint.yMin, 0);
});

test('clearance is measured symmetrically around the tower', () => {
  // A part 40 mm to the *left* of the tower and one 40 mm to its right must
  // score the same. The old anchored guard box grew only toward +X/+Y, so the
  // left part read as closer than it was.
  const bed: AabbXY = { xMin: 0, yMin: 0, xMax: 300, yMax: 300 };
  const opts = { towerW: 30, towerD: 30, marginMm: 0, safetyMm: 5, bias: 'largest_clearance' } as const;
  const left = scoreWipeTower([{ xMin: 0, yMin: 135, xMax: 95, yMax: 165 }], bed, opts);
  const right = scoreWipeTower([{ xMin: 205, yMin: 135, xMax: 300, yMax: 165 }], bed, opts);
  assert.equal(left.clearanceMm, right.clearanceMm);
});

test('the reserved margin is the engine’s own brim and rib geometry', () => {
  // Plain wall: only the brim reaches outside the body.
  assert.equal(wipeTowerFootprintMarginMm({ prime_tower_brim_width: 5 }), 5);
  assert.equal(wipeTowerFootprintMarginMm({ prime_tower_brim_width: 5, wipe_tower_wall_type: 'rectangle' }), 5);
  // Rib wall: the diagonals' half-width and their extension reach further.
  assert.equal(
    wipeTowerFootprintMarginMm({
      prime_tower_brim_width: 5,
      wipe_tower_wall_type: 'rib',
      wipe_tower_rib_width: 8,
      wipe_tower_extra_rib_length: 8,
    }),
    13,
  );
  // Config arrives from the engine as strings and one-element vectors.
  assert.equal(wipeTowerFootprintMarginMm({ prime_tower_brim_width: '5' }), 5);
  assert.equal(wipeTowerFootprintMarginMm({ prime_tower_brim_width: ['5'] }), 5);
  assert.equal(wipeTowerFootprintMarginMm({}), 0);
});

test('printableAreaRect keeps the origin the polygon declares', () => {
  assert.deepEqual(printableAreaRect('0.5x1,270.5x1,270.5x271,0.5x271'), U1_BED);
  assert.deepEqual(printableAreaRect(['0x0', '256x0', '256x256', '0x256']), SQUARE_BED);
  assert.equal(printableAreaRect('nonsense'), undefined);
  assert.equal(printableAreaRect('10x10'), undefined, 'one corner is not a rectangle');
});

test('planWipeTowerPlacement computes bounds and returns placement result', () => {
  const fixture = createProjectFixture();
  const state = fixture.state;
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const plateId = state.activePlateId;

  const result = planWipeTowerPlacement(state, assets, plateId, {
    bedRectMm: SQUARE_BED,
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
    () => planWipeTowerPlacement(state, assets, 'non-existent-plate' as any, { bedRectMm: SQUARE_BED }),
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

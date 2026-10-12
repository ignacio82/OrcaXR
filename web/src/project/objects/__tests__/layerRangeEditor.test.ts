import assert from 'node:assert/strict';

import { createProjectFixture } from '../../__tests__/fixtures';
import type { LayerRangeId } from '../../domain/ids';
import {
  formatLayerRangeBounds,
  formatLayerRangeMm,
  layerRangeEditorProjection,
  layerRangeOperationMessages,
  orderLayerRanges,
  validateLayerRangeBounds,
  validateLayerRangeSplit,
} from '../layerRangeEditor';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const id = (value: string) => value as LayerRangeId;

test('heights read as Intl writes them: the shortest digits rounded half away from zero', () => {
  // ICU rounds the number's own shortest spelling, not its binary value.
  assert.equal(formatLayerRangeMm(123456789.12345), '123456789.1235 mm');
  assert.equal((123456789.12345).toFixed(4), '123456789.1234');
  assert.equal(formatLayerRangeMm(0.03125), '0.0313 mm');
  assert.equal(formatLayerRangeMm(2.5e-5), '0 mm');
  assert.equal(formatLayerRangeMm(-0), '-0 mm');
  assert.equal(formatLayerRangeMm(1e21), '1000000000000000000000 mm');
  assert.equal(formatLayerRangeBounds(0, 7.300000000000001), '0 mm–7.3 mm');
});

test('typed bounds and split heights are checked before anything is sent', () => {
  const ranges = [{ id: id('a'), minZMm: 0, maxZMm: 2.5 }];
  assert.deepEqual(validateLayerRangeBounds(' ', '5', ranges), {
    valid: false,
    message: 'Enter finite minimum and maximum Z values.',
  });
  assert.equal(validateLayerRangeBounds('3', '1', ranges).message, 'Bounds must satisfy 0 ≤ minimum Z < maximum Z.');
  assert.equal(validateLayerRangeBounds('2', '4', ranges).message, '2 mm–4 mm overlaps existing 0 mm–2.5 mm.');
  // The range being edited is not its own neighbour.
  assert.deepEqual(validateLayerRangeBounds('0', '3', ranges, id('a')), {
    valid: true,
    message: '',
    minZMm: 0,
    maxZMm: 3,
  });
  assert.deepEqual(validateLayerRangeSplit('2.5', ranges[0]), {
    valid: false,
    message: 'Split height must be strictly inside 0 mm–2.5 mm.',
  });
  assert.deepEqual(validateLayerRangeSplit(' 1e0 ', ranges[0]), { valid: true, splitZMm: 1 });
  assert.deepEqual(layerRangeOperationMessages({ kind: 'add', minZMm: 0, maxZMm: 5 }), {
    pending: 'Adding 0 mm–5 mm…',
    success: 'Added 0 mm–5 mm.',
  });
});

test("the selected range's merges are the merge command's decisions, in UTF-16 order", () => {
  const { state, object } = createProjectFixture();
  const first = object.layerRanges[0].id;
  object.layerRanges.push(
    { id: id('Z-upper'), minZMm: 5, maxZMm: 7, config: {} },
    { id: id('a-top'), minZMm: 7, maxZMm: 9, config: { layer_height: 0.12 } },
  );
  const projection = layerRangeEditorProjection(state, object.id, id('Z-upper'));
  assert.deepEqual(
    projection?.layerRanges.map((range) => range.id),
    [first, 'Z-upper', 'a-top'],
  );
  assert.deepEqual(projection?.selectedLayerRange, {
    id: 'Z-upper',
    mergePrevious: {
      allowed: false,
      reason: 'Layer ranges with different settings cannot be merged without an explicit conflict choice',
      otherRangeId: first,
    },
    mergeNext: {
      allowed: false,
      reason: 'Layer ranges with different settings cannot be merged without an explicit conflict choice',
      otherRangeId: 'a-top',
    },
  });
  // Equal bounds order by UTF-16 units ('Z' before 'a'), as the commands order them.
  assert.deepEqual(
    orderLayerRanges([
      { id: id('a'), minZMm: 1, maxZMm: 2 },
      { id: id('Z'), minZMm: 1, maxZMm: 2 },
    ]).map((range) => range.id),
    ['Z', 'a'],
  );
  assert.equal(layerRangeEditorProjection(state, 'missing' as typeof object.id), undefined);
});

console.log(`Height-range editor: ${passed} tests passed.`);

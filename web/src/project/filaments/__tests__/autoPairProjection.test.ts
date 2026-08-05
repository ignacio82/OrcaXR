import assert from 'node:assert/strict';

import { entityId, type MixedFilamentId, type PhysicalFilamentId } from '../../domain/ids';
import {
  FullSpectrumAutoPairProjectionError,
  regenerateFullSpectrumAutoPairs,
  type FullSpectrumAutoPairAllocationContext,
  type FullSpectrumAutoPairIdentityAllocator,
  type FullSpectrumAutoPairProjectionRow,
} from '../autoPairProjection';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function physical(name: string): PhysicalFilamentId {
  return entityId<'physical-filament'>(`import:auto-pair:physical-${name}`);
}

function mixed(name: string): MixedFilamentId {
  return entityId<'mixed-filament'>(`import:auto-pair:mixed-${name}`);
}

function row(
  name: string,
  componentAId: PhysicalFilamentId,
  componentBId: PhysicalFilamentId,
  upstreamStableId: string,
  flags: Partial<Pick<FullSpectrumAutoPairProjectionRow, 'enabled' | 'deleted' | 'custom' | 'originAuto'>> = {},
): FullSpectrumAutoPairProjectionRow {
  return Object.freeze({
    id: mixed(name),
    componentAId,
    componentBId,
    upstreamStableId,
    enabled: flags.enabled ?? true,
    deleted: flags.deleted ?? false,
    custom: flags.custom ?? false,
    originAuto: flags.originAuto ?? true,
  });
}

function deterministicAllocator(
  calls: FullSpectrumAutoPairAllocationContext[] = [],
  stableIdBase = 1_000,
): FullSpectrumAutoPairIdentityAllocator {
  return (context) => {
    calls.push(context);
    return {
      id: mixed(`generated-${context.pairOrdinal}`),
      upstreamStableId: String(stableIdBase + context.pairOrdinal),
    };
  };
}

test('creates deterministic C(N,2) rows in physical-library order', () => {
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(physical);
  const physicalIds = Object.freeze([a, b, c, d]);
  const existingRows = Object.freeze([] as FullSpectrumAutoPairProjectionRow[]);
  const calls: FullSpectrumAutoPairAllocationContext[] = [];

  const result = regenerateFullSpectrumAutoPairs(physicalIds, existingRows, deterministicAllocator(calls));

  assert.deepEqual(
    result.autoPairRows.map(({ componentAId, componentBId }) => [componentAId, componentBId]),
    [
      [a, b],
      [a, c],
      [a, d],
      [b, c],
      [b, d],
      [c, d],
    ],
  );
  assert.deepEqual(
    calls.map(({ componentAId, componentBId, pairOrdinal }) => [componentAId, componentBId, pairOrdinal]),
    [
      [a, b, 0],
      [a, c, 1],
      [a, d, 2],
      [b, c, 3],
      [b, d, 4],
      [c, d, 5],
    ],
  );
  assert.deepEqual(
    result.autoPairRows.map(({ enabled, deleted, custom, originAuto }) => ({
      enabled,
      deleted,
      custom,
      originAuto,
    })),
    Array.from({ length: 6 }, () => ({
      enabled: true,
      deleted: false,
      custom: false,
      originAuto: true,
    })),
  );
  assert.deepEqual(result.customRows, []);
  assert.deepEqual(result.rows, result.autoPairRows);
  assert.deepEqual(result.createdRowIds, [
    mixed('generated-0'),
    mixed('generated-1'),
    mixed('generated-2'),
    mixed('generated-3'),
    mixed('generated-4'),
    mixed('generated-5'),
  ]);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.rows));
  assert.ok(result.rows.every(Object.isFrozen));
  assert.ok(calls.every(Object.isFrozen));

  const repeated = regenerateFullSpectrumAutoPairs(physicalIds, existingRows, deterministicAllocator());
  assert.deepEqual(repeated, result);
});

test('matches unordered stable physical IDs across reorder and allocates only missing pairs', () => {
  const [a, b, c] = ['a', 'b', 'c'].map(physical);
  const baseAb = row('base-ab', b, a, '41', { enabled: false });
  const baseBc = row('base-bc', b, c, '42');
  const calls: FullSpectrumAutoPairAllocationContext[] = [];

  const result = regenerateFullSpectrumAutoPairs([c, a, b], [baseAb, baseBc], deterministicAllocator(calls, 100));

  assert.deepEqual(
    result.autoPairRows.map(({ id, componentAId, componentBId, upstreamStableId, enabled }) => [
      id,
      componentAId,
      componentBId,
      upstreamStableId,
      enabled,
    ]),
    [
      [mixed('generated-0'), c, a, '100', true],
      [mixed('base-bc'), c, b, '42', true],
      [mixed('base-ab'), a, b, '41', false],
    ],
  );
  assert.deepEqual(calls, [{ componentAId: c, componentBId: a, pairOrdinal: 0 }]);
  assert.deepEqual(result.createdRowIds, [mixed('generated-0')]);
  assert.notEqual(result.autoPairRows[2], baseAb);
  assert.deepEqual(baseAb, row('base-ab', b, a, '41', { enabled: false }));
});

test('preserves base tombstones, blocks deleted edited-auto pairs, and keeps live edits', () => {
  const [a, b, c] = ['a', 'b', 'c'].map(physical);
  const baseAbTombstone = row('base-ab-tombstone', a, b, '51', {
    enabled: true,
    deleted: true,
  });
  const editedAcTombstone = row('edited-ac-tombstone', a, c, '52', {
    enabled: true,
    deleted: true,
    custom: true,
    originAuto: true,
  });
  const editedBc = row('edited-bc', b, c, '53', {
    enabled: false,
    custom: true,
    originAuto: true,
  });
  const calls: FullSpectrumAutoPairAllocationContext[] = [];

  const result = regenerateFullSpectrumAutoPairs(
    [a, b, c],
    [baseAbTombstone, editedAcTombstone, editedBc],
    deterministicAllocator(calls, 200),
  );

  assert.deepEqual(
    result.autoPairRows.map(({ id, enabled, deleted, custom, originAuto }) => [
      id,
      enabled,
      deleted,
      custom,
      originAuto,
    ]),
    [
      [mixed('base-ab-tombstone'), false, true, false, true],
      [mixed('edited-ac-tombstone'), false, true, true, true],
      [mixed('generated-2'), true, false, false, true],
    ],
  );
  assert.deepEqual(result.customRows, [editedBc]);
  assert.deepEqual(calls, [{ componentAId: b, componentBId: c, pairOrdinal: 2 }]);
  assert.deepEqual(result.createdRowIds, [mixed('generated-2')]);
  assert.deepEqual(result.tombstoneSuppressions, [
    {
      componentAId: a,
      componentBId: c,
      tombstoneId: mixed('edited-ac-tombstone'),
      resolution: 'claimed-pair-slot',
    },
  ]);
});

test('a custom-origin tombstone forces its existing base tombstone without losing either ID', () => {
  const [a, b] = ['a', 'b'].map(physical);
  const base = row('base-ab', a, b, '61');
  const editedTombstone = row('edited-ab-tombstone', b, a, '62', {
    deleted: true,
    custom: true,
    originAuto: true,
  });
  let allocatorCalled = false;

  const result = regenerateFullSpectrumAutoPairs([a, b], [base, editedTombstone], () => {
    allocatorCalled = true;
    return { id: mixed('unexpected'), upstreamStableId: '999' };
  });

  assert.equal(allocatorCalled, false);
  assert.deepEqual(result.autoPairRows, [
    {
      ...base,
      enabled: false,
      deleted: true,
    },
  ]);
  assert.deepEqual(result.customRows, [
    {
      ...editedTombstone,
      enabled: false,
    },
  ]);
  assert.deepEqual(
    result.rows.map(({ id }) => id),
    [base.id, editedTombstone.id],
  );
  assert.deepEqual(result.tombstoneSuppressions, [
    {
      componentAId: a,
      componentBId: b,
      tombstoneId: editedTombstone.id,
      resolution: 'forced-base-tombstone',
    },
  ]);
});

test('drops invalid and duplicate base rows while retaining valid custom-row order', () => {
  const [a, b, c, removed] = ['a', 'b', 'c', 'removed'].map(physical);
  const firstBase = row('first-base-ab', a, b, '71', { enabled: false });
  const duplicateBase = row('duplicate-base-ab', b, a, '72');
  const removedBase = row('removed-base', a, removed, '73');
  const customBc = row('custom-bc', b, c, '74', {
    custom: true,
    originAuto: false,
  });
  const deletedCustomAc = row('deleted-custom-ac', a, c, '75', {
    enabled: true,
    deleted: true,
    custom: true,
    originAuto: false,
  });
  const existingRows = Object.freeze([firstBase, duplicateBase, removedBase, customBc, deletedCustomAc]);
  const before = structuredClone(existingRows);
  const calls: FullSpectrumAutoPairAllocationContext[] = [];

  const result = regenerateFullSpectrumAutoPairs([a, b, c], existingRows, deterministicAllocator(calls, 300));

  assert.deepEqual(
    result.autoPairRows.map(({ id }) => id),
    [firstBase.id, mixed('generated-1'), mixed('generated-2')],
  );
  assert.deepEqual(
    result.customRows.map(({ id, enabled }) => [id, enabled]),
    [
      [customBc.id, true],
      [deletedCustomAc.id, false],
    ],
  );
  assert.deepEqual(
    calls.map(({ pairOrdinal }) => pairOrdinal),
    [1, 2],
  );
  assert.deepEqual(result.droppedRowIds, [duplicateBase.id, removedBase.id]);
  assert.deepEqual(existingRows, before);
});

test('rejects malformed libraries, identities, and allocator collisions', () => {
  const [a, b] = ['a', 'b'].map(physical);
  const base = row('base-ab', a, b, '81');

  assert.throws(
    () => regenerateFullSpectrumAutoPairs([a, a], [], deterministicAllocator()),
    FullSpectrumAutoPairProjectionError,
  );
  assert.throws(
    () =>
      regenerateFullSpectrumAutoPairs(
        Array.from({ length: 65 }, (_, index) => physical(String(index))),
        [],
        deterministicAllocator(),
      ),
    /at most 64/,
  );
  assert.throws(
    () => regenerateFullSpectrumAutoPairs([a, b], [base, base], deterministicAllocator()),
    /Duplicate mixed filament ID/,
  );
  assert.throws(
    () =>
      regenerateFullSpectrumAutoPairs([a, b], [], () => ({
        id: 'not-stable' as MixedFilamentId,
        upstreamStableId: '82',
      })),
    /allocated mixed filament ID is invalid/,
  );
  assert.throws(
    () =>
      regenerateFullSpectrumAutoPairs([a, b], [row('removed', a, physical('removed'), '83')], () => ({
        id: mixed('removed'),
        upstreamStableId: '84',
      })),
    /reused mixed filament ID/,
  );
  assert.throws(
    () =>
      regenerateFullSpectrumAutoPairs([a, b], [], () => ({
        id: mixed('overflow'),
        upstreamStableId: '18446744073709551616',
      })),
    /exceeds uint64/,
  );
});

console.log(`autoPairProjection: ${passed} tests passed`);

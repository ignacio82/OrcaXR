import assert from 'node:assert/strict';

import { entityId, type MixedFilamentId, type PhysicalFilamentId } from '../../../project/domain/ids';
import type { FullSpectrumRecipeState, MixedFilament, PhysicalFilament } from '../../../project/domain/model';
import type {
  CanonicalVirtualFilamentLibrarySnapshot,
  CanonicalVirtualFilamentMutationRequest,
} from '../../../workspace/CanonicalWorkspaceController';
import { searchSuppliedPaletteColorMatch } from '../../../project/filaments/colorMatchSearch';
import {
  CanonicalVirtualFilamentLibraryAdapter,
  projectCanonicalVirtualFilamentLibrary,
  toFullSpectrumRecipeDraft,
} from '../CanonicalVirtualFilamentLibraryAdapter';

const physicalA = entityId<'physical-filament'>('import:virtual-adapter:physical-a');
const physicalB = entityId<'physical-filament'>('import:virtual-adapter:physical-b');
const physicalC = entityId<'physical-filament'>('import:virtual-adapter:physical-c');
const physicalD = entityId<'physical-filament'>('import:virtual-adapter:physical-d');
const ratioId = entityId<'mixed-filament'>('import:virtual-adapter:ratio');
const cycleId = entityId<'mixed-filament'>('import:virtual-adapter:cycle');
const matchId = entityId<'mixed-filament'>('import:virtual-adapter:match');
const gradientId = entityId<'mixed-filament'>('import:virtual-adapter:gradient');

let passed = 0;
async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

await test('projects all four exact modes with stable IDs and saved Match candidates', () => {
  const projected = projectCanonicalVirtualFilamentLibrary(snapshot());
  assert.deepEqual(
    projected.physicalChoices.map((entry) => [entry.id, entry.toolId, entry.compatible]),
    [
      [physicalA, 1, true],
      [physicalB, 2, true],
      [physicalC, 3, true],
      [physicalD, 4, false],
    ],
  );
  assert.deepEqual(
    projected.mixedRows.map((entry) => [entry.id, entry.draft.mode]),
    [
      [ratioId, 'ratio'],
      [cycleId, 'cycle'],
      [matchId, 'match'],
      [gradientId, 'gradient'],
    ],
  );
  const cycle = projected.mixedRows[1].draft;
  assert.equal(cycle.mode, 'cycle');
  if (cycle.mode !== 'cycle') throw new Error('Expected Cycle draft');
  assert.equal(cycle.normalizedPattern, '13,2');
  assert.deepEqual(cycle.groups, [[1, 3], [2]]);
  const match = projected.mixedRows[2].draft;
  assert.equal(match.mode, 'match');
  if (match.mode !== 'match') throw new Error('Expected Match draft');
  assert.equal(match.selectedCandidateId, `persisted:${matchId}`);
  assert.equal(projected.matchCandidates[0].id, match.selectedCandidateId);
  assert.equal(projected.matchCandidates[0].previewColor, '#AA3377');
  assert.equal(Object.isFrozen(projected), true);
});

await test('maps a reordered Cycle draft back to the same stable physical sequence', () => {
  const reordered = snapshot([physicalC, physicalA, physicalB, physicalD]);
  const projected = projectCanonicalVirtualFilamentLibrary(reordered);
  const cycle = projected.mixedRows.find((entry) => entry.id === cycleId)?.draft;
  assert.equal(cycle?.mode, 'cycle');
  if (!cycle || cycle.mode !== 'cycle') throw new Error('Expected Cycle draft');
  assert.equal(cycle.normalizedPattern, '21,3');
  const domain = toFullSpectrumRecipeDraft(cycle, reordered, cycleId);
  assert.equal(domain.mode, 'cycle');
  if (domain.mode !== 'cycle') throw new Error('Expected Cycle domain draft');
  assert.deepEqual(domain.manualPatternGroups, [[physicalA, physicalC], [physicalB]]);
  assert.equal(domain.componentASurfaceOffsetMm, 0.25);
  assert.equal(domain.componentBSurfaceOffsetMm, -0.5);
});

await test('runs the pinned pigment Match search and remaps local slots to stable physical IDs', async () => {
  const current = snapshot();
  let searchCalls = 0;
  const adapter = new CanonicalVirtualFilamentLibraryAdapter({
    getSnapshot: () => current,
    subscribe: () => () => {},
    mutate: () => {},
    searchMatch: async (input) => {
      searchCalls += 1;
      return searchSuppliedPaletteColorMatch(input);
    },
    cancelMatchSearch: () => {},
  });
  const request = {
    expectedRevision: current.sourceRevision,
    sourceHash: current.sourceHash,
    targetColor: '#800080',
    minComponentPercent: 10,
  };
  const first = await adapter.searchMatchCandidates(request);
  const second = await adapter.searchMatchCandidates(request);
  assert.strictEqual(second, first, 'identical guarded searches should reuse their immutable result');
  assert.equal(searchCalls, 1);
  assert.ok(first.length >= 1 && first.length <= 2);
  assert.match(first[0].id, /^pinned-match:[0-9a-f]{16}$/);
  assert.match(first[0].label ?? '', /pinned (pair|triple) search/i);
  const eligibleIds = new Set<string>([physicalA, physicalB, physicalC]);
  assert.ok(first[0].components.every((component) => eligibleIds.has(component.filamentId)));
  assert.equal(
    first[0].components.reduce((sum, component) => sum + component.weight, 0),
    100,
  );
  assert.match(first[0].previewColor, /^#[0-9A-F]{6}$/);
  assert.equal(Object.isFrozen(first), true);
});

await test('routes guarded CRUD through one canonical mutation callback and preserves duplicate state', async () => {
  let current = snapshot();
  const calls: CanonicalVirtualFilamentMutationRequest[] = [];
  const adapter = new CanonicalVirtualFilamentLibraryAdapter({
    getSnapshot: () => current,
    subscribe: () => () => {},
    mutate: (request) => {
      calls.push(request);
    },
    searchMatch: async (input) => searchSuppliedPaletteColorMatch(input),
    cancelMatchSearch: () => {},
  });
  const projected = adapter.getSnapshot();
  const ratio = projected.mixedRows[0].draft;
  const match = projected.mixedRows[2].draft;
  await adapter.onEdit({
    expectedRevision: projected.sourceRevision,
    sourceHash: projected.sourceHash,
    filamentId: ratioId,
    draft: {
      ...ratio,
      name: 'Edited ratio',
      componentASurfaceOffsetMm: -1.75,
      componentBSurfaceOffsetMm: 1.5,
    },
  });
  await adapter.onDuplicate({
    expectedRevision: projected.sourceRevision,
    sourceHash: projected.sourceHash,
    sourceFilamentId: matchId,
    draft: { ...match, name: 'Saved Match copy' },
  });
  await adapter.onSetEnabled({
    expectedRevision: projected.sourceRevision,
    sourceHash: projected.sourceHash,
    filamentId: ratioId,
    enabled: false,
    draft: ratio,
  });
  await adapter.onDelete({
    expectedRevision: projected.sourceRevision,
    sourceHash: projected.sourceHash,
    filamentId: cycleId,
    draft: projected.mixedRows[1].draft,
  });

  assert.deepEqual(
    calls.map((entry) => entry.operation),
    ['edit', 'duplicate', 'set-enabled', 'delete'],
  );
  const edit = calls[0];
  assert.equal(edit.operation, 'edit');
  if (edit.operation !== 'edit') throw new Error('Expected edit');
  assert.equal(edit.draft.componentASurfaceOffsetMm, -1.75);
  assert.equal(edit.draft.componentBSurfaceOffsetMm, 1.5);
  const duplicate = calls[1];
  assert.equal(duplicate.operation, 'duplicate');
  if (duplicate.operation !== 'duplicate') throw new Error('Expected duplicate');
  assert.equal(duplicate.draft.enabled, false, 'disabled source state must survive duplication');

  current = { ...current, sourceRevision: current.sourceRevision + 1, sourceHash: 'hash:stale' };
  await assert.rejects(
    adapter.onDelete({
      expectedRevision: projected.sourceRevision,
      sourceHash: projected.sourceHash,
      filamentId: ratioId,
      draft: ratio,
    }),
    /no longer matches the canonical project/i,
  );
  assert.equal(calls.length, 4, 'stale requests must not reach the mutation boundary');
});

console.log(`CanonicalVirtualFilamentLibraryAdapter: ${passed} tests passed`);

function snapshot(
  order: readonly PhysicalFilamentId[] = [physicalA, physicalB, physicalC, physicalD],
): CanonicalVirtualFilamentLibrarySnapshot {
  const physical = physicalLibrary();
  const byId = new Map(physical.map((entry) => [entry.id, entry] as const));
  const mixed = mixedLibrary();
  return {
    sourceRevision: 12,
    sourceHash: 'hash:virtual-library',
    physical: order.map((id, index) => {
      const entry = byId.get(id)!;
      return {
        id,
        engineToolId: index + 1,
        name: entry.name,
        material: entry.material,
        color: entry.color,
        enabled: entry.enabled,
      };
    }),
    mixed: mixed.map((filament, index) => ({
      filament,
      dependencyPaths: index === 1 ? ['/plates/0/objects/0/filamentId'] : [],
      hasExactFullSpectrumState: true,
    })),
  };
}

function physicalLibrary(): PhysicalFilament[] {
  return [
    physical(physicalA, 0, 'Red PLA', 'PLA', '#FF0000'),
    physical(physicalB, 1, 'Blue PLA', 'PLA-CF', '#0000FF'),
    physical(physicalC, 2, 'White PLA', 'PLA', '#FFFFFF'),
    physical(physicalD, 3, 'Mystery', 'PEEK', '#12345678'),
  ];
}

function physical(
  id: PhysicalFilamentId,
  toolId: number,
  name: string,
  material: string,
  color: string,
): PhysicalFilament {
  return { id, toolId, name, material, color, config: {}, enabled: true };
}

function mixedLibrary(): MixedFilament[] {
  return [
    mixed(
      ratioId,
      'Purple ratio',
      '#8833AA',
      [
        { filamentId: physicalA, weight: 75 },
        { filamentId: physicalB, weight: 25 },
      ],
      { mode: 'ratio' },
      exact({
        uiMode: 0,
        mixBPercent: 25,
        componentASurfaceOffsetMm: 0.25,
        componentBSurfaceOffsetMm: -0.5,
      }),
    ),
    mixed(
      cycleId,
      'Cycle',
      '#5555AA',
      [
        { filamentId: physicalA, weight: 1 },
        { filamentId: physicalC, weight: 1 },
        { filamentId: physicalB, weight: 1 },
      ],
      { mode: 'cycle' },
      exact({
        uiMode: 1,
        manualPatternGroups: [[physicalA, physicalC], [physicalB]],
        componentASurfaceOffsetMm: 0.25,
        componentBSurfaceOffsetMm: -0.5,
      }),
    ),
    mixed(
      matchId,
      'Saved Match',
      '#AA3377',
      [
        { filamentId: physicalA, weight: 60 },
        { filamentId: physicalB, weight: 40 },
      ],
      { mode: 'match', targetColor: '#A03070' },
      exact({
        uiMode: 2,
        gradientComponentIds: [physicalA, physicalB],
        mixBPercent: 40,
      }),
      false,
    ),
    mixed(
      gradientId,
      'Gradient',
      '#664499',
      [
        { filamentId: physicalA, weight: 50 },
        { filamentId: physicalB, weight: 50 },
      ],
      {
        mode: 'gradient',
        startWeights: [80, 20],
        endWeights: [20, 80],
      },
      exact({
        uiMode: 3,
        gradientEnabled: true,
        localZMaxSublayers: 4,
      }),
    ),
  ];
}

function mixed(
  id: MixedFilamentId,
  name: string,
  displayColor: string,
  components: MixedFilament['components'],
  distribution: MixedFilament['distribution'],
  fullSpectrum: FullSpectrumRecipeState,
  enabled = true,
): MixedFilament {
  return { id, name, displayColor, components, distribution, fullSpectrum, config: {}, enabled };
}

function exact(overrides: Partial<FullSpectrumRecipeState>): FullSpectrumRecipeState {
  return {
    schemaVersion: 1,
    upstreamStableId: '123',
    uiMode: -1,
    componentAId: physicalA,
    componentBId: physicalB,
    ratioA: 1,
    ratioB: 1,
    mixBPercent: 50,
    manualPatternGroups: [],
    gradientComponentIds: [],
    gradientComponentWeights: [],
    pointillismAllFilaments: false,
    distributionMode: 2,
    localZMaxSublayers: 0,
    gradientEnabled: false,
    gradientStart: 0.8,
    gradientEnd: 0.2,
    componentASurfaceOffsetMm: 0,
    componentBSurfaceOffsetMm: 0,
    deleted: false,
    custom: true,
    originAuto: false,
    ...overrides,
  };
}

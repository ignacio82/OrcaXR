import assert from 'node:assert/strict';
import { InMemoryAssetRepository } from '../assets';
import { RenameProjectCommand } from '../commands';
import { canonicalStringify, cloneJson, cloneProjectState } from '../domain/canonical';
import type { FacetAnnotations } from '../domain/model';
import { findVolume } from '../domain/selectors';
import { CommandBus } from '../history/commandBus';
import { SelectionStore } from '../selection';
import { ProjectStore } from '../store';
import { createProjectFixture } from '../__tests__/fixtures';
import {
  FacetAnnotationStrokeCommand,
  captureFacetAnnotationGuard,
  commitFacetAnnotationStroke,
} from './FacetAnnotationStrokeCommand';
import {
  applyFacetChannelStroke,
  facetChannelValueAt,
  normalizeFacetAnnotations,
  normalizeTriangleRanges,
  triangleRangesFromIndices,
  validateFacetAnnotations,
} from './sparse';
import { FacetAnnotationValidationError, StaleFacetAnnotationResultError } from './types';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function harness() {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  const descriptor = cloneJson(fixture.asset.descriptor);
  descriptor.mesh!.triangleCount = 12;
  state.sourceAssets[0] = descriptor;
  const volume = state.plates[0].objects[0].volumes[0];
  volume.source.triangleCount = 12;
  volume.annotations = {
    topologyRevision: 0,
    color: [
      { value: fixture.ids.physical0, triangles: [3, 1] },
      { value: fixture.ids.mixed, triangles: [7] },
    ],
    support: [{ value: 'enforce', triangles: [2, 5] }],
    seam: [{ value: 'prefer', triangles: [4] }],
    fuzzySkin: [{ value: true, triangles: [6] }],
    brim: [{ value: true, triangles: [10] }],
  };
  const project = new ProjectStore(state);
  const selection = new SelectionStore();
  selection.set([{ kind: 'volume', id: volume.id }]);
  const assets = new InMemoryAssetRepository();
  assets.put(descriptor, fixture.asset.bytes);
  const commands = new CommandBus({ project, selection, assets });
  commands.markCheckpoint();
  return { fixture, project, selection, assets, commands, volumeId: volume.id };
}

function annotations(h: ReturnType<typeof harness>): FacetAnnotations {
  return cloneJson(findVolume(h.project.getSnapshot().state, h.volumeId)!.volume.annotations);
}

test('normalizes ranges and all five sparse channels deterministically with strict validation', () => {
  assert.deepEqual(
    normalizeTriangleRanges(
      [
        { start: 8, endExclusive: 10 },
        { start: 1, endExclusive: 4 },
        { start: 3, endExclusive: 6 },
      ],
      12,
    ),
    [
      { start: 1, endExclusive: 6 },
      { start: 8, endExclusive: 10 },
    ],
  );
  assert.deepEqual(triangleRangesFromIndices([5, 2, 3, 3, 4, 9], 12), [
    { start: 2, endExclusive: 6 },
    { start: 9, endExclusive: 10 },
  ]);

  const h = harness();
  const current = annotations(h);
  const normalized = normalizeFacetAnnotations(current, {
    topologyRevision: 0,
    triangleCount: 12,
    filamentIds: new Set([h.fixture.ids.physical0, h.fixture.ids.physical1, h.fixture.ids.mixed]),
  });
  assert.deepEqual(normalized.color.find((entry) => entry.value === h.fixture.ids.physical0)!.triangles, [1, 3]);
  assert.equal(facetChannelValueAt(normalized.support, 5), 'enforce');

  const invalid = cloneJson(current);
  invalid.support.push({ value: 'block', triangles: [2, 12] });
  const issues = validateFacetAnnotations(invalid, { topologyRevision: 0, triangleCount: 12 });
  assert.ok(issues.some((issue) => issue.code === 'duplicate-facet-assignment'));
  assert.ok(issues.some((issue) => issue.code === 'facet-index-out-of-range'));
  assert.throws(() => normalizeTriangleRanges([{ start: 4, endExclusive: 13 }], 12), FacetAnnotationValidationError);
});

test('applies paint, erase, and reset while preserving sparse deterministic values', () => {
  const h = harness();
  const current = annotations(h);
  const painted = applyFacetChannelStroke(
    current.color,
    {
      mode: 'paint',
      value: h.fixture.ids.physical1,
      ranges: [
        { start: 1, endExclusive: 4 },
        { start: 8, endExclusive: 10 },
      ],
    },
    12,
  );
  assert.deepEqual(painted.find((entry) => entry.value === h.fixture.ids.physical1)!.triangles, [1, 2, 3, 8, 9]);
  assert.deepEqual(painted.find((entry) => entry.value === h.fixture.ids.mixed)!.triangles, [7]);
  const erased = applyFacetChannelStroke(painted, { mode: 'erase', ranges: [{ start: 2, endExclusive: 9 }] }, 12);
  assert.deepEqual(erased.find((entry) => entry.value === h.fixture.ids.physical1)!.triangles, [1, 9]);
  assert.equal(
    erased.some((entry) => entry.value === h.fixture.ids.mixed),
    false,
  );
  assert.deepEqual(applyFacetChannelStroke(erased, { mode: 'reset' }, 12), []);
});

test('commits one guarded history entry and restores exact annotation bytes on undo/redo', () => {
  const h = harness();
  const before = annotations(h);
  const otherChannelsBefore = canonicalStringify({
    support: before.support,
    seam: before.seam,
    fuzzySkin: before.fuzzySkin,
    brim: before.brim,
  });
  const result = commitFacetAnnotationStroke(h.commands, {
    guard: captureFacetAnnotationGuard(h.commands, h.volumeId),
    channel: 'color',
    operation: {
      mode: 'paint',
      value: h.fixture.ids.physical1,
      ranges: [
        { start: 1, endExclusive: 4 },
        { start: 8, endExclusive: 10 },
      ],
    },
  });
  assert.equal(result.status, 'applied');
  assert.equal(h.commands.getHistorySnapshot().undoCount, 1);
  assert.equal(h.commands.getHistorySnapshot().undoLabel, 'Paint color facets');
  assert.deepEqual(h.commands.dirtyCategories(), ['projectData']);
  const after = annotations(h);
  assert.equal(
    canonicalStringify({
      support: after.support,
      seam: after.seam,
      fuzzySkin: after.fuzzySkin,
      brim: after.brim,
    }),
    otherChannelsBefore,
  );
  const beforeBytes = canonicalStringify(before);
  const afterBytes = canonicalStringify(after);
  assert.equal(h.commands.undo(), true);
  assert.equal(canonicalStringify(annotations(h)), beforeBytes);
  assert.equal(h.commands.redo(), true);
  assert.equal(canonicalStringify(annotations(h)), afterBytes);
});

test('defensively snapshots command guards and annotation payloads supplied by callers', () => {
  const h = harness();
  const guard = captureFacetAnnotationGuard(h.commands, h.volumeId);
  const before = annotations(h);
  const after = cloneJson(before);
  after.seam = [];
  const command = new FacetAnnotationStrokeCommand(guard, before, after, 'Reset seam facets');

  guard.topologyRevision = 99;
  before.seam = [];
  after.seam.push({ value: 'avoid', triangles: [11] });
  h.commands.execute(command, { coalesce: false });
  assert.deepEqual(annotations(h).seam, []);
  assert.equal(h.commands.undo(), true);
  assert.deepEqual(annotations(h).seam, [{ value: 'prefer', triangles: [4] }]);
});

test('cancellation, semantic no-op, invalid values, and stale async guards never add history', () => {
  const cancelled = harness();
  const cancelledBefore = cancelled.project.getSnapshot();
  const cancelResult = commitFacetAnnotationStroke(cancelled.commands, {
    guard: captureFacetAnnotationGuard(cancelled.commands, cancelled.volumeId),
    channel: 'support',
    operation: { mode: 'reset' },
    cancellation: { aborted: true, reason: 'brush ended' },
  });
  assert.deepEqual(cancelResult, { status: 'cancelled', reason: 'brush ended' });
  assert.deepEqual(cancelled.project.getSnapshot(), cancelledBefore);
  assert.equal(cancelled.commands.getHistorySnapshot().undoCount, 0);
  assert.equal(cancelled.commands.isDirty(), false);

  const noop = harness();
  const noopResult = commitFacetAnnotationStroke(noop.commands, {
    guard: captureFacetAnnotationGuard(noop.commands, noop.volumeId),
    channel: 'color',
    operation: {
      mode: 'paint',
      value: noop.fixture.ids.physical0,
      ranges: [{ start: 1, endExclusive: 2 }],
    },
  });
  assert.deepEqual(noopResult, { status: 'noop' });
  assert.equal(noop.commands.getHistorySnapshot().undoCount, 0);
  assert.equal(noop.commands.isDirty(), false);

  const invalidGuard = captureFacetAnnotationGuard(noop.commands, noop.volumeId);
  assert.throws(
    () =>
      commitFacetAnnotationStroke(noop.commands, {
        guard: invalidGuard,
        channel: 'color',
        operation: {
          mode: 'paint',
          value: 'import:test:missing-filament' as typeof noop.fixture.ids.physical0,
          ranges: [{ start: 2, endExclusive: 3 }],
        },
      }),
    FacetAnnotationValidationError,
  );
  assert.equal(noop.commands.getHistorySnapshot().undoCount, 0);

  const stale = harness();
  const staleGuard = captureFacetAnnotationGuard(stale.commands, stale.volumeId);
  stale.commands.execute(new RenameProjectCommand('Changed after async paint began'));
  const afterRename = stale.project.getSnapshot();
  const historyAfterRename = stale.commands.getHistorySnapshot();
  assert.throws(
    () =>
      commitFacetAnnotationStroke(stale.commands, {
        guard: staleGuard,
        channel: 'seam',
        operation: {
          mode: 'paint',
          value: 'avoid',
          ranges: [{ start: 1, endExclusive: 2 }],
        },
      }),
    StaleFacetAnnotationResultError,
  );
  assert.deepEqual(stale.project.getSnapshot(), afterRename);
  assert.deepEqual(stale.commands.getHistorySnapshot(), historyAfterRename);
});

test('validates strict persisted refinement DTOs and sparse-root consistency', () => {
  const h = harness();
  const current = annotations(h);
  current.color = [];
  current.refinement = {
    color: {
      version: 1,
      roots: Array.from({ length: 12 }, (_, triangle) =>
        triangle === 0
          ? {
              kind: 'split' as const,
              splitSides: 1 as const,
              specialSide: 0 as const,
              children: [
                { kind: 'leaf' as const, state: { kind: 'assigned' as const, value: h.fixture.ids.physical0 } },
                { kind: 'leaf' as const, state: { kind: 'assigned' as const, value: h.fixture.ids.physical1 } },
              ],
            }
          : { kind: 'leaf' as const, state: { kind: 'unpainted' as const } },
      ),
    },
  };
  assert.deepEqual(
    validateFacetAnnotations(current, {
      topologyRevision: 0,
      triangleCount: 12,
      filamentIds: new Set([h.fixture.ids.physical0, h.fixture.ids.physical1, h.fixture.ids.mixed]),
    }),
    [],
  );

  const unknownContainer = cloneJson(current) as FacetAnnotations & { refinement: Record<string, unknown> };
  unknownContainer.refinement.future = {};
  assert.ok(
    validateFacetAnnotations(unknownContainer, { topologyRevision: 0, triangleCount: 12 }).some(
      (issue) => issue.code === 'unknown-facet-refinement-channel',
    ),
  );
  const unknownNode = cloneJson(current);
  Object.assign(unknownNode.refinement!.color!.roots[0], { future: true });
  assert.ok(
    validateFacetAnnotations(unknownNode, { topologyRevision: 0, triangleCount: 12 }).some(
      (issue) => issue.code === 'invalid-facet-refinement-fields',
    ),
  );
  const empty = cloneJson(current);
  empty.refinement = {};
  assert.ok(
    validateFacetAnnotations(empty, { topologyRevision: 0, triangleCount: 12 }).some(
      (issue) => issue.code === 'empty-facet-refinements',
    ),
  );
  const homogeneous = cloneJson(current);
  homogeneous.refinement!.color = {
    version: 1,
    roots: [
      {
        kind: 'split',
        splitSides: 1,
        specialSide: 0,
        children: [
          { kind: 'leaf', state: { kind: 'assigned', value: h.fixture.ids.physical0 } },
          {
            kind: 'split',
            splitSides: 1,
            specialSide: 0,
            children: [
              { kind: 'leaf', state: { kind: 'assigned', value: h.fixture.ids.physical0 } },
              { kind: 'leaf', state: { kind: 'assigned', value: h.fixture.ids.physical0 } },
            ],
          },
        ],
      },
      ...homogeneous.refinement!.color!.roots.slice(1),
    ],
  };
  assert.ok(
    validateFacetAnnotations(homogeneous, { topologyRevision: 0, triangleCount: 12 }).some(
      (issue) => issue.code === 'noncanonical-facet-refinement',
    ),
  );
});

test('whole-root strokes replace stored splits and omit refinement after collapse', () => {
  const h = harness();
  const state = cloneProjectState(h.project.getSnapshot().state);
  const volume = findVolume(state, h.volumeId)!.volume;
  volume.annotations.color = [];
  volume.annotations.refinement = {
    color: {
      version: 1,
      roots: Array.from({ length: 12 }, (_, triangle) =>
        triangle === 0
          ? {
              kind: 'split' as const,
              splitSides: 1 as const,
              specialSide: 0 as const,
              children: [
                { kind: 'leaf' as const, state: { kind: 'assigned' as const, value: h.fixture.ids.physical0 } },
                { kind: 'leaf' as const, state: { kind: 'assigned' as const, value: h.fixture.ids.physical1 } },
              ],
            }
          : { kind: 'leaf' as const, state: { kind: 'unpainted' as const } },
      ),
    },
  };
  h.project.replaceState(state, { reason: 'test-setup', dirtyCategories: [] });
  h.commands.markCheckpoint();
  const before = canonicalStringify(annotations(h));
  const result = commitFacetAnnotationStroke(h.commands, {
    guard: captureFacetAnnotationGuard(h.commands, h.volumeId),
    channel: 'color',
    operation: { mode: 'paint', value: h.fixture.ids.physical1, ranges: [{ start: 0, endExclusive: 1 }] },
  });
  assert.equal(result.status, 'applied');
  assert.deepEqual(annotations(h).color, [{ value: h.fixture.ids.physical1, triangles: [0] }]);
  assert.equal(annotations(h).refinement, undefined);
  assert.equal(h.commands.undo(), true);
  assert.equal(canonicalStringify(annotations(h)), before);
});

console.log(`\nCanonical facet annotations: ${passed} tests passed.`);

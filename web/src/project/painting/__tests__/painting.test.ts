import assert from 'node:assert/strict';

import { InMemoryAssetRepository } from '../../assets';
import { entityId, seededRandom, UuidIdSource } from '../../domain/ids';
import {
  createEmptyProject,
  emptyFacetAnnotations,
  identityTransform,
  type MixedFilament,
  type PhysicalFilament,
  type ProjectState,
} from '../../domain/model';
import { CommandBus } from '../../history/commandBus';
import { encodeIndexedMeshAsset } from '../../meshCodec';
import { SelectionStore } from '../../selection';
import { ProjectStore } from '../../store';
import { paintPaletteColors, paintPaletteEntryFor, projectPaintPalette } from '../paintPalette';
import { Bbs3mfProjectSerializer } from '../../serialization/Bbs3mfProjectSerializer';
import { PaintStrokeService, PaintTargetError, paintStateOrder } from '../PaintStrokeService';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const TOOL_ONE = entityId<'physical-filament'>('import:test:tool-1');
const TOOL_TWO = entityId<'physical-filament'>('import:test:tool-2');
const RATIO = entityId<'mixed-filament'>('import:test:ratio');
const DISABLED = entityId<'mixed-filament'>('import:test:disabled');
const ORPHAN = entityId<'mixed-filament'>('import:test:orphan');
const MISSING_TOOL = entityId<'physical-filament'>('import:test:tool-9');

function physical(id: typeof TOOL_ONE, toolId: number, color: string, name: string): PhysicalFilament {
  return { id, name, toolId, material: 'PLA', color, config: {}, enabled: true };
}

function ratioRecipe(id: typeof RATIO, name: string, enabled: boolean): MixedFilament {
  return {
    id,
    name,
    displayColor: '#7f3f7f',
    components: [
      { filamentId: TOOL_ONE, weight: 60 },
      { filamentId: TOOL_TWO, weight: 40 },
    ],
    distribution: { mode: 'ratio' },
    config: {},
    enabled,
  };
}

/** Two coplanar triangles forming a 10 mm square in the XY plane. */
function squareMeshAsset(id = entityId<'asset'>('import:test:square')) {
  return encodeIndexedMeshAsset({
    id,
    positions: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0],
    indices: [0, 1, 2, 0, 2, 3],
    sourceFilename: 'square.stl',
  });
}

function createHarness(options: { withMixed?: boolean } = {}) {
  const ids = new UuidIdSource(seededRandom(0x9a17));
  const state: ProjectState = createEmptyProject({ idSource: ids, now: '2026-08-07T00:00:00.000Z', toolCount: 2 });
  const asset = squareMeshAsset();
  const objectId = ids.next('object');
  const volumeId = ids.next('volume');
  const instanceId = ids.next('instance');
  state.sourceAssets.push(asset.descriptor);
  state.filaments.physical.push(physical(TOOL_ONE, 0, '#ff0000', 'Red'), physical(TOOL_TWO, 1, '#0000ff', 'Blue'));
  if (options.withMixed) {
    state.filaments.mixed.push(ratioRecipe(RATIO, 'Plum blend', true), ratioRecipe(DISABLED, 'Retired blend', false));
  }
  state.plates[0].objects.push({
    id: objectId,
    name: 'Square',
    config: {},
    volumes: [
      {
        id: volumeId,
        name: 'Body',
        role: 'model',
        source: { assetId: asset.descriptor.id, topologyRevision: 0, triangleCount: 2 },
        transform: identityTransform(),
        config: {},
        annotations: emptyFacetAnnotations(),
      },
    ],
    instances: [{ id: instanceId, transform: identityTransform(), printable: true }],
    layerRanges: [],
  });

  const project = new ProjectStore(state);
  const selection = new SelectionStore();
  const assets = new InMemoryAssetRepository();
  assets.put(asset.descriptor, asset.bytes);
  const commands = new CommandBus({ project, selection, assets });
  commands.markCheckpoint();
  const service = new PaintStrokeService({ commands, assets });
  return { ids, project, assets, commands, service, volumeId, objectId };
}

function colorFacets(harness: ReturnType<typeof createHarness>) {
  return harness.project.getSnapshot().state.plates[0].objects[0].volumes[0].annotations.color;
}

const TRIANGLE_HIT = {
  triangleIndex: 0,
  localPoint: [2, 2, 0] as const,
  localCameraPosition: [2, 2, 40] as const,
};

test('projects physical tools, enabled recipes, and the inherit entry with stable IDs', () => {
  const harness = createHarness({ withMixed: true });
  const palette = projectPaintPalette(harness.project.getSnapshot().state);

  assert.deepEqual(
    palette.entries.map((entry) => entry.kind),
    ['default', 'physical', 'physical', 'mixed'],
    'disabled and orphaned recipes are omitted unless explicitly requested',
  );
  assert.equal(palette.physicalCount, 2);
  assert.equal(palette.enabledMixedCount, 1, 'the disabled recipe is not an enabled engine row');
  const [, red, blue, plum] = palette.entries;
  assert.equal(red.filamentId, TOOL_ONE);
  assert.equal(red.badge, 'T0');
  assert.equal(red.engineSlot, 1);
  assert.equal(blue.engineSlot, 2);
  assert.equal(plum.filamentId, RATIO);
  assert.equal(plum.badge, 'Ratio');
  assert.equal(plum.recipeSummary, '60% T0 / 40% T1');
  assert.equal(plum.engineSlot, 3, 'enabled recipes follow the physical rows in engine numbering');
  assert.deepEqual(
    palette.entries.map((entry) => entry.keyboardNumber),
    [undefined, 1, 2, 3],
  );
  assert.equal(paintPaletteEntryFor(palette, RATIO)?.name, 'Plum blend');
  assert.equal(paintPaletteEntryFor(palette)?.kind, 'default');
  assert.equal(paintPaletteColors(palette).get(TOOL_TWO), '#0000ff');
});

test('explains why a disabled or orphaned recipe cannot be painted', () => {
  const harness = createHarness({ withMixed: true });
  const state = harness.project.getSnapshot().state;
  const palette = projectPaintPalette(state, { includeUnavailable: true });
  const disabled = palette.entries.find((entry) => entry.filamentId === DISABLED);
  assert.equal(disabled?.selectable, false);
  assert.match(disabled?.unavailableReason ?? '', /disabled/i);
  assert.equal(disabled?.engineSlot, undefined, 'a disabled recipe occupies no engine slot');
  assert.deepEqual(paintStateOrder(state), [TOOL_ONE, TOOL_TWO, RATIO]);

  // A recovery/migration payload can still reference a removed head; the
  // palette must explain that instead of offering an unpaintable swatch.
  const damaged: ProjectState = structuredClone(state);
  damaged.filaments.mixed.push({
    ...ratioRecipe(ORPHAN, 'Broken blend', true),
    components: [
      { filamentId: MISSING_TOOL, weight: 50 },
      { filamentId: TOOL_TWO, weight: 50 },
    ],
  });
  const orphan = projectPaintPalette(damaged, { includeUnavailable: true }).entries.find(
    (entry) => entry.filamentId === ORPHAN,
  );
  assert.equal(orphan?.selectable, false);
  assert.match(orphan?.unavailableReason ?? '', /no longer has/i);
});

test('commits one undoable stroke that stores the stable filament identity', () => {
  const harness = createHarness({ withMixed: true });
  const before = harness.project.getSnapshot().revision;
  const preview = harness.service.previewStroke({
    hit: { volumeId: harness.volumeId, ...TRIANGLE_HIT },
    settings: { tool: 'triangle' },
    filamentId: TOOL_TWO,
    mode: 'paint',
  });
  assert.deepEqual(preview.triangleIndices, [0]);
  assert.equal(harness.project.getSnapshot().revision, before, 'preview never mutates the project');

  const result = harness.service.commitStroke({
    hit: { volumeId: harness.volumeId, ...TRIANGLE_HIT },
    settings: { tool: 'triangle' },
    filamentId: TOOL_TWO,
    mode: 'paint',
  });
  assert.equal(result.status, 'applied');
  assert.deepEqual(colorFacets(harness), [{ value: TOOL_TWO, triangles: [0] }]);

  harness.commands.undo();
  assert.deepEqual(colorFacets(harness), []);
  harness.commands.redo();
  assert.equal(colorFacets(harness)[0].value, TOOL_TWO);
});

test('paints a virtual recipe without flattening it to a physical slot or colour', () => {
  const harness = createHarness({ withMixed: true });
  harness.service.commitStroke({
    hit: { volumeId: harness.volumeId, ...TRIANGLE_HIT },
    settings: { tool: 'fill', smartFillAngleDegrees: 30 },
    filamentId: RATIO,
    mode: 'paint',
  });
  const facets = colorFacets(harness);
  assert.equal(facets.length, 1);
  assert.equal(facets[0].value, RATIO, 'the stored value is the recipe ID, not a slot or RGB value');
  assert.deepEqual(facets[0].triangles, [0, 1], 'smart fill crosses the coplanar edge');
});

test('erases back to inherit and clears a whole volume', () => {
  const harness = createHarness();
  harness.service.commitStroke({
    hit: { volumeId: harness.volumeId, ...TRIANGLE_HIT },
    settings: { tool: 'fill', smartFillAngleDegrees: 30 },
    filamentId: TOOL_ONE,
    mode: 'paint',
  });
  assert.equal(colorFacets(harness).length, 1);

  harness.service.commitStroke({
    hit: { volumeId: harness.volumeId, ...TRIANGLE_HIT },
    settings: { tool: 'triangle' },
    mode: 'erase',
  });
  assert.deepEqual(colorFacets(harness)[0].triangles, [1]);

  const cleared = harness.service.clearVolume(harness.volumeId);
  assert.equal(cleared.status, 'applied');
  assert.deepEqual(colorFacets(harness), []);
  assert.equal(harness.service.clearVolume(harness.volumeId).status, 'noop');
});

test('brush strokes select a sweep and repeated identical samples are no-ops', () => {
  const harness = createHarness();
  const sphere = harness.service.commitStroke({
    hit: {
      volumeId: harness.volumeId,
      triangleIndex: 0,
      localPoint: [5, 5, 0],
      localCameraPosition: [5, 5, 40],
      previousLocalPoint: [1, 1, 0],
    },
    settings: { tool: 'sphere', radiusMm: 6 },
    filamentId: TOOL_ONE,
    mode: 'paint',
  });
  assert.equal(sphere.status, 'applied');
  assert.deepEqual(colorFacets(harness)[0].triangles, [0, 1]);

  const again = harness.service.commitStroke({
    hit: {
      volumeId: harness.volumeId,
      triangleIndex: 0,
      localPoint: [5, 5, 0],
      localCameraPosition: [5, 5, 40],
      previousLocalPoint: [1, 1, 0],
    },
    settings: { tool: 'sphere', radiusMm: 6 },
    filamentId: TOOL_ONE,
    mode: 'paint',
  });
  assert.equal(again.status, 'noop', 'an unchanged stroke never grows history');
});

test('rejects unpaintable targets, filaments, and incomplete tool input', () => {
  const harness = createHarness({ withMixed: true });
  assert.throws(
    () =>
      harness.service.commitStroke({
        hit: { volumeId: entityId<'volume'>('import:test:missing'), ...TRIANGLE_HIT },
        settings: { tool: 'triangle' },
        filamentId: TOOL_ONE,
        mode: 'paint',
      }),
    (error: unknown) => error instanceof PaintTargetError && error.code === 'unknown-volume',
  );
  assert.throws(
    () =>
      harness.service.commitStroke({
        hit: { volumeId: harness.volumeId, ...TRIANGLE_HIT },
        settings: { tool: 'triangle' },
        filamentId: DISABLED,
        mode: 'paint',
      }),
    (error: unknown) => error instanceof PaintTargetError && error.code === 'unavailable-filament',
  );
  assert.throws(
    () =>
      harness.service.commitStroke({
        hit: { volumeId: harness.volumeId, ...TRIANGLE_HIT },
        settings: { tool: 'heightRange', heightRangeMm: 2 },
        filamentId: TOOL_ONE,
        mode: 'paint',
      }),
    (error: unknown) => error instanceof PaintTargetError && error.code === 'invalid-hit',
  );
  assert.equal(colorFacets(harness).length, 0, 'no rejected request mutated canonical state');
});

test('refuses to paint a modifier volume', () => {
  const harness = createHarness();
  const state = harness.project.getSnapshot().state;
  const next = structuredClone(state);
  const modifierId = harness.ids.next('volume');
  const model = next.plates[0].objects[0].volumes[0];
  next.plates[0].objects[0].volumes.push({
    ...structuredClone(model),
    id: modifierId,
    name: 'Modifier',
    role: 'parameter-modifier',
  });
  harness.project.replaceState(next, { reason: 'add modifier', dirtyCategories: ['projectData'] });
  assert.throws(
    () =>
      harness.service.commitStroke({
        hit: { volumeId: modifierId, ...TRIANGLE_HIT },
        settings: { tool: 'triangle' },
        filamentId: TOOL_ONE,
        mode: 'paint',
      }),
    (error: unknown) => error instanceof PaintTargetError && error.code === 'unsupported-role',
  );
});

test('a cancelled stroke commits nothing', () => {
  const harness = createHarness();
  const result = harness.service.commitStroke({
    hit: { volumeId: harness.volumeId, ...TRIANGLE_HIT },
    settings: { tool: 'triangle' },
    filamentId: TOOL_ONE,
    mode: 'paint',
    cancellation: { aborted: true, reason: 'pointer cancelled' },
  });
  assert.deepEqual(result, { status: 'cancelled', reason: 'pointer cancelled' });
  assert.equal(colorFacets(harness).length, 0);
});

await (async () => {
  // Painted identity must survive the canonical serializer, not only memory.
  const harness = createHarness({ withMixed: true });
  harness.service.commitStroke({
    hit: { volumeId: harness.volumeId, ...TRIANGLE_HIT },
    settings: { tool: 'fill', smartFillAngleDegrees: 30 },
    filamentId: RATIO,
    mode: 'paint',
  });
  const serializer = new Bbs3mfProjectSerializer();
  const snapshot = harness.project.getSnapshot();
  const saved = await serializer.serialize({
    state: snapshot.state,
    assets: harness.assets.list(),
    sourceRevision: snapshot.revision,
    sourceHash: snapshot.hash,
  });
  const reopened = await serializer.deserialize(saved.bytes);
  const facets = reopened.state.plates[0].objects[0].volumes[0].annotations.color;
  assert.equal(facets.length, 1);
  assert.equal(facets[0].value, RATIO, 'a saved recipe facet reopens with the same stable recipe ID');
  assert.deepEqual(facets[0].triangles, [0, 1]);
  passed += 1;
  console.log('  ✓ painted recipe identity survives canonical save and reopen');
})();

console.log(`\nCanonical painting: ${passed} tests passed.`);

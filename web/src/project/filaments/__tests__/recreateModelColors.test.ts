import assert from 'node:assert/strict';
import {
  EditorSession,
  InMemoryAssetRepository,
  UuidIdSource,
  canonicalStringify,
  cloneProjectState,
  emptyFacetAnnotations,
  seededRandom,
  type ProjectState,
} from '../..';
import { createProjectFixture } from '../../__tests__/fixtures';
import { extractModelColorUsages, planRecreateModelColors, executeRecreateModelColors } from '../recreateModelColors';
import { SyncPhysicalFilamentsFromPrinterCommand } from '../commands';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const dummySerializer = {
  serialize: async () => ({
    bytes: new Uint8Array(),
    mediaType: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
    suggestedFilename: 'fixture.3mf',
    sourceRevision: 0,
    sourceHash: '',
  }),
  deserialize: async () => ({ state: {} as any, assets: [], warnings: [] }),
};

function harness(state?: ProjectState) {
  const fixture = createProjectFixture();
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  const ids = new UuidIdSource(seededRandom(0x4010));
  const session = new EditorSession({
    initialState: state ?? cloneProjectState(fixture.state),
    assets,
    serializer: dummySerializer,
  });
  return { fixture, assets, session, ids };
}

test('extracts distinct colors from object assignments, volume materials, and facet paint', () => {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  const ids = new UuidIdSource(seededRandom(0x4011));
  state.plates[0].objects[0].volumes[0].annotations = emptyFacetAnnotations(0);
  delete state.plates[0].objects[0].filamentId;
  delete state.plates[0].objects[0].volumes[0].filamentId;

  // Add sourceMaterial to volume
  state.plates[0].objects[0].volumes[0].extensionData = {
    'orcaxr:sourceMaterial': {
      color: '#FF5500',
      name: 'Orange PLA',
    },
  };

  const facetId = ids.next('physical-filament');
  state.filaments.physical = [
    {
      id: facetId,
      toolId: 0,
      name: 'Sky Blue PLA',
      color: '#00AAFF',
      material: 'PLA',
      config: {},
      enabled: true,
    },
  ];

  // Add facet annotations
  state.plates[0].objects[0].volumes[0].annotations.color = [{ value: facetId, triangles: [0] }];

  const usages = extractModelColorUsages(state);
  const colors = usages.map((u) => u.color);

  assert.ok(colors.includes('#FF5500'), 'Should extract sourceMaterial color #FF5500');
  assert.ok(colors.includes('#00AAFF'), 'Should extract facet paint color #00AAFF');
  assert.equal(usages.length, 2, 'Should have exactly 2 distinct color usages');
});

test('plans exact physical matches when model colors match loaded filaments', () => {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  state.plates[0].objects[0].volumes[0].annotations = emptyFacetAnnotations(0);
  delete state.plates[0].objects[0].filamentId;
  delete state.plates[0].objects[0].volumes[0].filamentId;
  state.filaments.mixed = [];

  const ids = new UuidIdSource(seededRandom(0x501));
  const idRed = ids.next('physical-filament');
  const idBlue = ids.next('physical-filament');

  // Configure physical filaments
  state.filaments.physical = [
    {
      id: idRed,
      toolId: 0,
      name: 'Snapmaker Red',
      color: '#FF0000',
      material: 'PLA',
      config: {},
      enabled: true,
    },
    {
      id: idBlue,
      toolId: 1,
      name: 'Snapmaker Blue',
      color: '#0000FF',
      material: 'PLA',
      config: {},
      enabled: true,
    },
  ];

  state.plates[0].objects[0].volumes[0].extensionData = {
    'orcaxr:sourceMaterial': { color: '#FF0000', name: 'Red Part' },
  };

  const plan = planRecreateModelColors(state);
  assert.equal(plan.matches.length, 1);
  assert.equal(plan.matches[0].source.color, '#FF0000');
  assert.equal(plan.matches[0].destination.kind, 'physical');
  assert.equal(plan.matches[0].destination.filamentId, idRed);
  assert.equal(plan.matches[0].destination.deltaE2000, 0);
});

test('synthesizes Full-Spectrum dithering recipe when physical filaments need blending', () => {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  state.plates[0].objects[0].volumes[0].annotations = emptyFacetAnnotations(0);
  delete state.plates[0].objects[0].filamentId;
  delete state.plates[0].objects[0].volumes[0].filamentId;
  state.filaments.mixed = [];

  const ids = new UuidIdSource(seededRandom(0x502));

  // 4 compatible physical filaments (CMYK / RGBW style)
  state.filaments.physical = [
    {
      id: ids.next('physical-filament'),
      toolId: 0,
      name: 'Red PLA',
      color: '#FF0000',
      material: 'PLA',
      config: {},
      enabled: true,
    },
    {
      id: ids.next('physical-filament'),
      toolId: 1,
      name: 'Yellow PLA',
      color: '#FFFF00',
      material: 'PLA',
      config: {},
      enabled: true,
    },
    {
      id: ids.next('physical-filament'),
      toolId: 2,
      name: 'White PLA',
      color: '#FFFFFF',
      material: 'PLA',
      config: {},
      enabled: true,
    },
    {
      id: ids.next('physical-filament'),
      toolId: 3,
      name: 'Black PLA',
      color: '#000000',
      material: 'PLA',
      config: {},
      enabled: true,
    },
  ];

  // Target color is Orange (#FF8000), which can be made by blending Red and Yellow
  state.plates[0].objects[0].volumes[0].extensionData = {
    'orcaxr:sourceMaterial': { color: '#FF8000', name: 'Orange Cover' },
  };

  const plan = planRecreateModelColors(state, { allowNewFullSpectrumRecipes: true });
  assert.equal(plan.matches.length, 1);
  const match = plan.matches[0];
  assert.equal(match.source.color, '#FF8000');
  assert.equal(match.destination.kind, 'new-mixed');
  assert.ok(match.destination.newRecipeDraft, 'Should provide new recipe draft');
  assert.ok(match.destination.deltaE2000 < 5.0, 'Blend should achieve close deltaE');
});

test('executes plan atomically, creates mixed filament, and remaps volumes and annotations', () => {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  state.plates[0].objects[0].volumes[0].annotations = emptyFacetAnnotations(0);
  delete state.plates[0].objects[0].filamentId;
  delete state.plates[0].objects[0].volumes[0].filamentId;
  state.filaments.mixed = [];

  const ids = new UuidIdSource(seededRandom(0x503));

  state.filaments.physical = [
    {
      id: ids.next('physical-filament'),
      toolId: 0,
      name: 'Red PLA',
      color: '#FF0000',
      material: 'PLA',
      config: {},
      enabled: true,
    },
    {
      id: ids.next('physical-filament'),
      toolId: 1,
      name: 'Yellow PLA',
      color: '#FFFF00',
      material: 'PLA',
      config: {},
      enabled: true,
    },
  ];

  state.plates[0].objects[0].volumes[0].extensionData = {
    'orcaxr:sourceMaterial': { color: '#FF8000', name: 'Orange Part' },
  };

  const { session } = harness(state);
  const plan = planRecreateModelColors(session.project.getSnapshot().state);
  const beforeStateStr = canonicalStringify(session.project.getSnapshot().state);

  const applied = executeRecreateModelColors(session, plan, ids);
  assert.equal(applied, true);

  const afterState = session.project.getSnapshot().state;
  assert.equal(afterState.filaments.mixed.length, 1, 'Should have added mixed filament');
  const createdMixed = afterState.filaments.mixed.find((m) => m.name.includes('FF8000'));
  assert.ok(createdMixed, 'Created mixed filament should exist');
  assert.equal(afterState.plates[0].objects[0].volumes[0].filamentId, createdMixed.id);

  // Test Undo
  session.commands.undo();
  assert.equal(
    canonicalStringify(session.project.getSnapshot().state),
    beforeStateStr,
    'Undo should restore exact state',
  );

  // Test Redo
  session.commands.redo();
  const redoneState = session.project.getSnapshot().state;
  assert.equal(redoneState.filaments.mixed.length, 1);
  assert.equal(redoneState.plates[0].objects[0].volumes[0].filamentId, createdMixed.id);
});

test('respects user overrides when applying plan', () => {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  state.plates[0].objects[0].volumes[0].annotations = emptyFacetAnnotations(0);
  delete state.plates[0].objects[0].filamentId;
  delete state.plates[0].objects[0].volumes[0].filamentId;
  state.filaments.mixed = [];

  const ids = new UuidIdSource(seededRandom(0x504));
  const idRed = ids.next('physical-filament');
  const idBlue = ids.next('physical-filament');

  state.filaments.physical = [
    {
      id: idRed,
      toolId: 0,
      name: 'Red PLA',
      color: '#FF0000',
      material: 'PLA',
      config: {},
      enabled: true,
    },
    {
      id: idBlue,
      toolId: 1,
      name: 'Blue PLA',
      color: '#0000FF',
      material: 'PLA',
      config: {},
      enabled: true,
    },
  ];

  state.plates[0].objects[0].volumes[0].extensionData = {
    'orcaxr:sourceMaterial': { color: '#FF0000', name: 'Red Part' },
  };

  const { session } = harness(state);
  const plan = planRecreateModelColors(session.project.getSnapshot().state);
  // User overrides the red part to blue
  const overrides = new Map([['#FF0000', idBlue]]);

  const applied = executeRecreateModelColors(session, plan, ids, overrides);
  assert.equal(applied, true);

  const afterState = session.project.getSnapshot().state;
  assert.equal(afterState.plates[0].objects[0].volumes[0].filamentId, idBlue);
});

test('recreates model colors using candidate printer slots and adopts printer filaments in one undoable step', () => {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  state.plates[0].objects[0].volumes[0].annotations = emptyFacetAnnotations(0);
  delete state.plates[0].objects[0].filamentId;
  delete state.plates[0].objects[0].volumes[0].filamentId;
  state.filaments.mixed = [];

  const ids = new UuidIdSource(seededRandom(0x601));

  // Initial project state has 1 generic tool (e.g. from single-color default or model file)
  state.filaments.physical = [
    {
      id: ids.next('physical-filament'),
      toolId: 0,
      name: 'Default Gray',
      color: '#808080',
      material: 'PLA',
      config: {},
      enabled: true,
    },
  ];

  // Model has an orange volume (#FF8000)
  state.plates[0].objects[0].volumes[0].extensionData = {
    'orcaxr:sourceMaterial': { color: '#FF8000', name: 'Orange Model Part' },
  };

  const { session } = harness(state);

  // Printer has 4 slots loaded (e.g. Snapmaker U1 loaded with Red, Yellow, White, Black)
  const printerSlots = [
    { toolId: 0, color: '#FF0000', material: 'PLA', subType: 'Matte', vendor: 'Snapmaker' },
    { toolId: 1, color: '#FFFF00', material: 'PLA', subType: 'Matte', vendor: 'Snapmaker' },
    { toolId: 2, color: '#FFFFFF', material: 'PLA', subType: 'SnapSpeed', vendor: 'Snapmaker' },
    { toolId: 3, color: '#000000', material: 'PLA', subType: 'Matte', vendor: 'Snapmaker' },
  ];

  const plan = planRecreateModelColors(session.project.getSnapshot().state, {
    printerSlots,
    allowNewFullSpectrumRecipes: true,
  });

  assert.equal(plan.matches.length, 1);
  assert.equal(plan.matches[0].source.color, '#FF8000');
  assert.equal(plan.matches[0].destination.kind, 'new-mixed');
  assert.ok(plan.matches[0].destination.newRecipeDraft);
  assert.ok(plan.printerSlotsToAdopt);
  assert.equal(plan.printerSlotsToAdopt.length, 4);

  const beforeStr = canonicalStringify(session.project.getSnapshot().state);
  const applied = executeRecreateModelColors(session, plan, ids);
  assert.equal(applied, true);

  const afterState = session.project.getSnapshot().state;
  // Physical filaments adopted all 4 printer slots
  assert.equal(afterState.filaments.physical.length, 4);
  assert.equal(afterState.filaments.physical[0].color, '#FF0000');
  assert.equal(afterState.filaments.physical[1].color, '#FFFF00');
  assert.equal(afterState.filaments.physical[2].color, '#FFFFFF');
  assert.equal(afterState.filaments.physical[3].color, '#000000');

  // Synthesized mixed filament exists and is assigned to the volume
  assert.equal(afterState.filaments.mixed.length, 1);
  const mixed = afterState.filaments.mixed[0];
  assert.equal(afterState.plates[0].objects[0].volumes[0].filamentId, mixed.id);

  // Undo restores initial state completely
  session.commands.undo();
  assert.equal(canonicalStringify(session.project.getSnapshot().state), beforeStr);
});

test('preserves model colors after syncing filaments from printer and recreates original colors via Full-Spectrum', () => {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  state.plates[0].objects[0].volumes[0].annotations = emptyFacetAnnotations(0);
  delete state.plates[0].objects[0].filamentId;
  delete state.plates[0].objects[0].volumes[0].filamentId;
  state.filaments.mixed = [];

  const ids = new UuidIdSource(seededRandom(0x602));
  const idOriginalRed = ids.next('physical-filament');
  const idOriginalGreen = ids.next('physical-filament');

  // Imported 3MF or model has 2 tools: Red and Green
  state.filaments.physical = [
    {
      id: idOriginalRed,
      toolId: 0,
      name: 'Model Red',
      color: '#FF0000',
      material: 'PLA',
      config: {},
      enabled: true,
    },
    {
      id: idOriginalGreen,
      toolId: 1,
      name: 'Model Green',
      color: '#00FF00',
      material: 'PLA',
      config: {},
      enabled: true,
    },
  ];

  // Volume 0 is assigned to Model Red
  state.plates[0].objects[0].volumes[0].filamentId = idOriginalRed;

  const { session } = harness(state);

  // 1. User syncs filaments from printer (printer has White, Black, Yellow, Blue)
  const printerSlots = [
    { toolId: 0, color: '#FFFFFF', material: 'PLA', subType: 'Matte', vendor: 'Snapmaker' },
    { toolId: 1, color: '#000000', material: 'PLA', subType: 'Matte', vendor: 'Snapmaker' },
    { toolId: 2, color: '#FFFF00', material: 'PLA', subType: 'Matte', vendor: 'Snapmaker' },
    { toolId: 3, color: '#0000FF', material: 'PLA', subType: 'Matte', vendor: 'Snapmaker' },
  ];

  session.commands.execute(new SyncPhysicalFilamentsFromPrinterCommand(printerSlots, ids));

  // The volume should preserve its original sourceMaterial color #FF0000
  const syncedState = session.project.getSnapshot().state;
  const volExt = syncedState.plates[0].objects[0].volumes[0].extensionData?.['orcaxr:sourceMaterial'] as
    { color: string } | undefined;
  assert.equal(volExt?.color, '#FF0000', 'Original model color should be preserved in sourceMaterial');

  // 2. User invokes Recreate Model Colors
  const plan = planRecreateModelColors(syncedState, { allowNewFullSpectrumRecipes: true });
  assert.equal(plan.matches.length, 1);
  assert.equal(plan.matches[0].source.color, '#FF0000');

  const applied = executeRecreateModelColors(session, plan, ids);
  assert.equal(applied, true);

  const recreatedState = session.project.getSnapshot().state;
  assert.ok(recreatedState.plates[0].objects[0].volumes[0].filamentId);
  assert.notEqual(recreatedState.plates[0].objects[0].volumes[0].filamentId, idOriginalRed);
});

test('preserves and remaps painted facet annotations when syncing filaments and recreating model colors', () => {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  delete state.plates[0].objects[0].filamentId;
  delete state.plates[0].objects[0].volumes[0].filamentId;
  state.filaments.mixed = [];

  const ids = new UuidIdSource(seededRandom(0x603));
  const idRed = ids.next('physical-filament');
  const idGreen = ids.next('physical-filament');

  state.filaments.physical = [
    {
      id: idRed,
      toolId: 0,
      name: 'Model Red',
      color: '#FF0000',
      material: 'PLA',
      config: {},
      enabled: true,
    },
    {
      id: idGreen,
      toolId: 1,
      name: 'Model Green',
      color: '#00FF00',
      material: 'PLA',
      config: {},
      enabled: true,
    },
  ];

  // Set facet annotations on volume
  state.plates[0].objects[0].volumes[0].filamentId = idGreen;
  state.plates[0].objects[0].volumes[0].annotations = {
    ...emptyFacetAnnotations(0),
    color: [{ value: idRed, triangles: [0] }],
  };

  const { session } = harness(state);

  // Sync printer slots
  const printerSlots = [
    { toolId: 0, color: '#FFFFFF', material: 'PLA', vendor: 'Snapmaker' },
    { toolId: 1, color: '#000000', material: 'PLA', vendor: 'Snapmaker' },
    { toolId: 2, color: '#FFFF00', material: 'PLA', vendor: 'Snapmaker' },
    { toolId: 3, color: '#0000FF', material: 'PLA', vendor: 'Snapmaker' },
  ];
  session.commands.execute(new SyncPhysicalFilamentsFromPrinterCommand(printerSlots, ids));

  // Recreate model colors
  const plan = planRecreateModelColors(session.project.getSnapshot().state, { allowNewFullSpectrumRecipes: true });
  assert.equal(plan.matches.length, 2, 'Should extract both original volume and facet colors (#00FF00 and #FF0000)');

  const applied = executeRecreateModelColors(session, plan, ids);
  assert.equal(applied, true);

  const afterState = session.project.getSnapshot().state;
  const colorAnnotations = afterState.plates[0].objects[0].volumes[0].annotations.color!;
  assert.equal(colorAnnotations.length, 1);
  // Values should be remapped to the matched destinations
  assert.notEqual(colorAnnotations[0].value, idRed);
  assert.notEqual(afterState.plates[0].objects[0].volumes[0].filamentId, idGreen);
});

console.log(`Recreate model colors tests: ${passed} tests passed.`);

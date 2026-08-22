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

test('handles empty scene and returns false without modifying revision', () => {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  state.plates[0].objects = []; // no objects

  const { session, ids } = harness(state);
  const plan = planRecreateModelColors(session.project.getSnapshot().state);
  assert.equal(plan.matches.length, 0);

  const revBefore = session.project.getSnapshot().revision;
  const applied = executeRecreateModelColors(session, plan, ids);
  assert.equal(applied, false);
  assert.equal(session.project.getSnapshot().revision, revBefore);
});

console.log(`Recreate model colors tests: ${passed} tests passed.`);

import assert from 'node:assert/strict';

import { InMemoryAssetRepository } from '../assets';
import { cloneProjectState } from '../domain/canonical';
import { seededRandom, UuidIdSource } from '../domain/ids';
import {
  createEmptyProject,
  emptyFacetAnnotations,
  identityTransform,
  type PhysicalFilament,
  type ProjectState,
} from '../domain/model';
import { resolveFilament } from '../domain/selectors';
import { CommandBus } from '../history/commandBus';
import { encodeIndexedMeshAsset } from '../meshCodec';
import { SelectionStore } from '../selection';
import { ProjectStore } from '../store';
import { SyncPhysicalFilamentsFromPrinterCommand } from '../filaments/commands';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const COLORS = ['#FFFFFF', '#000000', '#FAC116', '#E32A20'];

function physical(id: string, toolId: number, color: string): PhysicalFilament {
  return {
    id: id as PhysicalFilament['id'],
    name: `Tool ${toolId + 1}`,
    toolId,
    material: 'PLA',
    color,
    config: {},
    enabled: true,
  };
}

/**
 * A four-tool project whose parts are spread across every tool, mirroring the
 * shape of a multi-colour BBS project after import.
 */
function harness() {
  const ids = new UuidIdSource(seededRandom(0x4c07));
  const state: ProjectState = createEmptyProject({ idSource: ids, now: '2026-08-09T00:00:00.000Z', toolCount: 4 });
  const asset = encodeIndexedMeshAsset({
    id: ids.next('asset'),
    positions: [0, 0, 0, 10, 0, 0, 10, 10, 0],
    indices: [0, 1, 2],
    sourceFilename: 'tri.stl',
  });
  state.sourceAssets.push(asset.descriptor);
  const filaments = COLORS.map((color, index) => physical(`import:test:fil-${index + 1}`, index, color));
  state.filaments.physical.push(...filaments);
  state.plates[0].objects.push({
    id: ids.next('object'),
    name: 'Multi',
    config: {},
    filamentId: filaments[0].id,
    volumes: COLORS.map((_color, index) => ({
      id: ids.next('volume'),
      name: `Part ${index + 1}`,
      role: 'model' as const,
      source: { assetId: asset.descriptor.id, topologyRevision: 0, triangleCount: 1 },
      transform: identityTransform(),
      config: {},
      annotations: emptyFacetAnnotations(),
      // Every part but the first names its own tool; the first inherits.
      ...(index === 0 ? {} : { filamentId: filaments[index].id }),
    })),
    instances: [{ id: ids.next('instance'), transform: identityTransform(), printable: true }],
    layerRanges: [],
  });
  const project = new ProjectStore(state);
  const assets = new InMemoryAssetRepository();
  assets.put(asset.descriptor, asset.bytes);
  const commands = new CommandBus({ project, selection: new SelectionStore(), assets });
  commands.markCheckpoint();
  return { project, commands, filaments };
}

/** What a renderer would colour each volume, using only canonical state. */
function renderColors(state: ProjectState): string[] {
  const out: string[] = [];
  for (const plate of state.plates) {
    for (const object of plate.objects) {
      for (const volume of object.volumes) {
        const id = resolveFilament(object, volume).effective;
        const filament = state.filaments.physical.find((candidate) => candidate.id === id);
        out.push(filament?.color ?? 'unassigned');
      }
    }
  }
  return out;
}

test('every part resolves its own tool colour, not one shared colour', () => {
  const h = harness();
  const colors = renderColors(h.project.getSnapshot().state);
  assert.deepEqual(colors, COLORS, 'a four-tool project must resolve four distinct display colours');
  assert.equal(new Set(colors).size, 4);
});

test('syncing from the printer rewrites exactly the reported tools and undoes', () => {
  const h = harness();
  const before = renderColors(h.project.getSnapshot().state);
  const undoBefore = h.commands.getHistorySnapshot().undoCount;

  const slots = [
    { toolId: 0, color: '#123456', material: 'PETG', vendor: 'Elegoo' },
    { toolId: 2, color: '#ABCDEF', material: 'PLA-CF' },
    // A slot the project has no tool for must be left alone, not invented.
    { toolId: 9, color: '#010203', material: 'ABS' },
  ];
  const summary = SyncPhysicalFilamentsFromPrinterCommand.describe(h.project.getSnapshot().state, slots);
  assert.deepEqual(summary.applied, [0, 2]);
  assert.deepEqual(summary.unmatched, [9]);

  h.commands.execute(new SyncPhysicalFilamentsFromPrinterCommand(slots));
  const state = h.project.getSnapshot().state;
  assert.deepEqual(renderColors(state), ['#123456', COLORS[1], '#ABCDEF', COLORS[3]]);
  const tool0 = state.filaments.physical.find((filament) => filament.toolId === 0);
  assert.equal(tool0?.material, 'PETG');
  assert.equal(tool0?.vendor, 'Elegoo');
  assert.equal(state.filaments.physical.length, 4, 'an unmatched slot never adds a tool');
  assert.equal(h.commands.getHistorySnapshot().undoCount, undoBefore + 1, 'a sync is one entry');

  assert.equal(h.commands.undo(), true);
  assert.deepEqual(renderColors(h.project.getSnapshot().state), before);
});

test('a sync that matches the printer already is a no-op', () => {
  const h = harness();
  const slots = COLORS.map((color, index) => ({ toolId: index, color, material: 'PLA' }));
  const summary = SyncPhysicalFilamentsFromPrinterCommand.describe(h.project.getSnapshot().state, slots);
  assert.deepEqual(summary.applied, [], 'nothing differs, so nothing is applied');
  assert.deepEqual(summary.unmatched, []);
});

/**
 * The case a four-slot machine and a one-tool project actually present. Before
 * adoption this was unreachable: the sync only recoloured tools that already
 * existed, so a project could never grow to match the printer in front of it.
 */
test('a printer with more slots than the project has tools is adopted in full', () => {
  const h = harness();
  const ids = new UuidIdSource(seededRandom(7));
  const state = h.project.getSnapshot().state;
  // Reduce the fixture to a single tool, as a freshly imported model would be.
  const trimmed = cloneProjectState(state);
  trimmed.filaments.physical = trimmed.filaments.physical.slice(0, 1);
  for (const plate of trimmed.plates) {
    for (const object of plate.objects) {
      object.filamentId = trimmed.filaments.physical[0].id;
      for (const volume of object.volumes) delete volume.filamentId;
    }
  }
  h.project.replaceState(trimmed, { reason: 'test', dirtyCategories: ['projectData'] });

  // Exactly what the Snapmaker U1 reports over its Moonraker extension.
  const slots = [
    { toolId: 0, color: '#1E88E5', material: 'PLA', subType: 'Matte', vendor: 'Snapmaker' },
    { toolId: 1, color: '#000000', material: 'PLA', subType: 'Matte', vendor: 'Snapmaker' },
    { toolId: 2, color: '#E2DEDB', material: 'PLA', subType: 'SnapSpeed', vendor: 'Snapmaker' },
    { toolId: 3, color: '#F8F81C', material: 'PLA', subType: 'Matte', vendor: 'Snapmaker' },
  ];

  const summary = SyncPhysicalFilamentsFromPrinterCommand.describe(h.project.getSnapshot().state, slots, true);
  assert.deepEqual(summary.applied, [0]);
  assert.deepEqual(summary.added, [1, 2, 3], 'the three slots with no tool are adopted');
  assert.deepEqual(summary.unmatched, []);
  assert.deepEqual(summary.extra, []);

  const undoBefore = h.commands.getHistorySnapshot().undoCount;
  h.commands.execute(new SyncPhysicalFilamentsFromPrinterCommand(slots, ids));
  const synced = h.project.getSnapshot().state;
  assert.equal(synced.filaments.physical.length, 4, 'the project now matches the machine');
  assert.deepEqual(
    synced.filaments.physical.map((filament) => [filament.toolId, filament.color, filament.material, filament.name]),
    [
      [0, '#1E88E5', 'PLA', 'Snapmaker PLA Matte'],
      [1, '#000000', 'PLA', 'Snapmaker PLA Matte'],
      [2, '#E2DEDB', 'PLA', 'Snapmaker PLA SnapSpeed'],
      [3, '#F8F81C', 'PLA', 'Snapmaker PLA Matte'],
    ],
  );
  // The grade never contaminates the type the slicer reads.
  assert.deepEqual(new Set(synced.filaments.physical.map((f) => f.material)), new Set(['PLA']));
  assert.equal(h.commands.getHistorySnapshot().undoCount, undoBefore + 1, 'adoption is one entry');

  assert.equal(h.commands.undo(), true);
  assert.equal(h.project.getSnapshot().state.filaments.physical.length, 1, 'undo restores the single tool');
});

test('a tool the printer does not report is reported, never deleted', () => {
  const h = harness();
  const ids = new UuidIdSource(seededRandom(11));
  // The machine has two slots loaded; the project carries four tools.
  const slots = [
    { toolId: 0, color: '#111111', material: 'PLA', vendor: 'Snapmaker' },
    { toolId: 1, color: '#222222', material: 'PLA', vendor: 'Snapmaker' },
  ];
  const summary = SyncPhysicalFilamentsFromPrinterCommand.describe(h.project.getSnapshot().state, slots, true);
  assert.deepEqual(summary.extra, [2, 3], 'the unreported tools are named');

  h.commands.execute(new SyncPhysicalFilamentsFromPrinterCommand(slots, ids));
  const state = h.project.getSnapshot().state;
  assert.equal(state.filaments.physical.length, 4, 'objects may be assigned to those tools; they stay');
  assert.deepEqual(
    state.filaments.physical.map((filament) => filament.toolId),
    [0, 1, 2, 3],
  );
});

test('unusable printer slot facts are refused before any mutation', () => {
  for (const bad of [
    { toolId: -1, color: '#FFFFFF', material: 'PLA' },
    { toolId: 0, color: 'red', material: 'PLA' },
    { toolId: 0, color: '#FFF', material: 'PLA' },
    { toolId: 0, color: '#FFFFFF', material: '  ' },
  ]) {
    assert.throws(() => new SyncPhysicalFilamentsFromPrinterCommand([bad]), /slot|colour|material/i);
  }
});

console.log(`\nImported project display and printer sync: ${passed} tests passed.`);

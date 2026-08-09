import assert from 'node:assert/strict';

import { InMemoryAssetRepository } from '../assets';
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

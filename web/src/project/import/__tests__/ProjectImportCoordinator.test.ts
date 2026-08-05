import assert from 'node:assert/strict';
import { InMemoryAssetRepository, contentDigest, type AssetPayload } from '../../assets';
import { RenameProjectCommand } from '../../commands';
import { cloneJson, cloneProjectState } from '../../domain/canonical';
import { seededRandom, UuidIdSource } from '../../domain/ids';
import {
  emptyFacetAnnotations,
  identityTransform,
  type ProjectState,
  type SourceAssetDescriptor,
} from '../../domain/model';
import { CommandBus } from '../../history/commandBus';
import { SelectionStore } from '../../selection';
import { ProjectStore } from '../../store';
import { ProjectImportCoordinator } from '../ProjectImportCoordinator';
import {
  ImportCancellationController,
  ImportCancelledError,
  ImportConfirmationError,
  ImportPreparationError,
  StaleImportPreviewError,
  type ParsedProjectImport,
  type ProjectImportParserPort,
} from '../types';

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function createHarness() {
  const ids = new UuidIdSource(seededRandom(0x1a4));
  const projectId = ids.next('project');
  const plateId = ids.next('plate');
  const objectId = ids.next('object');
  const volumeId = ids.next('volume');
  const instanceId = ids.next('instance');
  const assetId = ids.next('asset');
  const bytes = new Uint8Array(36);
  const descriptor: SourceAssetDescriptor = {
    id: assetId,
    kind: 'mesh',
    digest: contentDigest(bytes),
    byteLength: bytes.byteLength,
    mediaType: 'application/vnd.orcaxr.indexed-mesh',
    sourceFilename: 'baseline.stl',
    provenance: { source: 'recovered', uri: 'fixture:baseline' },
    mesh: {
      positions: {
        byteOffset: 0,
        byteLength: 36,
        componentType: 'float32',
        componentCount: 3,
        count: 3,
      },
      triangleCount: 1,
    },
  };
  const state: ProjectState = {
    schemaVersion: 1,
    id: projectId,
    name: 'Before import',
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    printer: { toolCount: 1 },
    config: {},
    activePlateId: plateId,
    plates: [
      {
        id: plateId,
        name: 'Plate 1',
        order: 0,
        printable: true,
        config: {},
        objects: [
          {
            id: objectId,
            name: 'Triangle',
            config: {},
            volumes: [
              {
                id: volumeId,
                name: 'Body',
                role: 'model',
                source: { assetId, topologyRevision: 0, triangleCount: 1 },
                transform: identityTransform(),
                config: {},
                annotations: emptyFacetAnnotations(),
              },
            ],
            instances: [{ id: instanceId, transform: identityTransform(), printable: true }],
            layerRanges: [],
          },
        ],
      },
    ],
    filaments: { physical: [], mixed: [] },
    sourceAssets: [descriptor],
    customGcode: [],
    thumbnails: [],
    extensionBlobs: [],
  };
  const asset: AssetPayload = { descriptor, bytes };
  const project = new ProjectStore(state);
  const selection = new SelectionStore();
  selection.set([{ kind: 'instance', id: instanceId }]);
  const assets = new InMemoryAssetRepository();
  assets.put(descriptor, bytes);
  const commands = new CommandBus({ project, selection, assets });
  commands.markCheckpoint();
  return { ids, state, asset, project, selection, assets, commands, instanceId };
}

function capture(harness: ReturnType<typeof createHarness>) {
  return {
    project: harness.project.getSnapshot(),
    assets: harness.assets.list(),
    selection: harness.selection.getSnapshot(),
    history: harness.commands.getHistorySnapshot(),
  };
}

function parserReturning(value: ParsedProjectImport): ProjectImportParserPort {
  return {
    async parse() {
      return value;
    },
  };
}

await test('previews repairs/conflicts/drops, deduplicates by content, and commits one undoable transaction', async () => {
  const harness = createHarness();
  const before = capture(harness);
  const aliasId = harness.ids.next('asset');
  const candidate = cloneProjectState(harness.state);
  candidate.name = 'Imported project';
  const importedDescriptor: SourceAssetDescriptor = {
    ...cloneJson(harness.asset.descriptor),
    id: aliasId,
  };
  delete importedDescriptor.sourceFilename;
  delete importedDescriptor.provenance;
  candidate.sourceAssets.push(importedDescriptor);
  candidate.plates[0].objects[0].volumes[0].source.assetId = aliasId;
  const parser: ProjectImportParserPort = {
    async parse(request) {
      request.base.state.name = 'A parser may mutate its private clone';
      return {
        state: candidate,
        assets: [cloneJsonAsset(harness.asset), { descriptor: importedDescriptor, bytes: harness.asset.bytes.slice() }],
        importedAssetIds: [aliasId],
        repairs: [
          {
            id: 'parser:units:1',
            kind: 'unit-conversion',
            path: 'plates[0].objects[0]',
            message: 'Converted source geometry from inches to millimetres',
            before: 'inch',
            after: 'mm',
          },
        ],
        conflicts: [
          {
            id: 'parser:preset:1',
            kind: 'preset',
            path: 'printer.profileId',
            message: 'An imported preset name matched a local preset with different content',
            resolution: 'keep imported preset snapshot',
          },
        ],
        droppedFields: [
          {
            id: 'parser:drop:1',
            path: 'Metadata/unsupported.config',
            field: 'vendor_private_flag',
            message: 'Dropped an unsupported vendor-private field',
            value: true,
          },
        ],
      };
    },
  };
  const coordinator = new ProjectImportCoordinator({
    parser,
    commands: harness.commands,
    now: () => '2026-07-17T12:34:56.000Z',
  });
  const prepared = await coordinator.prepare({
    bytes: new Uint8Array([1, 2, 3]),
    source: { filename: 'incoming-inch.stl', uri: 'file:///incoming-inch.stl' },
  });

  assert.deepEqual(capture(harness), before, 'prepare must not mutate any live store');
  assert.equal(prepared.preview.blocked, false);
  assert.equal(prepared.preview.counts.assets, 1);
  assert.equal(prepared.preview.counts.importedAssets, 1);
  assert.equal(prepared.preview.counts.deduplicatedAssets, 1);
  assert.ok(prepared.preview.repairs.some((notice) => notice.kind === 'unit-conversion'));
  assert.ok(prepared.preview.repairs.some((notice) => notice.kind === 'asset-deduplication'));
  assert.ok(prepared.preview.conflicts.some((notice) => notice.resolution));
  assert.ok(prepared.preview.droppedFields.some((notice) => notice.field === 'vendor_private_flag'));
  assert.ok(prepared.preview.droppedFields.some((notice) => notice.field === 'sourceFilename/provenance'));
  assert.ok(Object.isFrozen(prepared.preview));

  assert.throws(
    () => prepared.confirm({ confirmed: true, acknowledgedNoticeIds: [] }),
    (error: unknown) => error instanceof ImportConfirmationError && error.missingAcknowledgementIds.length > 0,
  );
  assert.deepEqual(capture(harness), before, 'failed confirmation must not touch stores or history');

  const result = prepared.confirm({
    confirmed: true,
    acknowledgedNoticeIds: prepared.preview.requiredAcknowledgementIds,
  });
  assert.equal(result.history.undoCount, 1);
  assert.equal(result.history.undoLabel, 'Import incoming-inch.stl');
  assert.equal(harness.project.getSnapshot().state.name, 'Imported project');
  assert.deepEqual(harness.selection.getSnapshot(), { refs: [] });
  assert.equal(harness.assets.list().length, 1);
  const committedAsset = harness.assets.list()[0];
  assert.equal(committedAsset.descriptor.id, harness.asset.descriptor.id);
  assert.equal(committedAsset.descriptor.sourceFilename, 'incoming-inch.stl');
  assert.deepEqual(committedAsset.descriptor.provenance, {
    source: 'import',
    uri: 'file:///incoming-inch.stl',
    importedAt: '2026-07-17T12:34:56.000Z',
  });
  assert.equal(
    harness.project.getSnapshot().state.plates[0].objects[0].volumes[0].source.assetId,
    harness.asset.descriptor.id,
  );

  assert.equal(harness.commands.undo(), true);
  assert.deepEqual(harness.project.getSnapshot().state, before.project.state);
  assert.deepEqual(harness.assets.list(), before.assets);
  assert.deepEqual(harness.selection.getSnapshot(), before.selection);
  assert.equal(harness.commands.redo(), true);
  assert.equal(harness.project.getSnapshot().state.name, 'Imported project');
});

await test('cancellation during worker parsing leaves project, history, assets, and selection untouched', async () => {
  const harness = createHarness();
  const before = capture(harness);
  const cancellation = new ImportCancellationController();
  let release!: (value: ParsedProjectImport) => void;
  const parser: ProjectImportParserPort = {
    parse() {
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  };
  const coordinator = new ProjectImportCoordinator({ parser, commands: harness.commands });
  const pending = coordinator.prepare({
    bytes: new Uint8Array([1]),
    source: { filename: 'cancelled.3mf' },
    cancellation: cancellation.token,
  });
  cancellation.cancel('dialog closed');
  release({
    state: cloneProjectState(harness.state),
    assets: [cloneJsonAsset(harness.asset)],
    importedAssetIds: [],
  });
  await assert.rejects(pending, ImportCancelledError);
  assert.deepEqual(capture(harness), before);
});

await test('prepared preview settlement releases its lifecycle exactly once', async () => {
  const cancelledHarness = createHarness();
  const cancelledCoordinator = new ProjectImportCoordinator({
    parser: parserReturning({
      state: cloneProjectState(cancelledHarness.state),
      assets: [cloneJsonAsset(cancelledHarness.asset)],
      importedAssetIds: [],
    }),
    commands: cancelledHarness.commands,
  });
  let settlements = 0;
  const cancelled = await cancelledCoordinator.prepare(
    { bytes: new Uint8Array([1]), source: { filename: 'cancelled-preview.3mf' } },
    () => {
      settlements += 1;
    },
  );
  assert.equal(settlements, 0);
  cancelled.cancel('dialog closed');
  cancelled.cancel('duplicate close');
  assert.equal(settlements, 1);

  const committedHarness = createHarness();
  const committedState = cloneProjectState(committedHarness.state);
  committedState.name = 'Committed preview';
  const committedCoordinator = new ProjectImportCoordinator({
    parser: parserReturning({
      state: committedState,
      assets: [cloneJsonAsset(committedHarness.asset)],
      importedAssetIds: [],
    }),
    commands: committedHarness.commands,
  });
  const committed = await committedCoordinator.prepare(
    { bytes: new Uint8Array([2]), source: { filename: 'committed-preview.3mf' } },
    () => {
      settlements += 1;
    },
  );
  committed.confirm({ confirmed: true, acknowledgedNoticeIds: [] });
  assert.equal(settlements, 2);
  assert.throws(() => committed.confirm({ confirmed: true, acknowledgedNoticeIds: [] }), ImportConfirmationError);
  assert.equal(settlements, 2);
});

await test('invalid canonical output becomes a blocked diagnostic preview with no mutation', async () => {
  const harness = createHarness();
  const before = capture(harness);
  const invalid = cloneProjectState(harness.state);
  invalid.activePlateId = harness.ids.next('plate');
  const coordinator = new ProjectImportCoordinator({
    parser: parserReturning({
      state: invalid,
      assets: [cloneJsonAsset(harness.asset)],
      importedAssetIds: [],
      droppedFields: [
        {
          id: 'parser:drop:bad',
          path: 'Metadata/unknown.xml',
          field: 'unknown',
          message: 'Unsupported field was dropped',
        },
      ],
    }),
    commands: harness.commands,
  });
  const prepared = await coordinator.prepare({
    bytes: new Uint8Array([1]),
    source: { filename: 'malformed.3mf' },
  });
  assert.equal(prepared.preview.blocked, true);
  assert.ok(prepared.preview.diagnostics.some((item) => item.code === 'dangling-active-plate'));
  assert.throws(
    () =>
      prepared.confirm({
        confirmed: true,
        acknowledgedNoticeIds: prepared.preview.requiredAcknowledgementIds,
      }),
    ImportConfirmationError,
  );
  assert.deepEqual(capture(harness), before);
});

await test('parser failure and stale confirmation are isolated from the import transaction', async () => {
  const failing = createHarness();
  const beforeFailure = capture(failing);
  const failedCoordinator = new ProjectImportCoordinator({
    parser: {
      async parse() {
        throw new Error('bad zip central directory');
      },
    },
    commands: failing.commands,
  });
  await assert.rejects(
    failedCoordinator.prepare({ bytes: new Uint8Array([0]), source: { filename: 'broken.3mf' } }),
    ImportPreparationError,
  );
  assert.deepEqual(capture(failing), beforeFailure);

  const stale = createHarness();
  const coordinator = new ProjectImportCoordinator({
    parser: parserReturning({
      state: cloneProjectState(stale.state),
      assets: [cloneJsonAsset(stale.asset)],
      importedAssetIds: [],
    }),
    commands: stale.commands,
  });
  const prepared = await coordinator.prepare({
    bytes: new Uint8Array([1]),
    source: { filename: 'stale.stl' },
  });
  stale.commands.execute(new RenameProjectCommand('Changed while preview was open'));
  const afterExternalChange = capture(stale);
  assert.throws(() => prepared.confirm({ confirmed: true, acknowledgedNoticeIds: [] }), StaleImportPreviewError);
  assert.deepEqual(capture(stale), afterExternalChange);
});

console.log(`\nTransactional project import: ${passed} tests passed.`);

function cloneJsonAsset(asset: AssetPayload): AssetPayload {
  return { descriptor: cloneJson(asset.descriptor), bytes: asset.bytes.slice() };
}

import assert from 'node:assert/strict';

import { InMemoryAssetRepository } from '../../assets';
import { canonicalStringify } from '../../domain/canonical';
import { entityId, seededRandom, UuidIdSource } from '../../domain/ids';
import {
  createEmptyProject,
  emptyFacetAnnotations,
  identityTransform,
  type PhysicalFilament,
  type ProjectState,
} from '../../domain/model';
import { CommandBus } from '../../history/commandBus';
import { decodeIndexedMeshAsset, encodeIndexedMeshAsset } from '../../meshCodec';
import { RenameProjectCommand } from '../../commands';
import { SelectionStore } from '../../selection';
import { ProjectStore } from '../../store';
import { PaintStrokeService } from '../PaintStrokeService';
import {
  AI_PAINT_MAX_REGIONS,
  AiPaintProposalError,
  parseAiPaintProposal,
  projectAiPaintProposal,
} from '../aiPaintProposal';
import { AiPaintSession, type AiPaintConsent, type AiPaintPort, type AiPaintPortRequest } from '../AiPaintSession';

let passed = 0;
async function test(name: string, run: () => Promise<void> | void): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const TOOL_ONE = entityId<'physical-filament'>('import:test:ai-tool-1');
const TOOL_TWO = entityId<'physical-filament'>('import:test:ai-tool-2');
const PROVIDER = 'test-provider';

function physical(id: typeof TOOL_ONE, toolId: number, color: string, name: string): PhysicalFilament {
  return { id, name, toolId, material: 'PLA', color, config: {}, enabled: true };
}

/** Axis-aligned 10 mm cube: 12 triangles, one distinct normal per face pair. */
function cubeAsset() {
  const s = 10;
  return encodeIndexedMeshAsset({
    id: entityId<'asset'>('import:test:ai-cube'),
    positions: [0, 0, 0, s, 0, 0, s, s, 0, 0, s, 0, 0, 0, s, s, 0, s, s, s, s, 0, s, s],
    indices: [
      // -Z bottom, +Z top, -Y, +Y, -X, +X
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
    ],
    sourceFilename: 'cube.stl',
  });
}

function createHarness() {
  const ids = new UuidIdSource(seededRandom(0x4a91));
  const state: ProjectState = createEmptyProject({ idSource: ids, now: '2026-08-09T00:00:00.000Z', toolCount: 2 });
  const asset = cubeAsset();
  const objectId = ids.next('object');
  const volumeId = ids.next('volume');
  const instanceId = ids.next('instance');
  state.sourceAssets.push(asset.descriptor);
  state.filaments.physical.push(physical(TOOL_ONE, 0, '#ff0000', 'Red'), physical(TOOL_TWO, 1, '#0000ff', 'Blue'));
  state.plates[0].objects.push({
    id: objectId,
    name: 'Cube',
    config: {},
    volumes: [
      {
        id: volumeId,
        name: 'Body',
        role: 'model',
        source: { assetId: asset.descriptor.id, topologyRevision: 0, triangleCount: 12 },
        transform: identityTransform(),
        config: {},
        annotations: emptyFacetAnnotations(),
      },
    ],
    instances: [{ id: instanceId, transform: identityTransform(), printable: true }],
    layerRanges: [],
  });

  const project = new ProjectStore(state);
  const assets = new InMemoryAssetRepository();
  assets.put(asset.descriptor, asset.bytes);
  const commands = new CommandBus({ project, selection: new SelectionStore(), assets });
  commands.markCheckpoint();
  const strokes = new PaintStrokeService({ commands, assets });
  return { project, assets, commands, strokes, volumeId };
}

function consent(overrides: Partial<AiPaintConsent> = {}): AiPaintConsent {
  return {
    geometry: true,
    image: false,
    providerId: PROVIDER,
    grantedAt: '2026-08-09T00:00:00.000Z',
    ...overrides,
  };
}

/** Deterministic port: no network, and it records exactly what was sent. */
function mockPort(response: unknown | (() => unknown | Promise<unknown>)): AiPaintPort & {
  readonly calls: AiPaintPortRequest[];
} {
  const calls: AiPaintPortRequest[] = [];
  return {
    providerId: PROVIDER,
    calls,
    async propose(request) {
      calls.push(request);
      return typeof response === 'function' ? await (response as () => unknown)() : response;
    },
  };
}

const TOP_AND_BOTTOM = {
  schemaVersion: 1,
  regions: [
    { label: 'Top face', confidence: 0.9, shape: { kind: 'direction', axis: [0, 0, 1], maxAngleDeg: 30 } },
    { label: 'Bottom face', confidence: 0.5, shape: { kind: 'direction', axis: [0, 0, -1], maxAngleDeg: 30 } },
  ],
};

function facets(harness: ReturnType<typeof createHarness>) {
  return harness.project.getSnapshot().state.plates[0].objects[0].volumes[0].annotations.color;
}

function snapshot(harness: ReturnType<typeof createHarness>): string {
  return canonicalStringify(harness.project.getSnapshot().state as never);
}

await test('parses only bounded, fully stated proposals', () => {
  const parsed = parseAiPaintProposal(TOP_AND_BOTTOM);
  assert.equal(parsed.regions.length, 2);
  assert.deepEqual(
    parsed.regions.map((region) => region.id),
    ['ai-region-1', 'ai-region-2'],
    'positional IDs cannot be collided by a provider',
  );

  const rejects: Array<[unknown, string]> = [
    ['not-json', 'malformed-proposal'],
    [{ schemaVersion: 2, regions: [] }, 'unsupported-version'],
    [{ schemaVersion: 1, regions: [] }, 'empty-proposal'],
    [
      { schemaVersion: 1, regions: Array.from({ length: AI_PAINT_MAX_REGIONS + 1 }, () => TOP_AND_BOTTOM.regions[0]) },
      'too-many-regions',
    ],
    [{ schemaVersion: 1, regions: [{ confidence: 0.5, shape: TOP_AND_BOTTOM.regions[0].shape }] }, 'malformed-region'],
    [
      { schemaVersion: 1, regions: [{ label: 'x', confidence: 1.5, shape: TOP_AND_BOTTOM.regions[0].shape }] },
      'malformed-region',
    ],
    [
      {
        schemaVersion: 1,
        regions: [{ label: 'x', confidence: 1, shape: { kind: 'direction', axis: [0, 0, 0], maxAngleDeg: 10 } }],
      },
      'malformed-region',
    ],
    [
      {
        schemaVersion: 1,
        regions: [{ label: 'x', confidence: 1, shape: { kind: 'box', min: [0.6, 0, 0], max: [0.4, 1, 1] } }],
      },
      'malformed-region',
    ],
    [
      {
        schemaVersion: 1,
        regions: [{ label: 'x', confidence: 1, shape: { kind: 'polygon', points: [[0, 0]] } }],
      },
      'malformed-region',
    ],
  ];
  for (const [raw, code] of rejects) {
    assert.throws(
      () => parseAiPaintProposal(raw),
      (error: unknown) => error instanceof AiPaintProposalError && error.code === code,
      `expected ${code}`,
    );
  }
});

await test('projects regions onto exact facets with later regions overwriting earlier ones', () => {
  const harness = createHarness();
  const projection = projectAiPaintProposal({
    proposal: parseAiPaintProposal({
      schemaVersion: 1,
      regions: [
        // Everything, then the top face on top of it.
        { label: 'Whole model', confidence: 0.4, shape: { kind: 'box', min: [0, 0, 0], max: [1, 1, 1] } },
        { label: 'Top face', confidence: 1, shape: { kind: 'direction', axis: [0, 0, 1], maxAngleDeg: 5 } },
      ],
    }),
    mesh: decodeMesh(harness),
    volumeId: harness.volumeId,
    topologyRevision: 0,
  });

  assert.equal(projection.triangleCount, 12);
  assert.equal(projection.coverage, 1, 'the box claims every facet');
  assert.equal(projection.unassignedTriangleCount, 0);
  assert.deepEqual(projection.regions[1].triangleIndices, [2, 3], 'the +Z pair wins over the box');
  assert.equal(projection.regions[0].triangleIndices.length, 10);
  assert.equal(
    projection.regions[0].triangleIndices.includes(2),
    false,
    'an overwritten facet leaves the earlier region',
  );
  // Coverage-weighted: (10 * 0.4 + 2 * 1) / 12
  assert.ok(Math.abs(projection.confidence - (10 * 0.4 + 2) / 12) < 1e-12);
});

await test('a request previews without touching canonical state, and apply commits one undoable command', async () => {
  const harness = createHarness();
  const port = mockPort(TOP_AND_BOTTOM);
  const session = new AiPaintSession({
    commands: harness.commands,
    assets: harness.assets,
    strokes: harness.strokes,
    port,
  });
  const before = snapshot(harness);

  const outcome = await session.request({
    volumeId: harness.volumeId,
    channel: 'color',
    prompt: 'paint the top red',
    consent: consent(),
  });
  assert.equal(outcome.status, 'preview');
  assert.equal(snapshot(harness), before, 'a preview never mutates the project');
  assert.equal(facets(harness).length, 0);

  const preview = outcome.status === 'preview' ? outcome.preview : undefined;
  assert.ok(preview);
  assert.equal(preview.regions.length, 2);
  assert.equal(preview.assignable, false, 'nothing is painted until a destination is chosen');
  assert.deepEqual(preview.regions[0].triangleIndices, [2, 3]);
  assert.equal(preview.coverage, 4 / 12);

  // Only geometry size and extent leave the device — never vertices or IDs.
  assert.deepEqual(port.calls[0].geometry, { triangleCount: 12, extentMm: [10, 10, 10] });
  assert.equal('vertices' in (port.calls[0].geometry as object), false);
  assert.equal(port.calls[0].imageBase64, undefined);

  const historyBefore = harness.commands.getHistorySnapshot().undoCount;
  session.assignRegion('ai-region-1', TOOL_TWO);
  session.assignRegion('ai-region-2', TOOL_ONE);
  assert.equal(session.current?.assignable, true);

  const applied = session.apply();
  assert.equal(applied.status, 'applied');
  assert.equal(applied.status === 'applied' ? applied.facetCount : 0, 4);
  assert.equal(
    harness.commands.getHistorySnapshot().undoCount,
    historyBefore + 1,
    'the whole mask is one undo entry, not one per region',
  );

  const painted = facets(harness);
  const byValue = new Map(painted.map((entry) => [entry.value, entry.triangles]));
  assert.deepEqual(byValue.get(TOOL_TWO), [2, 3]);
  assert.deepEqual(byValue.get(TOOL_ONE), [0, 1]);

  assert.equal(harness.commands.undo(), true);
  assert.equal(snapshot(harness), before, 'undo restores the exact pre-AI project');
});

await test('an unassigned or excluded region is not painted', async () => {
  const harness = createHarness();
  const session = new AiPaintSession({
    commands: harness.commands,
    assets: harness.assets,
    strokes: harness.strokes,
    port: mockPort(TOP_AND_BOTTOM),
  });
  await session.request({ volumeId: harness.volumeId, channel: 'color', prompt: 'top', consent: consent() });

  assert.equal(session.apply().status, 'noop', 'a mask with no destination paints nothing');
  assert.equal(facets(harness).length, 0);

  session.assignRegion('ai-region-1', TOOL_ONE);
  const corrected = session.excludeTriangles('ai-region-1', [3]);
  assert.deepEqual(corrected.regions[0].triangleIndices, [2], 'manual correction narrows the mask');
  // One facet left in the top region plus the untouched two-facet bottom region.
  assert.equal(corrected.coverage, 3 / 12, 'derived totals follow the correction');

  assert.equal(session.apply().status, 'applied');
  assert.deepEqual(facets(harness), [{ triangles: [2], value: TOOL_ONE }]);

  // Clearing a destination removes the region from a later commit entirely.
  const second = new AiPaintSession({
    commands: harness.commands,
    assets: harness.assets,
    strokes: harness.strokes,
    port: mockPort(TOP_AND_BOTTOM),
  });
  await second.request({ volumeId: harness.volumeId, channel: 'color', prompt: 'top', consent: consent() });
  second.assignRegion('ai-region-2', TOOL_TWO);
  second.assignRegion('ai-region-2', undefined);
  assert.equal(second.apply().status, 'noop');
});

await test('consent is required before anything is sent, per provider and per payload', async () => {
  const harness = createHarness();
  const port = mockPort(TOP_AND_BOTTOM);
  const session = new AiPaintSession({
    commands: harness.commands,
    assets: harness.assets,
    strokes: harness.strokes,
    port,
  });

  const withheld = await session.request({
    volumeId: harness.volumeId,
    channel: 'color',
    prompt: 'top',
    consent: consent({ geometry: false }),
  });
  assert.equal(withheld.status, 'failed');
  assert.equal(withheld.status === 'failed' ? withheld.code : '', 'geometry-not-consented');

  const image = await session.request({
    volumeId: harness.volumeId,
    channel: 'color',
    prompt: 'top',
    imageBase64: 'AAAA',
    consent: consent({ image: false }),
  });
  assert.equal(image.status === 'failed' ? image.code : '', 'image-not-consented');

  const other = await session.request({
    volumeId: harness.volumeId,
    channel: 'color',
    prompt: 'top',
    consent: consent({ providerId: 'someone-else' }),
  });
  assert.equal(other.status === 'failed' ? other.code : '', 'provider-mismatch');

  assert.equal(port.calls.length, 0, 'a refused consent never reaches the provider');
  assert.equal(session.current, undefined);
});

await test('provider failure, cancellation, and malformed output leave the project untouched', async () => {
  const harness = createHarness();
  const before = snapshot(harness);

  const failing = new AiPaintSession({
    commands: harness.commands,
    assets: harness.assets,
    strokes: harness.strokes,
    port: mockPort(() => {
      throw new Error('provider exploded');
    }),
  });
  const failed = await failing.request({
    volumeId: harness.volumeId,
    channel: 'color',
    prompt: 'top',
    consent: consent(),
  });
  assert.equal(failed.status === 'failed' ? failed.code : '', 'provider-error');
  assert.equal(snapshot(harness), before);

  const garbage = new AiPaintSession({
    commands: harness.commands,
    assets: harness.assets,
    strokes: harness.strokes,
    port: mockPort({ schemaVersion: 1, regions: [{ label: 'x', confidence: 2, shape: {} }] }),
  });
  const rejected = await garbage.request({
    volumeId: harness.volumeId,
    channel: 'color',
    prompt: 'top',
    consent: consent(),
  });
  assert.equal(rejected.status === 'failed' ? rejected.code : '', 'malformed-region');
  assert.equal(snapshot(harness), before);

  const cancelled = new AiPaintSession({
    commands: harness.commands,
    assets: harness.assets,
    strokes: harness.strokes,
    port: mockPort(TOP_AND_BOTTOM),
  });
  const aborted = await cancelled.request({
    volumeId: harness.volumeId,
    channel: 'color',
    prompt: 'top',
    consent: consent(),
    cancellation: { aborted: true, reason: 'user cancelled' },
  });
  assert.equal(aborted.status, 'cancelled');
  assert.equal(snapshot(harness), before);

  // Cancelling an open preview discards it with nothing to unwind.
  const discarded = new AiPaintSession({
    commands: harness.commands,
    assets: harness.assets,
    strokes: harness.strokes,
    port: mockPort(TOP_AND_BOTTOM),
  });
  await discarded.request({ volumeId: harness.volumeId, channel: 'color', prompt: 'top', consent: consent() });
  discarded.assignRegion('ai-region-1', TOOL_ONE);
  discarded.cancel();
  assert.equal(discarded.current, undefined);
  assert.equal(snapshot(harness), before);
});

await test('a project change between preview and apply fails closed', async () => {
  const harness = createHarness();
  const session = new AiPaintSession({
    commands: harness.commands,
    assets: harness.assets,
    strokes: harness.strokes,
    port: mockPort(TOP_AND_BOTTOM),
  });
  await session.request({ volumeId: harness.volumeId, channel: 'color', prompt: 'top', consent: consent() });
  session.assignRegion('ai-region-1', TOOL_ONE);

  harness.commands.execute(new RenameProjectCommand('Edited while the mask was open'));
  const after = snapshot(harness);
  assert.equal(session.apply().status, 'stale');
  assert.equal(snapshot(harness), after, 'a stale mask paints nothing');
});

await test('the same mask authors any facet channel, not just colour', async () => {
  const harness = createHarness();
  const session = new AiPaintSession({
    commands: harness.commands,
    assets: harness.assets,
    strokes: harness.strokes,
    port: mockPort(TOP_AND_BOTTOM),
  });
  await session.request({
    volumeId: harness.volumeId,
    channel: 'support',
    prompt: 'block supports on the top',
    consent: consent(),
  });
  session.assignRegion('ai-region-1', 'block');
  assert.equal(session.apply().status, 'applied');

  const volume = harness.project.getSnapshot().state.plates[0].objects[0].volumes[0];
  assert.deepEqual(volume.annotations.support, [{ triangles: [2, 3], value: 'block' }]);
  assert.equal(volume.annotations.color.length, 0, 'the active channel owns the commit');
});

await test('an unknown volume and a rejected value fail before any mutation', async () => {
  const harness = createHarness();
  const before = snapshot(harness);
  const session = new AiPaintSession({
    commands: harness.commands,
    assets: harness.assets,
    strokes: harness.strokes,
    port: mockPort(TOP_AND_BOTTOM),
  });

  const unknown = await session.request({
    volumeId: entityId<'volume'>('import:test:ai-missing'),
    channel: 'color',
    prompt: 'top',
    consent: consent(),
  });
  assert.equal(unknown.status === 'failed' ? unknown.code : '', 'unknown-volume');

  await session.request({ volumeId: harness.volumeId, channel: 'color', prompt: 'top', consent: consent() });
  session.assignRegion('ai-region-1', entityId<'physical-filament'>('import:test:ai-ghost'));
  assert.throws(() => session.apply(), /unknown|filament/i);
  assert.equal(snapshot(harness), before, 'a rejected destination leaves the project untouched');

  assert.throws(() => session.assignRegion('ai-region-9', TOOL_ONE), /not in the current preview/);
});

console.log(`\nAI paint projection: ${passed} tests passed.`);

function decodeMesh(harness: ReturnType<typeof createHarness>) {
  const volume = harness.project.getSnapshot().state.plates[0].objects[0].volumes[0];
  const payload = harness.assets.get(volume.source.assetId as never);
  assert.ok(payload);
  const decoded = decodeIndexedMeshAsset(payload);
  return { vertices: decoded.vertices, triangles: decoded.triangles };
}

import assert from 'node:assert/strict';
import {
  InMemoryAssetRepository,
  assertValidProjectState,
  canonicalStringify,
  migrateLegacyFlatProjectV1,
  migrateOrcaXrProject3mfV1,
  restoreMigratedAssets,
  type LegacyFlatProjectV1,
  type OrcaXrProjectMetadataV1,
} from '../..';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log('  ✓', name);
}

const triangleA = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]);
const triangleB = new Float32Array([1, 1, 1, 2, 1, 1, 1, 2, 1]);

const representativeMetadata: OrcaXrProjectMetadataV1 = {
  version: 1,
  profile: { machine: 'Snapmaker U1', process: '0.20 Standard', filament: 'PLA' },
  activePlate: 2,
  plates: [
    { id: 1, label: 'Plate 1' },
    { id: 2, label: 'Plate 2' },
  ],
  objects: [
    {
      plate: 1,
      viewer: { position: [0.1, 0, -0.2], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
      display: [0, 0.01, 0],
    },
    {
      plate: 2,
      viewer: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [2, 3, 4] },
      display: [1, 2, 3],
    },
  ],
};

test('migrates the current persisted Project3mf v1 metadata with explicit unit and axis conversion', () => {
  const result = migrateOrcaXrProject3mfV1(
    { metadata: representativeMetadata, geometries: [triangleA, triangleB] },
    {
      source: {
        sourceKey: 'existing-sample',
        uri: 'local-project:existing-sample',
        filename: 'Existing sample.3mf',
        importedAt: '2026-07-17T01:02:03.000Z',
      },
    },
  );

  assertValidProjectState(result.state);
  assert.equal(result.validationIssues.length, 0);
  assert.equal(result.state.name, 'Existing sample');
  assert.equal(result.state.plates.length, 2);
  assert.equal(result.state.activePlateId, result.state.plates[1].id);
  assert.equal(result.state.plates[0].objects.length, 1);
  assert.equal(result.state.plates[1].objects.length, 1);
  assert.equal(result.state.printer.profileId, 'Snapmaker U1');
  assert.deepEqual(result.state.plates[1].objects[0].instances[0].transform.scale, [2, 4, 3]);

  const first = result.state.plates[0].objects[0];
  const translation = first.instances[0].transform.translationMm;
  assert.ok(Math.abs(translation[0] - 57.14285714285714) < 1e-9);
  assert.ok(Math.abs(translation[1] - 114.28571428571428) < 1e-9);
  assert.equal(translation[2], 0);
  assert.ok(Math.abs(first.volumes[0].transform.translationMm[2] - 5.7142857142857135) < 1e-9);

  const migration = result.state.extensionData?.legacyMigration as Record<string, unknown>;
  assert.equal(migration.rawGeometryUnits, 'millimetre');
  assert.equal(migration.legacyTransformAxes, 'x-right-y-up-z-toward-user');
  assert.equal(migration.canonicalTransformAxes, 'printer-x-right-y-back-z-up');
  assert.equal(result.assets.entries.length, 2);

  const repository = new InMemoryAssetRepository();
  restoreMigratedAssets(result, repository);
  assert.equal(repository.list().length, 2);
});

test('migrates multiple flat plates and palette colors while deduplicating immutable geometry', () => {
  const flat: LegacyFlatProjectV1 = {
    version: 1,
    name: 'Flat workspace',
    profile: { machine: 'Snapmaker U1', process: '0.16 Optimal', filament: 'Snapmaker PLA' },
    activePlateId: 20,
    plates: [
      { id: 10, label: 'Front', createdAt: 100, config: { layer_height: 0.2 } },
      { id: 20, label: 'Back', createdAt: 200, printable: false },
    ],
    filaments: [
      { legacyId: 'left', name: 'Red PLA', color: 'E22B22', type: 'PLA', config: { nozzle_temperature: 220 } },
      { legacyId: 'right', name: 'Blue PETG', color: '#3366ffff', type: 'PETG', enabled: false },
    ],
    models: [
      {
        legacyId: 'same-mesh-a',
        name: 'First',
        plateId: 10,
        geometry: { positions: triangleA, sourceFilename: 'shared.stl', legacyId: 'mesh-a' },
        viewer: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
        filamentSlot: 0,
      },
      {
        legacyId: 'same-mesh-b',
        name: 'Second',
        plateId: 20,
        geometry: { positions: triangleA, sourceFilename: 'shared-copy.stl', legacyId: 'mesh-b' },
        viewer: { position: [0.0175, 0.035, -0.0525], quaternion: [0, 0, 0, 1], scale: [1, 2, 3] },
        filamentSlot: 1,
      },
    ],
  };
  const result = migrateLegacyFlatProjectV1(flat, {
    source: { sourceKey: 'flat-workspace', importedAt: '2026-07-17T00:00:00Z' },
  });

  assertValidProjectState(result.state);
  assert.equal(result.state.plates.length, 2);
  assert.equal(result.state.activePlateId, result.state.plates[1].id);
  assert.equal(result.state.plates[1].printable, false);
  assert.equal((result.state.plates[0].extensionData?.legacyMigration as Record<string, unknown>).createdAt, 100);
  assert.deepEqual(
    result.state.filaments.physical.map((filament) => [filament.color, filament.material, filament.enabled]),
    [
      ['#e22b22', 'PLA', true],
      ['#3366ff', 'PETG', false],
    ],
  );
  assert.equal(result.assets.entries.length, 1);
  const first = result.state.plates[0].objects[0];
  const second = result.state.plates[1].objects[0];
  assert.equal(first.volumes[0].source.assetId, second.volumes[0].source.assetId);
  assert.equal(first.filamentId, result.state.filaments.physical[0].id);
  assert.equal(second.filamentId, result.state.filaments.physical[1].id);
  assert.deepEqual(second.instances[0].transform.translationMm, [10, 30, 20]);
  assert.deepEqual(second.instances[0].transform.scale, [1, 3, 2]);
  assert.ok(result.diagnostics.some((entry) => entry.code === 'geometry-deduplicated'));

  const repository = new InMemoryAssetRepository();
  restoreMigratedAssets(result, repository);
  const asset = repository.list()[0];
  assert.throws(
    () => repository.put({ ...asset.descriptor, sourceFilename: 'mutated.stl' }, asset.bytes),
    /Immutable asset/,
  );
});

test('assigns stable imported IDs and byte-identical assets on deterministic reruns', () => {
  const input: LegacyFlatProjectV1 = {
    version: 1,
    plates: [{ id: 1, label: 'Plate 1' }],
    activePlateId: 1,
    filaments: [{ color: '#ffffff', type: 'PLA' }],
    models: [{ legacyId: 'object-a', plateId: 1, geometry: triangleB, filamentSlot: 0 }],
  };
  const left = migrateLegacyFlatProjectV1(input);
  const right = migrateLegacyFlatProjectV1(input);

  assert.equal(canonicalStringify(left.state), canonicalStringify(right.state));
  assert.equal(left.recovery.sourceKey, right.recovery.sourceKey);
  assert.deepEqual(
    left.assets.entries.map((entry) => ({ descriptor: entry.descriptor, bytes: Array.from(entry.bytes) })),
    right.assets.entries.map((entry) => ({ descriptor: entry.descriptor, bytes: Array.from(entry.bytes) })),
  );
  assert.match(left.state.id, /^import:orcaxr-flat-project-v1:project-/);
  assert.equal(left.state.createdAt, '1970-01-01T00:00:00.000Z');
});

test('repairs malformed flat state into a valid graph and emits recovery for every rejected fragment', () => {
  const malformed = {
    version: 1,
    name: '',
    activePlateId: 'not-declared',
    profile: { machine: 42, futureProfile: { vendor: 'keep' } },
    plates: [
      { id: 1, label: 'First', createdAt: 'bad', futurePlate: { lockMode: 7 } },
      { id: 1, label: '' },
    ],
    filaments: [{ color: 'not-a-color', type: '', futureFilament: ['retain', 2] }],
    models: [
      {
        legacyId: 'partially-valid',
        plateId: 999,
        geometry: {
          positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 6],
          futureGeometry: { topology: 'legacy' },
        },
        viewer: { position: [Number.NaN, 0], quaternion: [0, 0, 0, 0], scale: [0, 1, 1] },
        filamentSlot: 99,
        futureModel: { paint: [1, 2, 3] },
      },
      {
        legacyId: 'invalid-geometry',
        plateId: 1,
        geometry: { positions: [Number.NaN, 0, 0, 1, 0, 0, 0, 1, 0] },
      },
    ],
    config: { valid: 1, bad: Number.POSITIVE_INFINITY, '': 'empty-key-value' },
    futureRoot: { recentPath: '/private/project.3mf' },
  } as unknown as LegacyFlatProjectV1;
  const result = migrateLegacyFlatProjectV1(malformed, { source: { sourceKey: 'malformed' } });

  assertValidProjectState(result.state);
  assert.equal(result.validationIssues.length, 0);
  assert.ok(result.state.plates.length >= 4, 'duplicates and two missing references are recovered distinctly');
  assert.equal(result.assets.entries.length, 1);
  assert.equal(result.state.plates.flatMap((plate) => plate.objects).length, 1);
  assert.equal(result.state.filaments.physical[0].color, '#cccccc');

  const recoveryPaths = new Set(result.recovery.entries.map((entry) => entry.path));
  for (const path of [
    '$.futureRoot',
    'profile.futureProfile',
    'plates[0].futurePlate',
    'filaments[0].futureFilament',
    'models[0].futureModel',
    'models[0].geometry.futureGeometry',
    'models[0].geometry.positions',
    'models[1].geometry.positions',
    'config.bad',
    'config',
  ]) {
    assert.ok(recoveryPaths.has(path), `recovery includes ${path}`);
  }
  const rootRecovery = result.recovery.entries.find((entry) => entry.path === '$.futureRoot');
  assert.deepEqual(rootRecovery?.value, { recentPath: '/private/project.3mf' });
  assert.ok(
    result.recovery.entries.every((_, index) =>
      result.diagnostics.some((diagnostic) => diagnostic.recoveryEntry === index),
    ),
    'every recovery entry has a user-visible diagnostic',
  );
});

test('preserves sidecar fields and object metadata that cannot map instead of silently dropping them', () => {
  const metadata = {
    ...representativeMetadata,
    futureProject: { autosaveGeneration: 8 },
    plates: [{ id: 1, label: 'Only', futurePlate: 'opaque' }],
    activePlate: 1,
    objects: [
      representativeMetadata.objects[0],
      { ...representativeMetadata.objects[1], futureObject: { annotations: [4, 5] } },
    ],
  };
  const result = migrateOrcaXrProject3mfV1(
    { metadata, geometries: [triangleA] },
    { source: { sourceKey: 'future-sidecar' } },
  );

  const entries = new Map(result.recovery.entries.map((entry) => [entry.path, entry]));
  assert.deepEqual(entries.get('metadata.futureProject')?.value, { autosaveGeneration: 8 });
  assert.equal(entries.get('metadata.plates[0].futurePlate')?.value, 'opaque');
  assert.deepEqual(entries.get('metadata.objects[1]')?.value, metadata.objects[1]);
  assert.ok(result.diagnostics.some((entry) => entry.code === 'object-without-geometry'));
  assertValidProjectState(result.state);
});

console.log(`\nLegacy migration: ${passed} tests passed.`);

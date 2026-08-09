import assert from 'node:assert/strict';

import { InMemoryAssetRepository } from '../assets';
import { cloneProjectState } from '../domain/canonical';
import { entityId } from '../domain/ids';
import { identityTransform, type FullSpectrumRecipeState } from '../domain/model';
import { encodeIndexedMeshAsset } from '../meshCodec';
import { createProjectFixture } from '../__tests__/fixtures';
import {
  PINNED_MAXIMUM_FILAMENT_NUMBER,
  PINNED_SLICE_PREFLIGHT_SOURCE,
  runCanonicalSlicePreflight,
  type SlicePreflightConstraints,
} from './preflight';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const buildVolume = {
  minXmm: 0,
  maxXmm: 250,
  minYmm: 0,
  maxYmm: 250,
  minZmm: 0,
  maxZmm: 250,
} as const;

function harness() {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  const assets = new InMemoryAssetRepository();
  assets.put(fixture.asset.descriptor, fixture.asset.bytes);
  return { fixture, state, assets };
}

test('passes a bounded canonical plate and returns deterministic frozen evidence', () => {
  const { fixture, state, assets } = harness();
  const first = runCanonicalSlicePreflight({
    state,
    assets,
    plateId: fixture.ids.plate,
    constraints: { buildVolume },
  });
  const second = runCanonicalSlicePreflight({
    state,
    assets,
    plateId: fixture.ids.plate,
    constraints: { buildVolume },
  });
  assert.deepEqual(second, first);
  assert.equal(first.canSlice, true);
  assert.equal(first.blockingCount, 0);
  assert.deepEqual(first.printableInstanceIds, [fixture.ids.instance]);
  assert.deepEqual(first.usedFilamentIds, [fixture.ids.mixed, fixture.ids.physical0, fixture.ids.physical1].sort());
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.issues), true);
  assert.equal(PINNED_SLICE_PREFLIGHT_SOURCE.commit, '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626');
});

test('blocks unknown, excluded, and empty printable plates with stable codes', () => {
  const { fixture, state, assets } = harness();
  const missing = runCanonicalSlicePreflight({
    state,
    assets,
    plateId: entityId<'plate'>('import:preflight:missing'),
  });
  assert.deepEqual(
    missing.issues.map((issue) => issue.code),
    ['unknown-plate'],
  );
  assert.equal(missing.canSlice, false);

  state.plates[0].printable = false;
  state.plates[0].objects[0].instances[0].printable = false;
  const excluded = runCanonicalSlicePreflight({
    state,
    assets,
    plateId: fixture.ids.plate,
  });
  assert.deepEqual(
    excluded.issues.map((issue) => issue.code),
    ['no-printable-instance', 'plate-not-printable'],
  );
  assert.ok(excluded.issues.every((issue) => issue.id.startsWith('slice-preflight:')));
});

test('does not report no-printable-instance error issue for empty plates with zero objects', () => {
  const { fixture, state, assets } = harness();
  state.plates[0].objects = [];
  const empty = runCanonicalSlicePreflight({
    state,
    assets,
    plateId: fixture.ids.plate,
  });
  assert.deepEqual(empty.issues, []);
  assert.equal(empty.canSlice, false);
  assert.equal(empty.blockingCount, 0);
});

test('uses canonical transformed mesh bytes for build-volume, sinking, overlap, and asset checks', () => {
  const { fixture, state, assets } = harness();
  const first = state.plates[0].objects[0].instances[0];
  first.transform = {
    ...identityTransform(),
    translationMm: [245, 0, -2],
  };
  const secondId = entityId<'instance'>('import:preflight:overlap');
  state.plates[0].objects[0].instances.push({
    id: secondId,
    printable: true,
    transform: {
      ...identityTransform(),
      translationMm: [247, 1, -2],
    },
  });
  const result = runCanonicalSlicePreflight({
    state,
    assets,
    plateId: fixture.ids.plate,
    constraints: { buildVolume },
  });
  assert.equal(result.canSlice, false);
  assert.deepEqual(
    [...new Set(result.issues.map((issue) => issue.code))],
    ['instance-outside-build-volume', 'instance-aabb-overlap', 'instance-below-build-plate'],
  );
  assert.equal(
    result.issues.find((issue) => issue.code === 'instance-below-build-plate')?.actions[1]?.id,
    'drop-to-bed',
  );

  const mismatched = cloneProjectState(state);
  mismatched.sourceAssets[0].sourceFilename = 'metadata-drift.stl';
  const unreadable = runCanonicalSlicePreflight({
    state: mismatched,
    assets,
    plateId: fixture.ids.plate,
  });
  assert.equal(unreadable.issues.filter((issue) => issue.code === 'unreadable-model-mesh').length, 2);
});

test('blocks unavailable recipe dependencies and incompatible tool/material/temperature profiles', () => {
  const { fixture, state, assets } = harness();
  const object = state.plates[0].objects[0];
  object.filamentId = fixture.ids.mixed;
  state.filaments.mixed[0].enabled = false;
  state.filaments.mixed[0].fullSpectrum = {
    schemaVersion: 1,
    upstreamStableId: '7',
    uiMode: 0,
    componentAId: fixture.ids.physical0,
    componentBId: fixture.ids.physical1,
    ratioA: 1,
    ratioB: 1,
    mixBPercent: 50,
    manualPatternGroups: [],
    gradientComponentIds: [],
    gradientComponentWeights: [],
    pointillismAllFilaments: false,
    distributionMode: 0,
    localZMaxSublayers: 0,
    gradientEnabled: false,
    gradientStart: 0.8,
    gradientEnd: 0.2,
    componentASurfaceOffsetMm: 0,
    componentBSurfaceOffsetMm: 0,
    deleted: true,
    custom: false,
    originAuto: true,
  };
  state.filaments.physical[1].enabled = false;
  state.filaments.physical[0].nozzleDiameterMm = 0.4;
  const constraints: SlicePreflightConstraints = {
    buildVolume,
    tools: [
      {
        nozzleDiameterMm: 0.6,
        supportedMaterials: ['PETG'],
        minHotendTemperatureC: 180,
        maxHotendTemperatureC: 210,
      },
    ],
  };
  const result = runCanonicalSlicePreflight({
    state,
    assets,
    plateId: fixture.ids.plate,
    constraints,
  });
  const codes = new Set(result.issues.map((issue) => issue.code));
  for (const code of [
    'disabled-filament-assignment',
    'deleted-mixed-filament-assignment',
    'disabled-mixed-component',
    'filament-nozzle-mismatch',
    'unsupported-filament-material',
    'filament-temperature-out-of-range',
  ] as const) {
    assert.equal(codes.has(code), true, `missing ${code}`);
  }
  assert.equal(result.canSlice, false);
});

test('includes stable filament IDs used only by refined leaves', () => {
  const { fixture, state, assets } = harness();
  const volume = state.plates[0].objects[0].volumes[0];
  volume.annotations.color = [];
  volume.annotations.refinement = {
    color: {
      version: 1,
      roots: [
        {
          kind: 'split',
          splitSides: 1,
          specialSide: 0,
          children: [
            { kind: 'leaf', state: { kind: 'assigned', value: fixture.ids.mixed } },
            { kind: 'leaf', state: { kind: 'assigned', value: fixture.ids.physical0 } },
          ],
        },
      ],
    },
  };
  state.filaments.mixed[0].enabled = false;
  const result = runCanonicalSlicePreflight({ state, assets, plateId: fixture.ids.plate });
  assert.equal(result.usedFilamentIds.includes(fixture.ids.mixed), true);
  assert.equal(
    result.issues.some((issue) => issue.code === 'disabled-filament-assignment'),
    true,
  );
});

test('requires explicit attestation only when requested and validates wipe-tower intent', () => {
  const { fixture, state, assets } = harness();
  state.plates[0].wipeTower = {
    enabled: true,
    positionMm: [300, 300],
    rotationDeg: 0,
    filamentId: fixture.ids.mixed,
  };
  const result = runCanonicalSlicePreflight({
    state,
    assets,
    plateId: fixture.ids.plate,
    constraints: {
      buildVolume,
      requireProfileAttestation: true,
    },
  });
  assert.equal(result.issues.filter((issue) => issue.code === 'missing-profile-attestation').length, 3);
  assert.equal(
    result.issues.some((issue) => issue.code === 'wipe-tower-outside-build-volume'),
    true,
  );
  assert.equal(
    result.issues.some((issue) => issue.code === 'wipe-tower-requires-physical-filament'),
    true,
  );
});

test('rejects unsafe custom G-code and fails malformed canonical state closed', () => {
  const { fixture, state, assets } = harness();
  state.customGcode.push({
    id: entityId<'custom-gcode'>('import:preflight:gcode'),
    scope: 'plate',
    plateId: fixture.ids.plate,
    trigger: 'before-layer',
    code: 'G1 X1\0M112',
  });
  const unsafe = runCanonicalSlicePreflight({
    state,
    assets,
    plateId: fixture.ids.plate,
    constraints: { customGcodeByteLimit: 4 },
  });
  assert.equal(unsafe.issues.find((issue) => issue.code === 'unsafe-custom-gcode')?.detailCode, 'nul-byte');

  state.printer.toolCount = 0;
  const invalid = runCanonicalSlicePreflight({
    state,
    assets,
    plateId: fixture.ids.plate,
  });
  assert.equal(invalid.issues[0].code, 'invalid-project-state');
  assert.equal(invalid.issues[0].detailCode, 'invalid-tool-count');
  assert.equal(invalid.canSlice, false);
});

test('rejects malformed preflight constraints instead of silently weakening checks', () => {
  const { fixture, state, assets } = harness();
  assert.throws(
    () =>
      runCanonicalSlicePreflight({
        state,
        assets,
        plateId: fixture.ids.plate,
        constraints: {
          buildVolume: { ...buildVolume, maxXmm: 0 },
        },
      }),
    /finite increasing axis bounds/,
  );
  assert.throws(
    () =>
      runCanonicalSlicePreflight({
        state,
        assets,
        plateId: fixture.ids.plate,
        constraints: { customGcodeByteLimit: 0 },
      }),
    /positive safe integer/,
  );

  const empty = encodeIndexedMeshAsset({
    id: entityId<'asset'>('import:preflight:empty'),
    positions: [],
    indices: [],
  });
  state.sourceAssets[0] = empty.descriptor;
  state.plates[0].objects[0].volumes[0].source = {
    assetId: empty.descriptor.id,
    topologyRevision: 0,
    triangleCount: 0,
  };
  state.plates[0].objects[0].volumes[0].annotations.color = [];
  const emptyAssets = new InMemoryAssetRepository();
  emptyAssets.put(empty.descriptor, empty.bytes);
  const result = runCanonicalSlicePreflight({
    state,
    assets: emptyAssets,
    plateId: fixture.ids.plate,
  });
  assert.equal(
    result.issues.some((issue) => issue.code === 'empty-model-mesh'),
    true,
  );
});

function fullSpectrumRecipe(
  overrides: Partial<FullSpectrumRecipeState> & Pick<FullSpectrumRecipeState, 'componentAId' | 'componentBId'>,
): FullSpectrumRecipeState {
  return {
    schemaVersion: 1,
    upstreamStableId: '4242',
    uiMode: 3,
    ratioA: 1,
    ratioB: 1,
    mixBPercent: 50,
    manualPatternGroups: [],
    gradientComponentIds: [],
    gradientComponentWeights: [],
    pointillismAllFilaments: false,
    distributionMode: 0,
    localZMaxSublayers: 0,
    gradientEnabled: true,
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

test('blocks a mixed filament on a target that declares fewer than two physical tools', () => {
  // A two-tool project re-targeted at a single-extruder printer: the canonical
  // graph is valid, the resolved printer simply cannot mix.
  const { fixture, state, assets } = harness();
  const result = runCanonicalSlicePreflight({
    state,
    assets,
    plateId: fixture.ids.plate,
    constraints: { buildVolume, printer: { physicalToolCount: 1 } },
  });
  const capability = result.issues.find((issue) => issue.code === 'mixed-filament-unsupported-printer');
  assert.ok(capability, 'expected the capability gate to fire');
  assert.match(capability.message, /declares 1 physical tool/);
  assert.equal(result.canSlice, false);

  // The same project on a two-tool target keeps the recipe printable.
  const allowed = runCanonicalSlicePreflight({
    state,
    assets,
    plateId: fixture.ids.plate,
    constraints: { buildVolume, printer: { physicalToolCount: 2 } },
  });
  assert.equal(
    allowed.issues.some((issue) => issue.code === 'mixed-filament-unsupported-printer'),
    false,
  );
});

test('refuses the silent single-tool collapse of an out-of-range physical tool', () => {
  const { fixture, state, assets } = harness();
  const result = runCanonicalSlicePreflight({
    state,
    assets,
    plateId: fixture.ids.plate,
    constraints: { buildVolume, printer: { physicalToolCount: 1 } },
  });
  const outOfRange = result.issues.filter((issue) => issue.code === 'filament-tool-out-of-range');
  assert.equal(outOfRange.length, 1);
  assert.match(outOfRange[0].message, /silently reassign/);
  assert.deepEqual(outOfRange[0].entities, [{ kind: 'filament', id: fixture.ids.physical1 }]);
});

test('enforces the pinned material compatibility matrix on recipe components', () => {
  const { fixture, state, assets } = harness();
  state.filaments.physical[1].material = 'PETG';
  const result = runCanonicalSlicePreflight({
    state,
    assets,
    plateId: fixture.ids.plate,
    constraints: { buildVolume },
  });
  const incompatible = result.issues.find((issue) => issue.code === 'incompatible-mixed-components');
  assert.ok(incompatible, 'expected PLA + PETG to be refused');
  assert.match(incompatible.message, /PLA and PETG cannot be mixed/);
  assert.deepEqual(
    incompatible.entities.map((entity) => ('id' in entity ? entity.id : entity.kind)),
    [fixture.ids.mixed, fixture.ids.physical0, fixture.ids.physical1],
  );
});

test('blocks the gradient repairs canonical validation lets through', () => {
  const { fixture, state, assets } = harness();
  // Canonical validation only requires (0, 1); the engine clamps to [0.01, 0.99]
  // and drops a duplicated component while decoding the compact ID list.
  state.filaments.mixed[0].fullSpectrum = fullSpectrumRecipe({
    componentAId: fixture.ids.physical0,
    componentBId: fixture.ids.physical1,
    gradientStart: 0.995,
    gradientEnd: 0.005,
    gradientComponentIds: [fixture.ids.physical0, fixture.ids.physical1, fixture.ids.physical0],
  });
  const result = runCanonicalSlicePreflight({
    state,
    assets,
    plateId: fixture.ids.plate,
    constraints: { buildVolume, printer: { physicalToolCount: 2 } },
  });
  const gradient = result.issues.filter((issue) => issue.code === 'gradient-recipe-out-of-bounds');
  assert.deepEqual([...new Set(gradient.map((issue) => issue.detailCode))].sort(), [
    'gradientComponentIds',
    'gradientEnd',
    'gradientStart',
  ]);
  assert.match(gradient[0].help, /remains unchanged until an explicit fix runs/);
  assert.equal(result.canSlice, false);

  state.filaments.mixed[0].fullSpectrum = fullSpectrumRecipe({
    componentAId: fixture.ids.physical0,
    componentBId: fixture.ids.physical1,
    gradientComponentIds: [fixture.ids.physical0, fixture.ids.physical1],
    gradientComponentWeights: [70, 30],
  });
  const clean = runCanonicalSlicePreflight({
    state,
    assets,
    plateId: fixture.ids.plate,
    constraints: { buildVolume, printer: { physicalToolCount: 2 } },
  });
  assert.equal(
    clean.issues.some((issue) => issue.code === 'gradient-recipe-out-of-bounds'),
    false,
  );

  // The same clean recipe against a single-tool target loses a component silently.
  const narrowed = runCanonicalSlicePreflight({
    state,
    assets,
    plateId: fixture.ids.plate,
    constraints: { buildVolume, printer: { physicalToolCount: 1 } },
  });
  assert.equal(
    narrowed.issues.some(
      (issue) => issue.code === 'gradient-recipe-out-of-bounds' && /drops it while decoding/.test(issue.message),
    ),
    true,
  );
});

test('holds the project to the pinned engine filament ceiling', () => {
  const { fixture, state, assets } = harness();
  assert.equal(PINNED_MAXIMUM_FILAMENT_NUMBER, 64);
  const template = state.filaments.mixed[0];
  for (let index = 0; index < 62; index += 1) {
    state.filaments.mixed.push({
      ...template,
      id: entityId<'mixed-filament'>(`import:preflight:mix-${index}`),
      name: `Mix ${index}`,
    });
  }
  const result = runCanonicalSlicePreflight({ state, assets, plateId: fixture.ids.plate });
  const overflow = result.issues.find((issue) => issue.code === 'filament-count-exceeds-engine-limit');
  assert.ok(overflow, 'expected the engine ceiling to fire');
  assert.match(overflow.message, /at most 64/);

  // A tombstoned or disabled row is not addressable and does not count.
  state.filaments.mixed[62].enabled = false;
  const trimmed = runCanonicalSlicePreflight({ state, assets, plateId: fixture.ids.plate });
  assert.equal(
    trimmed.issues.some((issue) => issue.code === 'filament-count-exceeds-engine-limit'),
    false,
  );
  assert.throws(
    () =>
      runCanonicalSlicePreflight({
        state,
        assets,
        plateId: fixture.ids.plate,
        constraints: { printer: { physicalToolCount: 2, maxTotalFilaments: 65 } },
      }),
    /no greater than 64/,
  );
});

test('applies the pinned prime-tower preconditions and diameter warning', () => {
  const { fixture, state, assets } = harness();
  state.plates[0].wipeTower = {
    enabled: true,
    positionMm: [100, 100],
    rotationDeg: 0,
    filamentId: fixture.ids.physical0,
  };
  state.config.use_relative_e_distances = '0';
  state.config.ooze_prevention = '1';
  state.config.single_extruder_multi_material = '1';
  state.filaments.physical[0].config.filament_diameter = '1.75';
  state.filaments.physical[1].config.filament_diameter = '2.85';
  const result = runCanonicalSlicePreflight({
    state,
    assets,
    plateId: fixture.ids.plate,
    constraints: {
      buildVolume,
      tools: [{ nozzleDiameterMm: 0.4 }, { nozzleDiameterMm: 0.6 }],
    },
  });
  const codes = result.issues.map((issue) => issue.code);
  assert.equal(codes.includes('wipe-tower-requires-relative-e'), true);
  assert.equal(codes.includes('wipe-tower-ooze-prevention-conflict'), true);
  const diameters = result.issues.find((issue) => issue.code === 'wipe-tower-mixed-extruder-diameters');
  assert.ok(diameters, 'expected the upstream diameter warning');
  assert.equal(diameters.severity, 'warning');
  assert.equal(diameters.detailCode, 'nozzle_diameter');

  state.config.use_relative_e_distances = '1';
  state.config.ooze_prevention = '0';
  const relaxed = runCanonicalSlicePreflight({
    state,
    assets,
    plateId: fixture.ids.plate,
    constraints: { buildVolume, tools: [{ nozzleDiameterMm: 0.4 }, { nozzleDiameterMm: 0.4 }] },
  });
  const remaining = relaxed.issues.filter((issue) => issue.code.startsWith('wipe-tower-'));
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].detailCode, 'filament_diameter');
  assert.equal(remaining[0].severity, 'warning');
});

test('leaves an undeclared printer capability unevaluated instead of guessing', () => {
  const { fixture, state, assets } = harness();
  const result = runCanonicalSlicePreflight({
    state,
    assets,
    plateId: fixture.ids.plate,
    constraints: { buildVolume },
  });
  assert.equal(
    result.issues.some(
      (issue) => issue.code === 'mixed-filament-unsupported-printer' || issue.code === 'filament-tool-out-of-range',
    ),
    false,
  );
  assert.throws(
    () =>
      runCanonicalSlicePreflight({
        state,
        assets,
        plateId: fixture.ids.plate,
        constraints: { printer: { physicalToolCount: 0 } },
      }),
    /positive physical tool count/,
  );
});

console.log(`\nCanonical slice preflight: ${passed} tests passed.`);

import assert from 'node:assert/strict';

import { createProjectFixture } from '../../project/__tests__/fixtures';
import type { CanonicalProjectSliceSnapshot } from '../../project/slicing/types';
import type { SlicerProfile } from '../../slicer/ProfileLoader';
import { deriveLiveProfilePreflightConstraints, LiveProfileSlicePreflight } from '../ProfilePreflightConstraints';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

test('derives an offset rectangular volume and exact per-tool filament constraints', () => {
  const primary = profile('pla', {
    printable_area: '0.5x1,270.5x1,270.5x271,0.5x271',
    printable_height: '270.05',
    nozzle_diameter: '0.4',
    single_extruder_multi_material: '1',
    filament_type: 'PLA',
    nozzle_temperature_range_low: '190',
    nozzle_temperature_range_high: '240',
  });
  const petg = profile('petg', {
    ...primary.config,
    filament_type: 'PETG',
    nozzle_temperature_range_low: '220',
    nozzle_temperature_range_high: '270',
  });
  const asa = profile('asa', {
    ...primary.config,
    filament_type: 'ASA',
    nozzle_temperature_range_low: '240',
    nozzle_temperature_range_high: '280',
  });
  const derived = deriveLiveProfilePreflightConstraints({
    primaryProfile: primary,
    filamentProfiles: [primary, petg, asa],
    toolCount: 3,
  });

  assert.deepEqual(derived.constraints.buildVolume, {
    minXmm: 0.5,
    maxXmm: 270.5,
    minYmm: 1,
    maxYmm: 271,
    minZmm: 0,
    maxZmm: 270.05,
  });
  assert.deepEqual(derived.constraints.tools, [
    {
      nozzleDiameterMm: 0.4,
      supportedMaterials: ['PLA'],
      minHotendTemperatureC: 190,
      maxHotendTemperatureC: 240,
    },
    {
      nozzleDiameterMm: 0.4,
      supportedMaterials: ['PETG'],
      minHotendTemperatureC: 220,
      maxHotendTemperatureC: 270,
    },
    {
      nozzleDiameterMm: 0.4,
      supportedMaterials: ['ASA'],
      minHotendTemperatureC: 240,
      maxHotendTemperatureC: 280,
    },
  ]);
  assert.deepEqual(derived.blockingDiagnostics, []);
  assert.deepEqual(derived.omissions, []);
  assert.equal(Object.isFrozen(derived), true);
  assert.equal(Object.isFrozen(derived.constraints.tools), true);
});

test('fails closed for ambiguous required target fields without approximating them', () => {
  const primary = profile('pla', {
    printable_area: '0x0,10x10,10x0,0x10',
    printable_height: '250,260',
    nozzle_diameter: '0.4,0.6',
    single_extruder_multi_material: '0',
    filament_type: 'PLA',
  });
  const derived = deriveLiveProfilePreflightConstraints({
    primaryProfile: primary,
    filamentProfiles: [primary, undefined, primary],
    toolCount: 3,
  });

  assert.equal(derived.constraints.buildVolume, undefined);
  assert.ok(derived.constraints.tools?.every((tool) => tool?.nozzleDiameterMm === undefined));
  assert.deepEqual(
    derived.blockingDiagnostics.map((diagnostic) => diagnostic.code),
    [
      'ambiguous-printable-area',
      'ambiguous-printable-height',
      'ambiguous-nozzle-map',
      'missing-exact-filament-profile',
    ],
  );
  assert.equal(derived.blockingDiagnostics.at(-1)?.toolId, 1);
});

test('records unavailable optional material and temperature facts without inventing bounds', () => {
  const primary = profile('plain', {
    printable_area: '0x0,200x0,200x200,0x200,0x0',
    printable_height: '200',
    nozzle_diameter: '0.6',
    filament_type: 'PLA;PETG',
    nozzle_temperature_range_low: 'not-a-number',
  });
  const derived = deriveLiveProfilePreflightConstraints({
    primaryProfile: primary,
    filamentProfiles: [primary],
    toolCount: 1,
  });

  assert.deepEqual(derived.blockingDiagnostics, []);
  assert.deepEqual(derived.constraints.tools, [{ nozzleDiameterMm: 0.6 }]);
  assert.deepEqual(
    derived.omissions.map((omission) => omission.code),
    ['material-not-declared', 'temperature-lower-bound-not-declared', 'temperature-upper-bound-not-declared'],
  );
});

test('merges stable profile-attestation errors into canonical preflight evidence', () => {
  const fixture = createProjectFixture();
  const snapshot: CanonicalProjectSliceSnapshot = {
    state: fixture.state,
    assets: [fixture.asset],
    sourceRevision: 3,
    sourceHash: 'fixture-source',
    sourceAssetHash: 'fixture-assets',
  };
  const derivation = deriveLiveProfilePreflightConstraints({
    primaryProfile: undefined,
    filamentProfiles: [undefined, undefined],
    toolCount: 2,
  });
  const result = new LiveProfileSlicePreflight(derivation).evaluate(snapshot, fixture.ids.plate);

  assert.equal(result.canSlice, false);
  assert.equal(result.blockingCount, 3);
  assert.ok(result.issues.every((issue) => issue.code === 'missing-profile-attestation'));
  assert.deepEqual(
    result.issues.map((issue) => issue.id),
    [
      'slice-preflight:missing-profile-attestation:missing-exact-filament-profile-tool-0',
      'slice-preflight:missing-profile-attestation:missing-exact-filament-profile-tool-1',
      'slice-preflight:missing-profile-attestation:missing-exact-printer-profile',
    ],
  );
  assert.deepEqual(result.issues[0].entities, [{ kind: 'filament', id: fixture.ids.physical0 }]);
  assert.ok(result.issues.every((issue) => issue.actions.length === 0));
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.issues), true);
});

function profile(filament: string, config: Readonly<Record<string, string>>): SlicerProfile {
  const preset = (value: string) => value as NonNullable<SlicerProfile['machinePresetId']>;
  return {
    id: `fixture|process|${filament}`,
    displayName: `Fixture · Process · ${filament}`,
    machineName: 'Fixture printer',
    processName: 'Fixture process',
    filamentName: filament.toUpperCase(),
    machinePresetId: preset('preset:machine:fixture'),
    processPresetId: preset('preset:process:fixture'),
    filamentPresetId: preset(`preset:filament:${filament}`),
    config: { ...config },
  };
}

test('an imported project attests from its own embedded configuration', () => {
  const authored = (config: Readonly<Record<string, string>>, id: string): SlicerProfile => ({
    id,
    displayName: id,
    machineName: 'Imported printer',
    processName: 'Imported process',
    filamentName: id,
    config: { ...config },
  });
  const derived = deriveLiveProfilePreflightConstraints({
    source: 'authored-project',
    primaryProfile: authored(
      { printable_area: '0x0,220x0,220x220,0x220', printable_height: '250', nozzle_diameter: '0.4,0.4' },
      'authored-project',
    ),
    filamentProfiles: [
      authored(
        { filament_type: 'PLA', nozzle_temperature_range_low: '190', nozzle_temperature_range_high: '240' },
        'authored-filament-1',
      ),
      authored(
        { filament_type: 'PETG', nozzle_temperature_range_low: '220', nozzle_temperature_range_high: '260' },
        'authored-filament-2',
      ),
    ],
    toolCount: 2,
  });
  assert.deepEqual(derived.blockingDiagnostics, [], 'no catalog preset is required to slice as authored');
  assert.equal(derived.constraints.tools?.[0]?.nozzleDiameterMm, 0.4);
  assert.deepEqual(derived.constraints.tools?.[1]?.supportedMaterials, ['PETG']);
  assert.equal(derived.constraints.tools?.[0]?.maxHotendTemperatureC, 240);

  const missing = deriveLiveProfilePreflightConstraints({
    source: 'authored-project',
    primaryProfile: authored(
      { printable_area: '0x0,220x0,220x220,0x220', printable_height: '250', nozzle_diameter: '0.4' },
      'authored-project',
    ),
    filamentProfiles: [undefined],
    toolCount: 1,
  });
  assert.equal(missing.blockingDiagnostics.length, 1);
  assert.equal(missing.blockingDiagnostics[0].code, 'missing-exact-filament-profile');
  assert.match(missing.blockingDiagnostics[0].message, /embedded filament configuration/i);

  const multiToolSingleNozzle = deriveLiveProfilePreflightConstraints({
    source: 'authored-project',
    primaryProfile: authored(
      { printable_area: '0x0,256x0,256x256,0x256', printable_height: '250', nozzle_diameter: '0.4' },
      'authored-project',
    ),
    filamentProfiles: [
      authored({ filament_type: 'PLA' }, 'filament-1'),
      authored({ filament_type: 'PLA' }, 'filament-2'),
      authored({ filament_type: 'PLA' }, 'filament-3'),
      authored({ filament_type: 'PLA' }, 'filament-4'),
    ],
    toolCount: 4,
  });
  assert.deepEqual(multiToolSingleNozzle.blockingDiagnostics, []);
  assert.equal(multiToolSingleNozzle.constraints.tools?.length, 4);
  assert.ok(multiToolSingleNozzle.constraints.tools?.every((tool) => tool?.nozzleDiameterMm === 0.4));
});

console.log(`\n${passed} profile preflight constraint tests passed.`);

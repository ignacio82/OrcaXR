/**
 * Reading upstream's ZIP64 calibration archives (P8.2).
 *
 * The archive reader refused every one of these outright: "ZIP64 archives
 * exceed the supported browser envelope". The refusal was reasonable and the
 * reasoning behind it was not — these files are 150 KB. They are ZIP64 in
 * *form*, because the writer emits the records unconditionally, not in size.
 * So eight calibration workflows were blocked on geometry the reader was
 * declining to open for a reason that did not apply to it.
 *
 * What matters more than opening them is that opening them widened nothing
 * else. Every bound the reader applied before — entry count, directory extent,
 * path safety, compression method, local/central agreement, total size — is
 * applied to the ZIP64 values exactly as it was to the 32-bit ones. These
 * traces hold both halves: the real archives open, and the guards still bite.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { BbsProjectImportParser } from '../import/BbsProjectImportParser';
import * as THREE from 'three';
import { CanonicalWorkspaceController } from '../../workspace/CanonicalWorkspaceController';
import type { EntityId, IdSource } from '../domain/ids';
import type { ParsedProjectImport } from '../import/types';
import { compileCalibrationJob, createDefaultCalibrationJobRequest } from '../calibration/compiler';
import { matchFlowPatches } from '../calibration/resourceObjects';

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const PUBLIC = resolve(import.meta.dirname, '../../../public/calibration');

class SequenceIdSource implements IdSource {
  private nextNumber = 1;

  next<Kind extends string>(kind: Kind): EntityId<Kind> {
    return `import:flow-place:${kind}-${this.nextNumber++}` as EntityId<Kind>;
  }
}

const PREREQS = {
  printer: {
    id: 'printer:snapmaker-u1',
    manufacturer: 'Snapmaker',
    model: 'U1',
    bedWidthMm: 270,
    bedDepthMm: 270,
    buildHeightMm: 270,
    maxPrintSpeedMmPerS: 300,
    maxAccelerationMmPerS2: 10_000,
  },
  nozzle: { diameterMm: 0.4, minTemperatureC: 170, maxTemperatureC: 300, maxLayerHeightMm: 0.32 },
  filament: {
    id: 'filament:pla',
    name: 'PLA',
    material: 'PLA',
    minTemperatureC: 180,
    maxTemperatureC: 260,
    flowRatio: 1,
    maxVolumetricSpeedMm3PerS: 30,
    retractionLengthMm: 0.8,
  },
  process: {
    id: 'process:quality',
    layerHeightMm: 0.2,
    firstLayerHeightMm: 0.2,
    lineWidthMm: 0.45,
    outerWallSpeedMmPerS: 120,
    defaultAccelerationMmPerS2: 5_000,
    xyHoleCompensationMm: 0,
    xyContourCompensationMm: 0,
  },
  firmware: {
    flavor: 'klipper' as const,
    nozzleTemperature: true,
    pressureAdvance: true,
    inputShaping: true,
    junctionDeviation: true,
    maxInputShapingFrequencyHz: 500,
  },
};

/** Every shipped flow resource, and the pieces its plan expects. */
const ARCHIVES = [
  { file: 'flowrate-test-pass1.3mf', objects: 9 },
  { file: 'flowrate-test-pass2.3mf', objects: 10 },
  { file: 'Orca-LinearFlow.3mf', objects: 11 },
  { file: 'Orca-LinearFlow_fine.3mf', objects: 16 },
];

async function parse(file: string): Promise<{ objects: { name: string }[] }> {
  const bytes = new Uint8Array(await readFile(resolve(PUBLIC, file)));
  const parsed = await new BbsProjectImportParser().parse({
    mode: 'replace',
    bytes,
    fileName: file,
  } as never);
  const state = (parsed as { state: { plates: { objects: { name: string }[] }[] } }).state;
  return { objects: state.plates.flatMap((plate) => plate.objects) };
}

await test('every shipped calibration archive opens, with the pieces its plan expects', async () => {
  for (const archive of ARCHIVES) {
    assert.ok(existsSync(resolve(PUBLIC, archive.file)), `${archive.file} is shipped`);
    const { objects } = await parse(archive.file);
    assert.equal(objects.length, archive.objects, `${archive.file} carries ${archive.objects} pieces`);
    assert.ok(
      objects.every((object) => object.name.startsWith('flowrate_')),
      `${archive.file} pieces are named for what they print at`,
    );
  }
});

await test('a truncated ZIP64 archive is refused rather than half-read', async () => {
  const bytes = new Uint8Array(await readFile(resolve(PUBLIC, 'flowrate-test-pass1.3mf')));
  // Cutting the tail removes the end-of-central-directory records the reader
  // navigates by. Widening ZIP64 support must not have made that survivable.
  const truncated = bytes.subarray(0, bytes.byteLength - 64);
  await assert.rejects(
    new BbsProjectImportParser().parse({ mode: 'replace', bytes: truncated, fileName: 'cut.3mf' } as never),
  );
});

await test('a corrupted ZIP64 record is refused, not followed', async () => {
  const bytes = new Uint8Array(await readFile(resolve(PUBLIC, 'flowrate-test-pass1.3mf')));
  const damaged = bytes.slice();
  // Find the ZIP64 end record and break its signature. A reader that followed
  // it anyway would be taking offsets from arbitrary bytes.
  let marker = -1;
  for (let index = damaged.byteLength - 4; index >= 0; index -= 1) {
    if (
      damaged[index] === 0x50 &&
      damaged[index + 1] === 0x4b &&
      damaged[index + 2] === 0x06 &&
      damaged[index + 3] === 0x06
    ) {
      marker = index;
      break;
    }
  }
  assert.ok(marker >= 0, 'the archive has a ZIP64 end record to damage');
  damaged[marker + 3] = 0x07;
  await assert.rejects(
    new BbsProjectImportParser().parse({ mode: 'replace', bytes: damaged, fileName: 'bad.3mf' } as never),
    /ZIP64|ZIP/,
  );
});

await test('every flow archive maps onto its plan exactly, in both naming encodings', async () => {
  // The real check on the encoding rule. Integers are percentages and decimals
  // are absolute offsets — derived by reading these archives against these
  // plans, so this is what says the derivation was right. A bijection across
  // all four is a hard property: one wrong rule and some piece finds no
  // effect, or some effect finds no piece.
  const prereqs = PREREQS;
  const pairs = [
    { file: 'flowrate-test-pass1.3mf', workflow: 'flow-pass-1' },
    { file: 'flowrate-test-pass2.3mf', workflow: 'flow-pass-2' },
    { file: 'Orca-LinearFlow.3mf', workflow: 'flow-yolo' },
    { file: 'Orca-LinearFlow_fine.3mf', workflow: 'flow-yolo-perfectionist' },
  ] as const;

  for (const pair of pairs) {
    const { objects } = await parse(pair.file);
    const plan = compileCalibrationJob(createDefaultCalibrationJobRequest(pair.workflow, prereqs), {
      jobId: 'calibration:archive-match',
    });
    const mapping = matchFlowPatches(
      objects.map((object) => object.name),
      plan.effects,
    );
    assert.deepEqual(mapping.problems, [], `${pair.file} maps onto ${pair.workflow}`);
    assert.equal(mapping.matches.length, objects.length, `${pair.file} places every piece`);
    assert.equal(
      new Set(mapping.matches.map((match) => match.effect.value)).size,
      plan.effects.length,
      `${pair.file} uses every setting exactly once`,
    );
  }
});

await test('a flow calibration installs as a plate whose every patch carries its own ratio', async () => {
  // The end of the line this session has been walking: archive opens, geometry
  // verified, pieces paired, and now placed. The assertion that matters is
  // per-patch — nine patches all carrying the same ratio would satisfy any
  // count-based check and calibrate nothing.
  const workspace = CanonicalWorkspaceController.createEmpty({
    idSource: new SequenceIdSource(),
    clock: () => '2026-08-01T12:00:00.000Z',
    parent: new THREE.Scene(),
    mapping: { bedSizeMm: [270, 270] as const, worldUnitsPerMm: 0.00175 },
    projectImportParser: new BbsProjectImportParser(),
  });

  const bytes = new Uint8Array(await readFile(resolve(PUBLIC, 'flowrate-test-pass1.3mf')));
  const parsed = (await new BbsProjectImportParser().parse({
    mode: 'replace',
    bytes,
    fileName: 'flowrate-test-pass1.3mf',
  } as never)) as ParsedProjectImport;
  const plan = compileCalibrationJob(createDefaultCalibrationJobRequest('flow-pass-1', PREREQS), {
    jobId: 'calibration:flow-place',
  });

  const result = workspace.applyFlowCalibrationResource(plan, parsed);
  assert.deepEqual(result.problems, []);
  assert.equal(result.placed, 9);

  const installed = workspace.createCanonicalSliceSource().capture().state;
  const patches = installed.plates.flatMap((plate) => plate.objects);
  assert.equal(patches.length, 9, 'the plate is the calibration now');

  const ratios = new Map<string, string>();
  for (const patch of patches) {
    const ratio = (patch.config as Record<string, string>).print_flow_ratio;
    assert.ok(ratio, `${patch.name} carries a flow ratio`);
    ratios.set(patch.name, ratio);
  }
  assert.equal(new Set(ratios.values()).size, 9, 'nine distinct ratios, not one repeated nine times');
  // And the specific pairing, since distinctness alone would survive a shuffle.
  assert.equal(ratios.get('flowrate_0'), '1');
  assert.equal(ratios.get('flowrate_m20'), '0.8');
  assert.equal(ratios.get('flowrate_20'), '1.2');
});

await test('a plate that does not pair installs nothing at all', async () => {
  const workspace = CanonicalWorkspaceController.createEmpty({
    idSource: new SequenceIdSource(),
    clock: () => '2026-08-01T12:00:00.000Z',
    parent: new THREE.Scene(),
    mapping: { bedSizeMm: [270, 270] as const, worldUnitsPerMm: 0.00175 },
    projectImportParser: new BbsProjectImportParser(),
  });
  const bytes = new Uint8Array(await readFile(resolve(PUBLIC, 'flowrate-test-pass1.3mf')));
  const parsed = (await new BbsProjectImportParser().parse({
    mode: 'replace',
    bytes,
    fileName: 'flowrate-test-pass1.3mf',
  } as never)) as ParsedProjectImport;
  // pass-2's plan against pass-1's plate: the ratios do not line up.
  const wrongPlan = compileCalibrationJob(createDefaultCalibrationJobRequest('flow-pass-2', PREREQS), {
    jobId: 'calibration:flow-mismatch',
  });

  const result = workspace.applyFlowCalibrationResource(wrongPlan, parsed);
  assert.ok(result.problems.length > 0, 'a mismatch is reported');
  assert.equal(result.placed, 0);
  const state = workspace.createCanonicalSliceSource().capture().state;
  assert.deepEqual(
    state.plates.flatMap((plate) => plate.objects),
    [],
    'and nothing was installed',
  );
});

console.log(`\nZIP64 calibration archives: ${passed} tests passed.`);

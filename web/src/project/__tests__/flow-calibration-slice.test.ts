/**
 * Does a placed flow plate actually print at different ratios? (P8.2)
 *
 * The plate installs with nine patches carrying nine distinct
 * `print_flow_ratio` values, and that is a canonical fact. This session has
 * been taught four times over what a canonical fact is worth on its own: a
 * range-scoped `nozzle_temperature` looked identical in the project and did
 * nothing whatsoever in the print. Per-object config is a different scope
 * again, so it gets asked rather than assumed.
 *
 * The question cannot be answered by slicing once. A plate where every patch
 * silently printed at 1.0 would slice, produce G-code, and report a perfectly
 * ordinary filament total. So the same plate is sliced twice — once with the
 * calibration's ratios, once with every patch flattened to 1.0 — and the two
 * runs must differ. Flow ratio scales extrusion, so if it reaches the toolpaths
 * at all, the filament totals cannot match.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as THREE from 'three';

import { BbsProjectImportParser } from '../import/BbsProjectImportParser';
import { Bbs3mfProjectSerializer } from '../serialization/Bbs3mfProjectSerializer';
import { CanonicalWorkspaceController } from '../../workspace/CanonicalWorkspaceController';
import { compileCalibrationJob, createDefaultCalibrationJobRequest } from '../calibration/compiler';
import { baseSliceConfig, filamentUsedMm, sliceArchive } from './sliceHarness';
import type { EntityId, IdSource } from '../domain/ids';
import type { CalibrationJobPrerequisites } from '../calibration/types';
import type { ParsedProjectImport } from '../import/types';

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

class SequenceIdSource implements IdSource {
  private nextNumber = 1;

  next<Kind extends string>(kind: Kind): EntityId<Kind> {
    return `import:flow-slice:${kind}-${this.nextNumber++}` as EntityId<Kind>;
  }
}

const PREREQS: CalibrationJobPrerequisites = {
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
    flavor: 'klipper',
    nozzleTemperature: true,
    pressureAdvance: true,
    inputShaping: true,
    junctionDeviation: true,
    maxInputShapingFrequencyHz: 500,
  },
};

function controller(): CanonicalWorkspaceController {
  return CanonicalWorkspaceController.createEmpty({
    idSource: new SequenceIdSource(),
    clock: () => '2026-08-01T12:00:00.000Z',
    parent: new THREE.Scene(),
    mapping: { bedSizeMm: [270, 270] as const, worldUnitsPerMm: 0.00175 },
    projectImportParser: new BbsProjectImportParser(),
  });
}

/** Serialize what a controller holds, with a real profile behind it. */
async function archiveOf(workspace: CanonicalWorkspaceController, flatten: boolean): Promise<Uint8Array> {
  const snapshot = workspace.createCanonicalSliceSource().capture();
  const base = await baseSliceConfig();
  const state = {
    ...snapshot.state,
    settingsBaseConfig: { ...base },
    config: { ...base, ...(snapshot.state.settingsOverrides ?? {}) },
    plates: snapshot.state.plates.map((plate) => ({
      ...plate,
      objects: plate.objects.map((object) => ({
        ...object,
        config: flatten ? { ...(object.config as Record<string, string>), print_flow_ratio: '1' } : object.config,
      })),
    })),
  } as typeof snapshot.state;
  return (
    await new Bbs3mfProjectSerializer().serialize({
      state,
      assets: snapshot.assets,
      sourceRevision: 1,
      sourceHash: 'flow-calibration-slice',
    })
  ).bytes;
}

await test('a placed flow plate prints its patches at different ratios, not all at one', async () => {
  const workspace = controller();
  const bytes = new Uint8Array(
    await readFile(resolve(import.meta.dirname, '../../../public/calibration/flowrate-test-pass1.3mf')),
  );
  const parsed = (await new BbsProjectImportParser().parse({
    mode: 'replace',
    bytes,
    fileName: 'flowrate-test-pass1.3mf',
  } as never)) as ParsedProjectImport;
  const plan = compileCalibrationJob(createDefaultCalibrationJobRequest('flow-pass-1', PREREQS), {
    jobId: 'calibration:flow-slice',
  });

  const placed = workspace.applyFlowCalibrationResource(plan, parsed);
  assert.deepEqual(placed.problems, []);
  assert.equal(placed.placed, 9);

  const swept = await sliceArchive(await archiveOf(workspace, false), 'flow-swept');
  const flat = await sliceArchive(await archiveOf(workspace, true), 'flow-flat');

  const sweptFilament = filamentUsedMm(swept);
  const flatFilament = filamentUsedMm(flat);
  // Flow ratio scales extrusion. If the per-object setting reached the
  // toolpaths, nine patches at 0.8 … 1.2 cannot use the same filament as nine
  // patches at 1.0; if it were inert, these two numbers would be identical and
  // the calibration would be a plate of nine identical squares.
  assert.notEqual(
    sweptFilament,
    flatFilament,
    `the swept plate must not extrude exactly what a flat one does (both ${sweptFilament} mm)`,
  );
});

console.log(`\nFlow calibration slicing: ${passed} tests passed.`);

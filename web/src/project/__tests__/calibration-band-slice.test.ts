/**
 * Do calibration bands reach the print? (P8.2)
 *
 * `applyCalibrationPlan` installs a compiled plan's effects into the canonical
 * project. That the layer ranges and events exist is an archive fact, and this
 * repository has twice learned what an archive fact is worth: the brim-ear and
 * plate-override bugs both passed every archive assertion while producing
 * nothing in the print. So this asks the engine.
 *
 * It found two things the archive could not. A range-scoped
 * `nozzle_temperature` does not change the print — it is a filament option and
 * the region-config path does not apply it — so a tower installed that way is
 * one temperature end to end, which looks like a working calibration until it
 * is measured and teaches the operator the wrong number. And a layer range
 * whose config omits `layer_height` **crashes the pinned engine outright**.
 */

import assert from 'node:assert/strict';

import { buildSliceArchive, sliceArchive } from './sliceHarness';

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const RANGE = (index: number, minZMm: number, maxZMm: number, config: Record<string, string>) => ({
  id: `import:band:layer-range-${index}` as never,
  minZMm,
  maxZMm,
  config: config as never,
});

await test('a layer range without layer_height takes the engine down, and one with it does not', async () => {
  // The reason `applyCalibrationPlan` always writes `layer_height` into a band.
  // Pinned as a trace because it is invisible from the archive side and fatal
  // from the print side, and a future band that "only sets a temperature" would
  // otherwise reintroduce it.
  const bare = await buildSliceArchive({
    mutate: (state) => {
      for (const plate of state.plates) {
        for (const object of plate.objects) object.layerRanges = [RANGE(1, 2, 6, { nozzle_temperature: '215' })];
      }
    },
  });
  await assert.rejects(sliceArchive(bare, 'band-bare'), /memory access out of bounds|ORCAXR/);

  const guarded = await buildSliceArchive({
    mutate: (state) => {
      for (const plate of state.plates) {
        for (const object of plate.objects) {
          object.layerRanges = [RANGE(1, 2, 6, { layer_height: '0.2', nozzle_temperature: '215' })];
        }
      }
    },
  });
  const gcode = await sliceArchive(guarded, 'band-guarded');
  assert.ok(gcode.includes('G1'), 'the same range with a layer height slices');
});

await test('a band’s temperature reaches the program through its custom G-code, not its override', async () => {
  // The base band is the project's own starting temperature, not an event: a
  // layer event at the plate is refused, because there is no layer below it to
  // change at. Only the bands above it are changes.
  const BANDS = [
    { topZMm: 6, temperature: 215 },
    { topZMm: 12, temperature: 200 },
  ];

  const archive = await buildSliceArchive({
    config: { nozzle_temperature: '230', nozzle_temperature_initial_layer: '230' },
    mutate: (state) => {
      state.customGcode = BANDS.map((band, index) => ({
        id: `import:band:custom-gcode-${index + 1}` as never,
        scope: 'plate',
        plateId: state.plates[0].id,
        trigger: 'before-layer',
        code: `M104 S${band.temperature}\n`,
        layerEvent: { type: 'custom', topZMm: band.topZMm },
      })) as never;
    },
  });

  const gcode = await sliceArchive(archive, 'band-events');
  for (const band of BANDS) {
    assert.ok(
      new RegExp(`^M104 S${band.temperature}\\b`, 'm').test(gcode),
      `band at ${band.topZMm} mm commands ${band.temperature}; a tower that commands one temperature is not a tower`,
    );
  }
  // Not just present — distinct. Three bands that all print at the project
  // temperature would satisfy a weaker check and calibrate nothing.
  const commanded = new Set([...gcode.matchAll(/^M104 S(\d+)/gm)].map((match) => match[1]));
  assert.ok(commanded.size > BANDS.length, `the program commands distinct temperatures, not one: ${[...commanded]}`);
});

console.log(`\nCalibration band slicing: ${passed} tests passed.`);

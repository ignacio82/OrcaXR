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

import { buildSliceArchive, filamentUsedMm, sliceArchive } from './sliceHarness';

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

await test('a range-scoped wall speed does change the print, unlike a range-scoped temperature', async () => {
  // The families that install with no custom G-code — max-volumetric-speed and
  // vfa — rely entirely on `outer_wall_speed` in a layer range. Range-scoped
  // `nozzle_temperature` turned out to be inert, so this cannot be assumed:
  // if speed were inert too, both workflows would install cleanly and measure
  // nothing.
  const bandSpeed = 15;
  const baseSpeed = 120;
  const archive = await buildSliceArchive({
    config: { outer_wall_speed: String(baseSpeed) },
    mutate: (state) => {
      for (const plate of state.plates) {
        for (const object of plate.objects) {
          object.layerRanges = [RANGE(1, 6, 12, { layer_height: '0.2', outer_wall_speed: String(bandSpeed) })];
        }
      }
    },
  });

  const gcode = await sliceArchive(archive, 'band-speed');
  // Feedrates are mm/min in the program and mm/s in the config.
  const feedrates = new Set(
    [...gcode.matchAll(/^G1 [^\n]*\bF([\d.]+)/gm)].map((match) => Math.round(Number(match[1]) / 60)),
  );
  assert.ok(
    feedrates.has(bandSpeed),
    `the banded wall speed appears in the program; it commanded ${[...feedrates].sort((a, b) => a - b).join(', ')} mm/s`,
  );
});

await test('printer-specific band commands survive into the program verbatim', async () => {
  // The pressure-advance, junction-deviation and input-shaping families each
  // emit a different command through the same layer-event channel. The channel
  // is proven for M104; these are not M104, and a G-code writer that filtered
  // unknown commands would drop them silently.
  const COMMANDS = [
    { topZMm: 4, code: 'SET_PRESSURE_ADVANCE ADVANCE=0.035\n' },
    { topZMm: 8, code: 'M205 J0.012\n' },
    { topZMm: 12, code: 'SET_INPUT_SHAPER SHAPER_FREQ_X=42.5\n' },
  ];
  const archive = await buildSliceArchive({
    mutate: (state) => {
      state.customGcode = COMMANDS.map((command, index) => ({
        id: `import:band:custom-gcode-${index + 1}` as never,
        scope: 'plate',
        plateId: state.plates[0].id,
        trigger: 'before-layer',
        code: command.code,
        layerEvent: { type: 'custom', topZMm: command.topZMm },
      })) as never;
    },
  });

  const gcode = await sliceArchive(archive, 'band-commands');
  for (const command of COMMANDS) {
    const literal = command.code.trim();
    assert.ok(
      gcode.includes(literal),
      `${literal.split(' ')[0]} reaches the program unchanged; a filtered command would calibrate nothing`,
    );
  }
});

await test('a range-scoped retraction length changes the print, so a retraction tower is a tower', async () => {
  // The third answer at this boundary, and the three do not agree: a
  // range-scoped `nozzle_temperature` is inert, `outer_wall_speed` works, and
  // this decides retraction. It matters because `retraction-tower` emits only a
  // *comment* as its custom G-code — if the range were inert too, the whole
  // workflow would have no mechanism at all and its refusal would be permanent.
  const config = { retraction_length: '0.8' };
  const plain = await sliceArchive(await buildSliceArchive({ config }), 'retraction-plain');
  const banded = await sliceArchive(
    await buildSliceArchive({
      config,
      mutate: (state) => {
        for (const plate of state.plates) {
          for (const object of plate.objects) {
            object.layerRanges = [RANGE(1, 4, 10, { layer_height: '0.2', retraction_length: '5' })];
          }
        }
      },
    }),
    'retraction-banded',
  );

  // Retraction pulls filament back and pushes it out again, so a band retracting
  // 5 mm where the rest retracts 0.8 mm cannot use the same filament.
  assert.notEqual(
    filamentUsedMm(plain),
    filamentUsedMm(banded),
    `a banded retraction length must change the program (both ${filamentUsedMm(plain)} mm)`,
  );
});

console.log(`\nCalibration band slicing: ${passed} tests passed.`);

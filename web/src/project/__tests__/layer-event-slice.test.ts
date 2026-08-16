/**
 * An authored pause reaches the sliced program (P7.8, P7.1).
 *
 * The browser suite already proves this end to end, but only as part of a
 * fifteen-step workflow — it says the app works, not what the engine does with
 * one authored event. This is the headless oracle, and it is the last row of
 * the engine-visible inventory that was not blocked on other work.
 *
 * The route is the one the WASM entry point documents: per-plate custom G-code
 * rides in `model.plates_custom_gcodes` and the G-code writer reads it through
 * `get_curr_plate_custom_gcodes()`, so nothing has to copy it across — which is
 * exactly the kind of "rides along" claim that turned out to be false for plate
 * settings, and so is worth checking rather than trusting.
 */

import assert from 'node:assert/strict';

import { buildSliceArchive, sliceArchive } from './sliceHarness';

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const PAUSE_Z_MM = 4;

/** The Z of every layer change, in order, as the program reports them. */
function layerZs(gcode: string): number[] {
  const zs: number[] = [];
  for (const line of gcode.split('\n')) {
    const match = /^G1 Z([\d.]+)/.exec(line);
    if (!match) continue;
    const z = Number.parseFloat(match[1]);
    if (Number.isFinite(z) && zs.at(-1) !== z) zs.push(z);
  }
  return zs;
}

await test('a pause authored at a height appears in the program at that height', async () => {
  const plain = await sliceArchive(await buildSliceArchive(), 'event-plain');
  const paused = await sliceArchive(
    await buildSliceArchive({
      mutate: (state) => {
        state.customGcode = [
          {
            // A stable entity id, because the canonical validator refuses an
            // invented one — and it is right to.
            id: '4f1a0c62-2f6a-4e2f-9a1d-0d6b7c2f5e11' as never,
            scope: 'plate',
            plateId: state.plates[0].id,
            trigger: 'before-layer',
            // A pause carries no G-code of its own: the canonical validator
            // reserves that for a `custom` event, and the printer profile
            // supplies the command — `machine_pause_gcode`, M600 here.
            code: '',
            layerEvent: { type: 'pause', topZMm: PAUSE_Z_MM, message: 'insert magnet' },
          },
        ];
      },
    }),
    'event-paused',
  );

  assert.equal(/^M600\b/m.test(plain), false, 'nothing pauses a project that authored no pause');
  assert.equal(/^M600\b/m.test(paused), true, 'the authored pause reaches the program');

  // It has to land at the height it was authored at, not merely exist: a pause
  // in the wrong layer is worse than none, because the operator acts on it.
  const lines = paused.split('\n');
  const pauseIndex = lines.findIndex((line) => /^M600\b/.test(line));
  assert.ok(pauseIndex > 0);
  let zAtPause = 0;
  for (let index = 0; index < pauseIndex; index += 1) {
    const match = /^G1 Z([\d.]+)/.exec(lines[index]);
    if (match) zAtPause = Number.parseFloat(match[1]);
  }
  assert.ok(
    Math.abs(zAtPause - PAUSE_Z_MM) <= 0.4,
    `the pause sits at the authored height: ${zAtPause} mm against ${PAUSE_Z_MM} mm`,
  );

  // And it changes nothing else about the print.
  assert.deepEqual(layerZs(paused).length, layerZs(plain).length, 'a pause does not add or remove layers');
});

console.log(`\nLayer event slicing: ${passed} tests passed.`);

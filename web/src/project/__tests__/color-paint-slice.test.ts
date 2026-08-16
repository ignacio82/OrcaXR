/**
 * Painted colour reaches the engine (P4.3, P7.1).
 *
 * The last facet-paint channel without a headless oracle. The browser suite
 * slices a multicolour plate end to end, but that proves the whole app rather
 * than this one claim, and it cannot say what the engine did with a specific
 * painted facet.
 *
 * The gate is read from the pinned source, per the rule the earlier fixtures
 * earned: `PrintObjectSlice.cpp:176` runs multi-material segmentation only when
 * `num_extruders > 1` *and* some volume is painted. Both halves are exercised
 * here, but not naively: this fixture already assigns filaments per object, so
 * it changes tools with no paint at all. Asserting "no tool changes unpainted"
 * would have been a claim about the fixture, so what is measured is the tool
 * changes the paint *adds* to the very same project.
 */

import assert from 'node:assert/strict';

import { CUBE_FACES, buildSliceArchive, sliceArchive } from './sliceHarness';

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** Explicit tool selections, which only appear when the print changes filament. */
function toolChanges(gcode: string): number {
  return (gcode.match(/^T\d+\s*$/gm) ?? []).length;
}

await test('a facet painted with a second filament makes the print change tools', async () => {
  const plain = await sliceArchive(await buildSliceArchive(), 'color-plain');
  const painted = await sliceArchive(
    await buildSliceArchive({
      // The filament id has to come from the state being sliced, not from a
      // literal: a colour annotation naming an unknown filament is not a
      // weaker test, it is a different one.
      mutate: (state) => {
        const second = state.filaments.physical[1];
        assert.ok(second, 'the fixture has a second physical filament to paint with');
        for (const plate of state.plates) {
          for (const object of plate.objects) {
            for (const volume of object.volumes) {
              volume.annotations = {
                ...volume.annotations,
                color: [{ triangles: [...CUBE_FACES.top], value: second.id }],
              };
            }
          }
        }
      },
    }),
    'color-painted',
  );

  // The baseline is not zero: this fixture already assigns filaments per
  // object, so the print changes tools without any paint at all. Asserting
  // "no tool changes unpainted" would have been a claim about the fixture —
  // the honest comparison is what the paint *adds* to the same project.
  assert.ok(toolChanges(plain) > 0, 'the fixture already prints with more than one filament');
  assert.ok(
    toolChanges(painted) > toolChanges(plain),
    `a painted facet must add tool changes: ${toolChanges(painted)} vs ${toolChanges(plain)}`,
  );
});

console.log(`\nColour paint slicing: ${passed} tests passed.`);

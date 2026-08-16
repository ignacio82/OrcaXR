/**
 * Painted fuzzy skin reaches the engine (P4.8, P7.1).
 *
 * Same class as the brim ears and the support paint: written into the model as
 * a `paint_fuzzy_skin` triangle attribute, round-tripped through the archive,
 * and never once put to the slicer.
 *
 * The gate is read from the pinned source rather than guessed, which is the
 * rule the earlier fixtures earned. Fuzzy skin needs *no* global setting here:
 * `PrintObjectSlice.cpp:5291` runs the segmentation whenever
 * `is_fuzzy_skin_painted()` holds, and `PrintApply.cpp:1108` forces the painted
 * region's config to `FuzzySkinType::All` whatever the project asked for. So a
 * project with `fuzzy_skin = none` is exactly the right baseline: any fuzz in
 * the output came from the paint and nothing else.
 *
 * Fuzz is measured by counting extrusion moves rather than material. Jitter
 * displaces a wall without lengthening it much, so filament totals barely
 * move, while the number of segments a wall is broken into changes sharply.
 */

import assert from 'node:assert/strict';

import { CUBE_FACES, buildSliceArchive, sliceArchive } from './sliceHarness';

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** Extruding moves — the count rises sharply when a wall is fuzzified. */
function extrusionMoves(gcode: string): number {
  return (gcode.match(/^G1 (?=.*\sE-?[\d.]+)/gm) ?? []).length;
}

await test('a painted wall is fuzzified even when the project asks for no fuzz', async () => {
  const config = { fuzzy_skin: 'none' };
  const plain = await sliceArchive(await buildSliceArchive({ config }), 'fuzzy-plain');
  const painted = await sliceArchive(
    await buildSliceArchive({
      config,
      annotations: (empty) => ({
        ...empty,
        fuzzySkin: [{ triangles: [...CUBE_FACES.frontY0], value: true }],
      }),
    }),
    'fuzzy-painted',
  );

  const plainMoves = extrusionMoves(plain);
  const paintedMoves = extrusionMoves(painted);
  assert.ok(plainMoves > 0, 'the plain run extrudes');
  assert.ok(
    paintedMoves > plainMoves * 1.2,
    `a fuzzified wall is broken into many more segments: ${paintedMoves} vs ${plainMoves}`,
  );
});

await test('painting nothing leaves the print exactly as it was', async () => {
  // The channel must be inert when empty, or the comparison above would be
  // measuring the act of carrying an annotation rather than its content.
  const config = { fuzzy_skin: 'none' };
  const plain = await sliceArchive(await buildSliceArchive({ config }), 'fuzzy-plain-a');
  const emptyPaint = await sliceArchive(
    await buildSliceArchive({ config, annotations: (empty) => ({ ...empty, fuzzySkin: [] }) }),
    'fuzzy-plain-b',
  );
  assert.equal(extrusionMoves(emptyPaint), extrusionMoves(plain));
});

console.log(`\nFuzzy paint slicing: ${passed} tests passed.`);

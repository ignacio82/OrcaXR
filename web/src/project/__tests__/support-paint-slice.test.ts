/**
 * Painted support enforcers reach the engine (P4.6, P7.1).
 *
 * Next claim in the archive-only class the brim-ear bug came out of: support
 * paint is written into the model as a `paint_supports` triangle attribute, the
 * archive round-trips, and until now nothing asked the slicer whether it
 * generated any support because of it.
 *
 * Two things are read rather than guessed, which is the lesson from brim ears.
 * The config gate: `support_type = normal(manual)` is documented in
 * `PrintConfig.cpp:5183` as "only support enforcers are generated". And the
 * geometry: support goes *under* an overhang, so a plain cube has nothing to
 * support and an enforcer on its wall would correctly produce nothing — a first
 * attempt did exactly that and looked like a bug. The solid is lifted off the
 * shape is a cantilever instead — a base on the bed and an arm jutting out
 * above it — because a lifted cube is not an overhang but a floating object,
 * and the engine rightly refuses to slice one at all.
 */

import assert from 'node:assert/strict';

import { buildSliceArchive, cantileverMesh, filamentUsedMm, sliceArchive } from './sliceHarness';

const ARM_BOTTOM = [...cantileverMesh().armBottom];

/**
 * Orca labels this `;TYPE:Support`, not `;TYPE:Support material`. Matching the
 * wrong string reads as "no support was generated" on a run that generated
 * plenty, which is indistinguishable from a real bug — so the marker is pinned
 * here once rather than spelled out at each call site.
 */
const hasSupport = (gcode: string): boolean => /^;TYPE:Support\b/m.test(gcode);

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** Enforcers only: a plain solid gets support from paint or not at all. */
const ENFORCER_ONLY = Object.freeze({
  enable_support: '1',
  support_type: 'normal(manual)',
});

await test('a painted enforcer reaches the engine and raises support', async () => {
  const bare = await sliceArchive(await buildSliceArchive({ config: ENFORCER_ONLY, cantilever: true }), 'support-bare');
  assert.equal(hasSupport(bare), false, 'an unpainted overhang gets no support when only enforcers may generate it');

  const painted = await sliceArchive(
    await buildSliceArchive({
      config: ENFORCER_ONLY,
      cantilever: true,
      annotations: (empty) => ({
        ...empty,
        support: [{ triangles: ARM_BOTTOM, value: 'enforce' }],
      }),
    }),
    'support-painted',
  );

  assert.equal(hasSupport(painted), true, 'the painted enforcer reaches the engine and raises support');
  assert.ok(
    filamentUsedMm(painted) > filamentUsedMm(bare),
    `support is extra material: ${filamentUsedMm(painted)} vs ${filamentUsedMm(bare)}`,
  );
});

await test('a blocker on the same facets raises none', async () => {
  const enforced = await sliceArchive(
    await buildSliceArchive({
      config: ENFORCER_ONLY,
      cantilever: true,
      annotations: (empty) => ({
        ...empty,
        support: [{ triangles: ARM_BOTTOM, value: 'enforce' }],
      }),
    }),
    'support-enforced',
  );
  // The same wall marked both ways: a blocker on the enforced facets must win,
  // or the two channels are not really distinguished in the archive.
  const blocked = await sliceArchive(
    await buildSliceArchive({
      config: ENFORCER_ONLY,
      cantilever: true,
      annotations: (empty) => ({
        ...empty,
        support: [{ triangles: ARM_BOTTOM, value: 'block' }],
      }),
    }),
    'support-blocked',
  );

  assert.equal(hasSupport(blocked), false, 'a blocked underside raises none');
  assert.ok(
    filamentUsedMm(enforced) > filamentUsedMm(blocked),
    `the enforced run is the one carrying support: ${filamentUsedMm(enforced)} vs ${filamentUsedMm(blocked)}`,
  );
});

console.log(`\nSupport paint slicing: ${passed} tests passed.`);

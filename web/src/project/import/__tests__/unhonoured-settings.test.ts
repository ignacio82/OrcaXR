/**
 * A setting we preserve but do not apply must not arrive silently (P5.3.3, P5.3.4).
 *
 * `use_surface` and `per_glyph` round-trip faithfully and change nothing.
 * Preserving them is right: dropping a setting silently loses someone's work.
 * But arriving with one and saying nothing is its own silent divergence — the
 * operator opens a project whose text is projected onto a curved surface, gets
 * a flat extrusion, and has nothing telling them the geometry is not what the
 * file describes.
 */

import assert from 'node:assert/strict';

import { BbsProjectImportParser } from '../BbsProjectImportParser';
import { Bbs3mfProjectSerializer } from '../../serialization/Bbs3mfProjectSerializer';
import { createProjectFixture } from '../../__tests__/fixtures';
import { cloneProjectState, projectFingerprint } from '../../domain/canonical';

let passed = 0;
async function test(name: string, run: () => Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** Serialize a fixture, optionally with an unhonoured flag set on a volume. */
async function archive(mutate?: (state: ReturnType<typeof cloneProjectState>) => void): Promise<Uint8Array> {
  const fixture = createProjectFixture();
  const state = cloneProjectState(fixture.state);
  mutate?.(state);
  return (
    await new Bbs3mfProjectSerializer().serialize({
      state,
      assets: [{ descriptor: fixture.asset.descriptor, bytes: fixture.asset.bytes }],
      sourceRevision: 1,
      sourceHash: projectFingerprint(state),
    })
  ).bytes;
}

async function diagnosticsFor(bytes: Uint8Array): Promise<readonly { code: string; message: string }[]> {
  const parsed = await new BbsProjectImportParser().parse({
    mode: 'replace',
    bytes,
    fileName: 'project.3mf',
  } as never);
  return (parsed.diagnostics ?? []) as readonly { code: string; message: string }[];
}

await test('an ordinary project imports with no unhonoured-setting warning', async () => {
  // The control. If this fired on every import the warning would be noise and
  // an operator would learn to ignore the one that matters.
  const diagnostics = await diagnosticsFor(await archive());
  assert.equal(
    diagnostics.some((entry) => entry.code.startsWith('unhonoured-')),
    false,
  );
});

await test('a project that projects onto the surface says the geometry will differ', async () => {
  const bytes = await archive((state) => {
    for (const plate of state.plates) {
      for (const object of plate.objects) {
        for (const volume of object.volumes) {
          (volume as unknown as { svg?: unknown }).svg = { depthMm: 1, useSurface: true };
        }
      }
    }
  });
  const diagnostics = await diagnosticsFor(bytes);
  const notice = diagnostics.find((entry) => entry.code === 'unhonoured-use_surface');
  assert.ok(notice, 'the operator is told, rather than finding out from the print');
  assert.match(notice.message, /extrudes flat/);
  assert.match(notice.message, /differs from what the file describes/);
});

await test('the warning describes the divergence, not the missing feature', async () => {
  // "use_surface is unsupported" tells an operator about our roadmap. What they
  // need to know is that the model in front of them is not the model in the
  // file they opened.
  const bytes = await archive((state) => {
    for (const plate of state.plates) {
      for (const object of plate.objects) {
        for (const volume of object.volumes) {
          (volume as unknown as { svg?: unknown }).svg = { depthMm: 1, useSurface: true };
        }
      }
    }
  });
  const notice = (await diagnosticsFor(bytes)).find((entry) => entry.code === 'unhonoured-use_surface');
  assert.ok(notice);
  assert.doesNotMatch(notice.message, /unsupported|not implemented|roadmap/i);
});

console.log(`\nUnhonoured settings: ${passed} tests passed.`);

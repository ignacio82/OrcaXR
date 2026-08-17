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
import { buildEmbossedMesh, DEFAULT_EMBOSS_FONT_PROPERTY } from '../../objects/emboss';
import type { EmbossTextConfiguration, GlyphOutline, GlyphOutlineSource } from '../../objects/emboss';

/** A single square glyph, enough to produce a mesh worth comparing. */
const SQUARE_GLYPH: GlyphOutline = {
  advance: 1000,
  contours: [
    {
      points: [
        [0, 0],
        [1000, 0],
        [1000, 1000],
        [0, 1000],
      ],
    },
  ],
};

function squareFont(): GlyphOutlineSource {
  return { unitsPerEm: 1000, outline: () => SQUARE_GLYPH };
}

function embossConfiguration(overrides: Partial<EmbossTextConfiguration> = {}): EmbossTextConfiguration {
  return {
    text: 'A',
    styleName: 'Test',
    fontDescriptor: 'test-descriptor',
    fontDescriptorType: 'test',
    font: DEFAULT_EMBOSS_FONT_PROPERTY,
    projection: { depthMm: 1, useSurface: false },
    ...overrides,
  };
}

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

/**
 * The pairing that was unenforced until now.
 *
 * The warning list is maintained by hand, so implementing one of these settings
 * without removing its entry would leave the app telling operators their
 * geometry diverges when it no longer does — a lie that is harder to notice
 * than the original silence, because it looks like diligence.
 *
 * This checks the list against *behaviour* rather than intent: while a setting
 * genuinely changes nothing, the warning is honest. The moment someone makes it
 * change something, this fails and the entry has to go with it.
 */
await test('every warned setting really does change nothing, or the warning has become a lie', async () => {
  const flat = buildEmbossedMesh(embossConfiguration({ projection: { depthMm: 1, useSurface: false } }), squareFont());
  const projected = buildEmbossedMesh(
    embossConfiguration({ projection: { depthMm: 1, useSurface: true } }),
    squareFont(),
  );
  assert.deepEqual(
    projected.positions,
    flat.positions,
    'use_surface still produces identical geometry — remove it from UNHONOURED_SETTINGS once it does not',
  );
  assert.deepEqual(projected.indices, flat.indices);
});

console.log(`\nUnhonoured settings: ${passed} tests passed.`);

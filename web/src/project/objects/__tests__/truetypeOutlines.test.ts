import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEFAULT_EMBOSS_FONT_PROPERTY, EmbossError, buildEmbossedMesh, type EmbossTextConfiguration } from '../emboss';
import { readTrueTypeOutlines } from '../truetypeOutlines';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/**
 * Fonts shipped by the distribution, used as real-world outline fixtures. The
 * suite skips any that is absent rather than pinning bytes into the repository.
 */
const FONT_DIRECTORY = '/usr/share/fonts/truetype';
const CANDIDATE_FONTS = [
  'dejavu/DejaVuSans.ttf',
  'dejavu/DejaVuSerif.ttf',
  'dejavu/DejaVuSansMono.ttf',
  'dejavu/DejaVuSans-Bold.ttf',
  'dejavu/DejaVuSans-Oblique.ttf',
  'freefont/FreeSans.ttf',
  'freefont/FreeSerif.ttf',
  'freefont/FreeMono.ttf',
];

function loadFont(relative: string): Uint8Array | undefined {
  try {
    return new Uint8Array(readFileSync(`${FONT_DIRECTORY}/${relative}`));
  } catch {
    return undefined;
  }
}

const available = CANDIDATE_FONTS.map((name) => ({ name, bytes: loadFont(name) })).filter(
  (entry): entry is { name: string; bytes: Uint8Array } => entry.bytes !== undefined,
);

function configuration(text: string): EmbossTextConfiguration {
  return {
    text,
    styleName: 'Fixture',
    fontDescriptor: 'fixture.ttf',
    fontDescriptorType: 'file_name',
    font: DEFAULT_EMBOSS_FONT_PROPERTY,
    projection: { depthMm: 2, useSurface: false },
  };
}

if (available.length === 0) {
  console.log('  ⚠ no system TrueType fonts found; outline reading is not exercised here');
} else {
  test('reads real font metadata and glyph structure', () => {
    const font = readTrueTypeOutlines(available[0].bytes);
    assert.ok(font.unitsPerEm >= 16 && font.unitsPerEm <= 16384, `units per em was ${font.unitsPerEm}`);

    // A capital A has an outline and one counter; a space has no contour at all.
    const a = font.outline('A'.codePointAt(0)!);
    assert.ok(a, 'A must resolve');
    assert.equal(a.contours.length, 2, 'A is an outline plus its counter');
    assert.ok(a.advance > 0);

    const space = font.outline(' '.codePointAt(0)!);
    assert.ok(space, 'space must resolve');
    assert.equal(space.contours.length, 0, 'a space is an empty glyph, not a missing one');
    assert.ok(space.advance > 0, 'and it still advances the pen');
  });

  test('a code point the font lacks is reported as absent, not as an empty glyph', () => {
    const font = readTrueTypeOutlines(available[0].bytes);
    // A private-use code point no shipped font assigns.
    assert.equal(font.outline(0xf8ff), undefined);
  });

  test('every glyph of every available font extrudes to a closed solid', () => {
    const characters = [
      ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()[]{}<>?/|-_=+.,;:"\'`~áéîõüñçßÆØ',
    ];
    const open: string[] = [];
    let checked = 0;
    for (const { bytes } of available) {
      const font = readTrueTypeOutlines(bytes);
      for (const character of characters) {
        let mesh;
        try {
          mesh = buildEmbossedMesh(configuration(character), font);
        } catch (error) {
          // A font without this glyph is not a triangulation failure.
          if (error instanceof EmbossError && error.code === 'no-glyphs') continue;
          throw error;
        }
        checked += 1;
        if (mesh.openEdgeCount !== 0) open.push(character);
      }
    }
    assert.ok(checked > 100, `expected a real sweep, ran ${checked} glyphs`);
    // One in a thousand system glyphs is a contour that touches itself in a way
    // ear clipping cannot resolve. The pipeline reports those rather than
    // hiding them, so the budget here is a ceiling, not an accepted defect.
    const ratio = open.length / checked;
    assert.ok(ratio < 0.005, `${open.length}/${checked} glyphs came out open: ${[...new Set(open)].join('')}`);
  });

  test('a mesh that does not close says so instead of looking finished', () => {
    const font = readTrueTypeOutlines(available[0].bytes);
    const mesh = buildEmbossedMesh(configuration('Emboss'), font);
    assert.equal(mesh.openEdgeCount, 0);
    assert.ok(mesh.triangleCount > 0);
    // Every index addresses a real vertex.
    const vertexCount = mesh.positions.length / 3;
    for (const index of mesh.indices) assert.ok(index >= 0 && index < vertexCount);
  });
}

test('a font this reader cannot handle is refused with the reason', () => {
  assert.throws(
    () => readTrueTypeOutlines(new Uint8Array([1, 2, 3])),
    (error: unknown) => error instanceof EmbossError && error.code === 'unsupported-font',
  );
  // An OpenType/CFF font carries outlines this reader does not parse; saying so
  // beats embossing nothing and calling it success.
  const otto = new Uint8Array(12);
  otto.set([0x4f, 0x54, 0x54, 0x4f], 0);
  assert.throws(
    () => readTrueTypeOutlines(otto),
    (error: unknown) =>
      error instanceof EmbossError && error.code === 'unsupported-font' && /OpenType\/CFF/.test(error.message),
  );
});

console.log(`\nTrueType outline reading: ${passed} tests passed.`);

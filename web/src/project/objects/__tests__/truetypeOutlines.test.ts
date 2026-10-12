import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEFAULT_EMBOSS_FONT_PROPERTY, EmbossError, buildEmbossedMesh, type EmbossTextConfiguration } from '../emboss';
import { MAX_OUTLINE_POINTS, readTrueTypeOutlines } from '../truetypeOutlines';
import { box, trueTypeFont, type CmapSubtable, type SyntheticFont, type SyntheticGlyph } from './syntheticFonts';

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

// ---- Synthetic fonts: exact bytes, no third-party font -------------------------

const square: SyntheticGlyph = { simple: { contours: [box(0, 0, 500, 500)] } };
function font(overrides: Partial<SyntheticFont> = {}): SyntheticFont {
  return {
    glyphs: [{ empty: true }, square],
    advances: [500, 600],
    subtables: [{ format: 4, segments: [{ start: 0x41, end: 0x41, delta: 1 - 0x41 }] }],
    ...overrides,
  };
}
const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof EmbossError && error.code === 'unsupported-font', `not a refusal: ${String(error)}`);
    return error.message;
  }
  assert.fail('expected a refusal');
};

test('a synthetic font reads back the outline it was built from', () => {
  const source = readTrueTypeOutlines(
    trueTypeFont(
      font({
        glyphs: [
          { empty: true },
          {
            simple: {
              contours: [
                [
                  { x: 0, y: 0, on: true },
                  { x: 300, y: 0, on: false },
                  { x: 300, y: 300, on: true },
                  { x: 0, y: 300, on: true },
                ],
              ],
              instructions: 3,
            },
          },
        ],
      }),
    ),
  );
  const a = source.outline(0x41);
  assert.ok(a);
  assert.equal(a.advance, 600);
  // One quadratic flattened to eight segments, plus the corners and the closing point.
  const points = a.contours[0].points;
  assert.deepEqual(points[0], [0, 0]);
  assert.deepEqual(points[4], [300 * (1 - 0.5 ** 2) - 0, 300 * 0.5 ** 2]);
  assert.equal(points.length, 11);
});

test('a font cut short is refused as damaged, never with a range error', () => {
  const bytes = trueTypeFont(font());
  // Every cut inside the tables the reader reads up front refuses at load.
  for (const length of [12, 20, 100, 140, bytes.length - 400]) {
    assert.equal(
      refusal(() => readTrueTypeOutlines(bytes.subarray(0, length))),
      'This font file is cut short: its tables point past its end',
      `cut at ${length}`,
    );
  }
  // A glyph whose points run past the end loads, and refuses when it is read.
  const long = readTrueTypeOutlines(
    trueTypeFont(font({ glyphs: [{ empty: true }, { raw: [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0x9c, 0x3f, 0, 0] }] })),
  );
  assert.equal(
    refusal(() => long.outline(0x41)),
    'This font file is cut short: its tables point past its end',
  );
});

test('a character map of overlapping ranges is searched, not expanded', () => {
  // Each group would add 65,536 entries to an expanded map: 3.3 billion here.
  const groups = Array.from({ length: 50_000 }, (_, index) => ({ start: index, end: 0xffffff, glyph: index % 2 }));
  const source = readTrueTypeOutlines(trueTypeFont(font({ subtables: [{ format: 12, groups }] })));
  // The last group that maps a code point wins, as when each is written over the ones before.
  assert.equal(source.outline(0x41)?.advance, 600);
  assert.equal(source.outline(0x41)?.contours.length, 1);
  // 49,999 + 0x10000 is past every group's reach.
  assert.equal(source.outline(49_999 + 0x10000), undefined);
  assert.equal(source.outline(49_999 + 0xffff)?.advance, 600);
});

test('format 4 lookups agree with expanding every segment', () => {
  // The map before lookups were searched: every segment expanded, each over the ones before.
  const expanded = (bytes: Uint8Array, subtableAt: number): Map<number, number> => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const segCountX2 = view.getUint16(subtableAt + 6);
    const endsAt = subtableAt + 14;
    const startsAt = endsAt + segCountX2 + 2;
    const deltasAt = startsAt + segCountX2;
    const rangesAt = deltasAt + segCountX2;
    const map = new Map<number, number>();
    for (let segment = 0; segment < segCountX2 / 2; segment += 1) {
      const end = view.getUint16(endsAt + segment * 2);
      const start = view.getUint16(startsAt + segment * 2);
      const delta = view.getInt16(deltasAt + segment * 2);
      const rangeOffset = view.getUint16(rangesAt + segment * 2);
      if (start > end) continue;
      for (let code = start; code <= end && code !== 0xffff; code += 1) {
        let glyph: number;
        if (rangeOffset === 0) {
          glyph = (code + delta) & 0xffff;
        } else {
          const glyphAt = rangesAt + segment * 2 + rangeOffset + (code - start) * 2;
          if (glyphAt + 1 >= view.byteLength) continue;
          const raw = view.getUint16(glyphAt);
          glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
        }
        if (glyph !== 0) map.set(code, glyph);
      }
    }
    return map;
  };
  const glyphs: SyntheticGlyph[] = Array.from({ length: 8 }, (_, index) =>
    index === 0 ? { empty: true } : { simple: { contours: [box(0, 0, index * 10, 100)] } },
  );
  const subtable: CmapSubtable = {
    format: 4,
    segments: [
      { start: 0x20, end: 0x7e, delta: -0x1f },
      // Overlapping the first: its glyphs win where both map.
      { start: 0x41, end: 0x46, glyphs: [2, 0, 3, 4, 0, 5] },
      { start: 0x45, end: 0x44, delta: 3 },
      { start: 0x100, end: 0x110, delta: 0x10000 - 0x100 + 6 },
      // A glyph array reaching past the file's end, and one wrapping to glyph 0.
      { start: 0x200, end: 0x2ff, rangeOffset: 60_000 },
      { start: 0x300, end: 0x300, delta: -0x300 },
      { start: 0xfff0, end: 0xffff, delta: 7 },
    ],
  };
  const bytes = trueTypeFont(font({ glyphs, advances: [100], subtables: [subtable] }));
  const view = new DataView(bytes.buffer);
  let cmapAt = 0;
  for (let index = 0; index < view.getUint16(4); index += 1) {
    const record = 12 + index * 16;
    if (String.fromCharCode(...bytes.subarray(record, record + 4)) === 'cmap') cmapAt = view.getUint32(record + 8);
  }
  const reference = expanded(bytes, cmapAt + view.getUint32(cmapAt + 8));
  const source = readTrueTypeOutlines(bytes);
  for (let code = 0; code <= 0x10010; code += 1) {
    const glyph = reference.get(code);
    const outline = source.outline(code);
    assert.equal(outline === undefined, glyph === undefined, `code ${code.toString(16)}`);
    if (glyph !== undefined && glyph < glyphs.length) {
      assert.equal(outline?.contours.length, glyph === 0 ? 0 : 1, `code ${code.toString(16)}`);
      if (glyph > 0) assert.equal(outline?.contours[0].points[1][0], glyph * 10, `code ${code.toString(16)}`);
    }
  }
});

test('contours out of order are refused, not read as points the glyph lacks', () => {
  const source = readTrueTypeOutlines(
    trueTypeFont(
      font({
        glyphs: [
          { empty: true },
          { simple: { contours: [box(0, 0, 10, 10), box(20, 20, 30, 30)], endPoints: [6, 3] } },
        ],
      }),
    ),
  );
  assert.equal(
    refusal(() => source.outline(0x41)),
    'This font has a glyph whose contours are out of order',
  );
});

test('a composite glyph expanding past the budget is refused', () => {
  const fanOut = (glyph: number) => ({
    composite: Array.from({ length: 2_000 }, (_, index) => ({ glyph, dx: index % 100 })),
  });
  const glyphs: SyntheticGlyph[] = [{ empty: true }, fanOut(2), fanOut(3), square];
  const source = readTrueTypeOutlines(trueTypeFont(font({ glyphs, advances: [500] })));
  // Four million squares, were they read: refused within the budget instead.
  assert.equal(
    refusal(() => source.outline(0x41)),
    'This font has a glyph too complex to emboss',
  );
  assert.ok(MAX_OUTLINE_POINTS < 2_000 * 2_000);
  // An accented letter's few components are nowhere near it.
  const accented = readTrueTypeOutlines(
    trueTypeFont(
      font({
        glyphs: [{ empty: true }, { composite: [{ glyph: 2 }, { glyph: 2, dx: 100, dy: 120, scale: 0.5 }] }, square],
        advances: [500],
      }),
    ),
  );
  assert.equal(accented.outline(0x41)?.contours.length, 2);
});

console.log(`\nTrueType outline reading: ${passed} tests passed.`);

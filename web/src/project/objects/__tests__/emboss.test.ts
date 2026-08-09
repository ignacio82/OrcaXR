import assert from 'node:assert/strict';

import {
  DEFAULT_EMBOSS_FONT_PROPERTY,
  DEFAULT_EMBOSS_PROJECTION,
  EmbossError,
  PINNED_EMBOSS_SOURCE,
  buildEmbossedMesh,
  embossedBounds,
  type EmbossTextConfiguration,
  type GlyphOutline,
  type GlyphOutlineSource,
} from '../emboss';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/**
 * A deterministic stand-in font: every glyph is a unit square of side
 * `unitsPerEm`, so every dimension in the result is exactly predictable.
 */
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

function squareFont(available = new Set([...'AB'].map((c) => c.codePointAt(0)!))): GlyphOutlineSource {
  return {
    unitsPerEm: 1000,
    outline: (codePoint) => (available.has(codePoint) ? SQUARE_GLYPH : undefined),
  };
}

function configuration(overrides: Partial<EmbossTextConfiguration> = {}): EmbossTextConfiguration {
  return {
    text: 'A',
    styleName: 'Test',
    fontDescriptor: 'test-descriptor',
    fontDescriptorType: 'test',
    font: DEFAULT_EMBOSS_FONT_PROPERTY,
    projection: DEFAULT_EMBOSS_PROJECTION,
    ...overrides,
  };
}

function close(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected} within ${tolerance}, received ${actual}`);
}

test('pins the upstream source and defaults', () => {
  assert.equal(PINNED_EMBOSS_SOURCE.commit, '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626');
  assert.equal(DEFAULT_EMBOSS_PROJECTION.depthMm, 1);
  assert.equal(DEFAULT_EMBOSS_FONT_PROPERTY.lineHeightMm, 10);
  assert.equal(DEFAULT_EMBOSS_FONT_PROPERTY.perGlyph, false);
});

test('one glyph extrudes to an exact closed prism', () => {
  const mesh = buildEmbossedMesh(configuration(), squareFont());
  // A square cap is 2 triangles each side, plus 2 per wall edge: 4 + 8 = 12.
  assert.equal(mesh.triangleCount, 12);
  assert.equal(mesh.positions.length / 3, 8, 'four corners top and bottom');
  assert.deepEqual(mesh.missingCodePoints, []);

  const bounds = embossedBounds(mesh);
  // lineHeight 10 mm over unitsPerEm 1000 scales the 1000-unit square to 10 mm.
  close(bounds.max[0] - bounds.min[0], 10);
  close(bounds.max[1] - bounds.min[1], 10);
  close(bounds.min[2], 0);
  close(bounds.max[2], DEFAULT_EMBOSS_PROJECTION.depthMm);
});

test('depth and line height scale the result exactly', () => {
  const mesh = buildEmbossedMesh(
    configuration({
      font: { ...DEFAULT_EMBOSS_FONT_PROPERTY, lineHeightMm: 25 },
      projection: { depthMm: 3.5, useSurface: false },
    }),
    squareFont(),
  );
  const bounds = embossedBounds(mesh);
  close(bounds.max[0] - bounds.min[0], 25);
  close(bounds.max[2], 3.5);
});

test('character gap widens the run by exactly one gap per join', () => {
  const tight = embossedBounds(buildEmbossedMesh(configuration({ text: 'AB' }), squareFont()));
  close(tight.max[0] - tight.min[0], 20, 1e-9);

  const spaced = embossedBounds(
    buildEmbossedMesh(
      configuration({ text: 'AB', font: { ...DEFAULT_EMBOSS_FONT_PROPERTY, charGapMm: 4 } }),
      squareFont(),
    ),
  );
  close(spaced.max[0] - spaced.min[0], 24, 1e-9);
});

test('multiple lines stack by line height plus line gap', () => {
  const bounds = embossedBounds(
    buildEmbossedMesh(
      configuration({ text: 'A\nB', font: { ...DEFAULT_EMBOSS_FONT_PROPERTY, lineGapMm: 2 } }),
      squareFont(),
    ),
  );
  // Two 10 mm lines with a 2 mm gap.
  close(bounds.max[1] - bounds.min[1], 22, 1e-9);
  close(bounds.max[0] - bounds.min[0], 10, 1e-9);
});

test('horizontal alignment moves the run without resizing it', () => {
  const widths = new Set<number>();
  const lefts: number[] = [];
  for (const horizontal of ['left', 'center', 'right'] as const) {
    const bounds = embossedBounds(
      buildEmbossedMesh(
        configuration({ text: 'A', font: { ...DEFAULT_EMBOSS_FONT_PROPERTY, horizontal } }),
        squareFont(),
      ),
    );
    widths.add(Number((bounds.max[0] - bounds.min[0]).toFixed(9)));
    lefts.push(Number(bounds.min[0].toFixed(9)));
  }
  assert.equal(widths.size, 1, 'alignment never changes the width');
  assert.equal(new Set(lefts).size >= 1, true);
  // Centred text straddles the origin; left-aligned starts at it.
  close(lefts[0], 0);
  close(lefts[1], -5);
});

test('vertical alignment places the block above, across, or below the origin', () => {
  const tops: number[] = [];
  for (const vertical of ['top', 'center', 'bottom'] as const) {
    const bounds = embossedBounds(
      buildEmbossedMesh(
        configuration({ text: 'A', font: { ...DEFAULT_EMBOSS_FONT_PROPERTY, vertical } }),
        squareFont(),
      ),
    );
    tops.push(Number(bounds.max[1].toFixed(9)));
  }
  close(tops[0], 0, 1e-9);
  close(tops[1], 5, 1e-9);
  close(tops[2], 10, 1e-9);
});

test('skew shears along X by height without changing the height', () => {
  const bounds = embossedBounds(
    buildEmbossedMesh(configuration({ font: { ...DEFAULT_EMBOSS_FONT_PROPERTY, skew: 0.25 } }), squareFont()),
  );
  close(bounds.max[1] - bounds.min[1], 10, 1e-9);
  // The top edge shifts by skew * lineHeight, widening the footprint.
  close(bounds.max[0] - bounds.min[0], 12.5, 1e-9);
});

test('a code point the font lacks is reported, never silently skipped', () => {
  const mesh = buildEmbossedMesh(configuration({ text: 'A☃B' }), squareFont());
  assert.deepEqual(mesh.missingCodePoints, ['☃'.codePointAt(0)]);
  // The glyphs that do exist are still embossed.
  assert.equal(mesh.triangleCount, 24);

  assert.throws(
    () => buildEmbossedMesh(configuration({ text: '☃☃' }), squareFont()),
    (error: unknown) => error instanceof EmbossError && error.code === 'no-glyphs',
  );
});

test('impossible configurations and fonts fail closed', () => {
  for (const bad of [
    configuration({ text: '' }),
    configuration({ font: { ...DEFAULT_EMBOSS_FONT_PROPERTY, lineHeightMm: 0 } }),
    configuration({ font: { ...DEFAULT_EMBOSS_FONT_PROPERTY, charGapMm: Number.NaN } }),
    configuration({ font: { ...DEFAULT_EMBOSS_FONT_PROPERTY, collection: -1 } }),
    configuration({ projection: { depthMm: 0, useSurface: false } }),
  ]) {
    assert.throws(
      () => buildEmbossedMesh(bad, squareFont()),
      (error: unknown) => error instanceof EmbossError && error.code === 'invalid-configuration',
    );
  }
  assert.throws(
    () => buildEmbossedMesh(configuration(), { unitsPerEm: 0, outline: () => SQUARE_GLYPH }),
    (error: unknown) => error instanceof EmbossError && error.code === 'unsupported-font',
  );
});

test('a degenerate contour is dropped rather than producing broken geometry', () => {
  const degenerate: GlyphOutlineSource = {
    unitsPerEm: 1000,
    outline: () => ({
      advance: 1000,
      contours: [
        // A repeated-point sliver collapses to fewer than three corners.
        {
          points: [
            [0, 0],
            [0, 0],
            [0, 0],
            [0, 0],
          ],
        },
        SQUARE_GLYPH.contours[0],
      ],
    }),
  };
  const mesh = buildEmbossedMesh(configuration(), degenerate);
  assert.equal(mesh.triangleCount, 12, 'only the real square survives');
});

test('every emitted index addresses a real vertex', () => {
  const mesh = buildEmbossedMesh(configuration({ text: 'AB\nBA' }), squareFont());
  const vertexCount = mesh.positions.length / 3;
  assert.equal(mesh.indices.length % 3, 0);
  for (const index of mesh.indices) {
    assert.ok(Number.isInteger(index) && index >= 0 && index < vertexCount, `index ${index} is out of range`);
  }
  assert.ok(mesh.positions.every(Number.isFinite));
});

console.log(`\nCanonical text embossing: ${passed} tests passed.`);

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { extrudeContours, extrudedBounds } from '../extrude';
import { PINNED_SVG_SOURCE, SvgError, readSvgShapes } from '../svgShapes';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function close(actual: number, expected: number, tolerance = 1e-6): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected} ± ${tolerance}, received ${actual}`);
}

function svg(body: string, attributes = 'width="100mm" height="50mm" viewBox="0 0 100 50"'): string {
  return `<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${body}</svg>`;
}

/** Signed area, so winding and size can both be checked. */
function area(contour: readonly (readonly [number, number])[]): number {
  let total = 0;
  for (let index = 0; index < contour.length; index += 1) {
    const current = contour[index];
    const next = contour[(index + 1) % contour.length];
    total += current[0] * next[1] - next[0] * current[1];
  }
  return total / 2;
}

test('pins the upstream source', () => {
  assert.equal(PINNED_SVG_SOURCE.commit, '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626');
});

test('a rectangle resolves to its declared physical size', () => {
  const shapes = readSvgShapes(svg('<rect x="10" y="10" width="40" height="20"/>'));
  assert.equal(shapes.contours.length, 1);
  assert.deepEqual(shapes.unsupported, []);
  // The viewBox is 100x50 user units over 100x50 mm, so units are millimetres.
  close(Math.abs(area(shapes.contours[0])), 40 * 20);
  close(shapes.sizeMm[0], 40);
  close(shapes.sizeMm[1], 20);
});

test('user units scale to the declared document size', () => {
  // 200 user units wide drawn at 100 mm: every coordinate halves.
  const shapes = readSvgShapes(
    svg('<rect x="0" y="0" width="100" height="50"/>', 'width="100mm" height="50mm" viewBox="0 0 200 100"'),
  );
  close(shapes.sizeMm[0], 50);
  close(shapes.sizeMm[1], 25);
});

test('a document with no units uses the 96dpi pixel convention', () => {
  const shapes = readSvgShapes(svg('<rect x="0" y="0" width="96" height="96"/>', 'width="96" height="96"'));
  // 96 px at 96 dpi is one inch.
  close(shapes.sizeMm[0], 25.4, 1e-9);
  close(shapes.sizeMm[1], 25.4, 1e-9);
});

test('the y axis is flipped so the part is not mirrored', () => {
  // Two rectangles: the SVG-top one must end up with the larger Y.
  const shapes = readSvgShapes(
    svg('<rect x="0" y="0" width="10" height="10"/><rect x="0" y="40" width="10" height="10"/>'),
  );
  assert.equal(shapes.contours.length, 2);
  const centreY = (contour: readonly (readonly [number, number])[]) =>
    contour.reduce((total, point) => total + point[1], 0) / contour.length;
  assert.ok(centreY(shapes.contours[0]) > centreY(shapes.contours[1]), 'the first rect was drawn at the top');
});

test('a path with curves, arcs, and relative commands closes', () => {
  const shapes = readSvgShapes(
    svg('<path d="M 10 10 L 50 10 C 60 10 60 30 50 30 A 5 5 0 0 1 40 30 q -10 0 -20 0 z"/>'),
  );
  assert.equal(shapes.contours.length, 1);
  const contour = shapes.contours[0];
  assert.ok(contour.length > 20, 'curves are flattened into segments');
  assert.ok(contour.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
  assert.ok(Math.abs(area(contour)) > 100, 'the path encloses real area');
});

test('a subpath inside another becomes a hole once extruded', () => {
  // Outer square with an inner square wound the other way: the classic donut.
  const shapes = readSvgShapes(svg('<path d="M 10 10 H 50 V 40 H 10 Z M 20 20 V 30 H 40 V 20 Z"/>'));
  assert.equal(shapes.contours.length, 2);
  const mesh = extrudeContours(shapes.contours, 2);
  assert.equal(mesh.openEdgeCount, 0, 'the extruded part must be a closed solid');
  const bounds = extrudedBounds(mesh);
  close(bounds.max[0] - bounds.min[0], 40, 1e-6);
  close(bounds.max[2], 2);
});

test('every primitive shape is understood', () => {
  const shapes = readSvgShapes(
    svg(
      '<circle cx="20" cy="25" r="10"/>' +
        '<ellipse cx="50" cy="25" rx="12" ry="6"/>' +
        '<polygon points="70,10 90,10 80,30"/>' +
        '<rect x="5" y="5" width="6" height="6" rx="2"/>',
    ),
  );
  assert.equal(shapes.contours.length, 4);
  assert.deepEqual(shapes.unsupported, []);
  const circle = shapes.contours[0];
  // A polygon of many segments approaches πr².
  assert.ok(Math.abs(Math.abs(area(circle)) - Math.PI * 100) < 1.5);
});

test('nested transforms compose', () => {
  const plain = readSvgShapes(svg('<rect x="0" y="0" width="10" height="10"/>'));
  const moved = readSvgShapes(
    svg('<g transform="translate(20 5)"><g transform="scale(2)"><rect x="0" y="0" width="10" height="10"/></g></g>'),
  );
  close(Math.abs(area(moved.contours[0])), Math.abs(area(plain.contours[0])) * 4, 1e-6);
  close(moved.sizeMm[0], 20);
});

test('a rotation about a point keeps the shape the same size', () => {
  const shapes = readSvgShapes(svg('<rect x="10" y="10" width="20" height="20" transform="rotate(45 20 20)"/>'));
  close(Math.abs(area(shapes.contours[0])), 400, 1e-6);
  // A square rotated 45° has a diagonal footprint.
  close(shapes.sizeMm[0], Math.sqrt(2) * 20, 1e-6);
});

test('a requested width scales the drawing and keeps its aspect', () => {
  const shapes = readSvgShapes(svg('<rect x="0" y="0" width="40" height="20"/>'), 80);
  close(shapes.sizeMm[0], 80);
  close(shapes.sizeMm[1], 40);
});

test('the result is centred on the origin', () => {
  const shapes = readSvgShapes(svg('<rect x="60" y="30" width="20" height="10"/>'));
  const centre = shapes.contours[0].reduce(
    (total, point) => [total[0] + point[0] / 4, total[1] + point[1] / 4] as [number, number],
    [0, 0] as [number, number],
  );
  close(centre[0], 0, 1e-9);
  close(centre[1], 0, 1e-9);
});

test('everything that cannot become solid is named, not dropped in silence', () => {
  const shapes = readSvgShapes(
    svg(
      '<rect x="0" y="0" width="10" height="10"/>' +
        '<text x="5" y="5">hello</text>' +
        '<image href="cat.png" width="10" height="10"/>' +
        '<use href="#other"/>' +
        '<clipPath id="c"><rect width="1" height="1"/></clipPath>' +
        '<linearGradient id="g"/>' +
        '<path d="M 0 0 L 10 10" fill="none" stroke="black"/>' +
        '<line x1="0" y1="0" x2="10" y2="10"/>',
    ),
  );
  const reasons = shapes.unsupported.map((entry) => `${entry.element}:${entry.reason}`);
  assert.deepEqual(reasons, [
    'text:needs-font',
    'image:raster-image',
    'use:external-reference',
    'clippath:paint-effect',
    'lineargradient:paint-effect',
    'path:stroke-only',
    'line:stroke-only',
  ]);
  // Each note says why, in words an operator can act on.
  for (const entry of shapes.unsupported) assert.ok(entry.detail.length > 20, entry.detail);
  // The one real shape still made it through.
  assert.equal(shapes.contours.length, 1);
});

test('an unreadable or empty drawing fails with a reason', () => {
  assert.throws(
    () => readSvgShapes('<html><body>not a drawing</body></html>'),
    (error: unknown) => error instanceof SvgError && error.code === 'invalid-svg',
  );
  assert.throws(
    () => readSvgShapes(svg('')),
    (error: unknown) => error instanceof SvgError && error.code === 'no-geometry',
  );
  // A drawing of nothing but text explains itself rather than reporting "empty".
  assert.throws(
    () => readSvgShapes(svg('<text x="0" y="0">hello</text>')),
    (error: unknown) => error instanceof SvgError && /needs a font/.test(error.message),
  );
});

test('comments, namespaces, and CDATA do not confuse the reader', () => {
  const source =
    '<?xml version="1.0"?><!DOCTYPE svg><svg:svg xmlns:svg="http://www.w3.org/2000/svg" ' +
    'width="20mm" height="20mm" viewBox="0 0 20 20">' +
    '<!-- a comment with <rect/> inside --><style><![CDATA[ rect { fill: red } ]]></style>' +
    '<svg:rect x="0" y="0" width="10" height="10"/></svg:svg>';
  const shapes = readSvgShapes(source);
  assert.equal(shapes.contours.length, 1, 'only the real rect is read');
  close(Math.abs(area(shapes.contours[0])), 100);
});

/**
 * Real drawings, not only hand-written fixtures. Material Symbols ships
 * thousands of production SVGs, each a filled path with counters, and every
 * one must come out as a closed solid — the same bar the font sweep sets for
 * text. The full set of 7,314 passes; this takes a deterministic slice so the
 * gate stays quick.
 */
test('real production SVG icons extrude to closed solids', () => {
  const directory = 'node_modules/@material-symbols/svg-400/outlined';
  let files: string[];
  try {
    files = readdirSync(directory)
      .filter((name) => name.endsWith('.svg'))
      .sort();
  } catch {
    console.log('    ⚠ Material Symbols not installed; real-icon sweep skipped');
    return;
  }
  // Every eighteenth icon: a spread across the alphabet in about a second.
  const sample = files.filter((_name, index) => index % 18 === 0);
  assert.ok(sample.length > 100, `expected a real sample, got ${sample.length}`);

  const open: string[] = [];
  for (const name of sample) {
    const shapes = readSvgShapes(readFileSync(`${directory}/${name}`, 'utf8'), 20);
    const mesh = extrudeContours(shapes.contours, 2);
    assert.ok(mesh.triangleCount > 0, `${name} produced no geometry`);
    if (mesh.openEdgeCount !== 0) open.push(`${name} (${mesh.openEdgeCount})`);
  }
  assert.deepEqual(open, [], 'every icon must close');
});

console.log(`\nSVG shape reading: ${passed} tests passed.`);

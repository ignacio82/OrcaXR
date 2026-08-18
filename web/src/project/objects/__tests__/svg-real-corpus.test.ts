/**
 * Every real SVG this repository ships, through the parser (P5.3.4, P12.3).
 *
 * Four defects were found in this parser by probing lines the plan described as
 * limitations, and each was pinned by a hand-written document. Hand-written
 * documents are exactly the corpus most likely to keep agreeing with the parser
 * that inspired them, so this runs the files that arrived from somewhere else:
 * the 100-plus Material Design icons the app ships for its XR surfaces.
 *
 * What it is worth is bounded and worth saying. These are simple filled paths.
 * They do not carry stylesheets, grouped `fill="none"`, `!important`, or media
 * queries, so they exercise none of the four defects — what they establish is
 * that ordinary geometry from a real tool round-trips, and that a future change
 * to the cascade does not start refusing files that work today.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { readSvgShapes } from '../svgShapes';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const PUBLIC = resolve(import.meta.dirname, '../../../../public');

function svgFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return svgFiles(full);
    return full.endsWith('.svg') ? [full] : [];
  });
}

test('every shipped SVG becomes solid geometry, with nothing reported', () => {
  const files = svgFiles(PUBLIC);
  // A corpus that has quietly emptied proves nothing, so its size is asserted
  // before its contents.
  assert.ok(files.length > 50, `the shipped icon set is present (${files.length} files)`);

  const refused: string[] = [];
  const reported: string[] = [];
  for (const file of files) {
    const relative = file.slice(PUBLIC.length);
    try {
      const shapes = readSvgShapes(readFileSync(file, 'utf8'));
      assert.ok(shapes.contours.length > 0, `${relative} yields contours`);
      for (const entry of shapes.unsupported) reported.push(`${relative}: ${entry.reason}`);
    } catch (error) {
      refused.push(`${relative}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  assert.deepEqual(refused, [], 'no shipped icon is refused');
  // Not a hard failure if a future icon legitimately uses something unread —
  // but it must be visible, because an unsupported notice on a file the app
  // ships means an operator importing something similar gets a surprise.
  assert.deepEqual(reported, [], 'and none of them relies on anything this parser cannot read');
});

/**
 * The shape the four fixes were actually about.
 *
 * The shipped icons are homogeneous filled paths and exercise none of them.
 * These two documents are modelled on what Illustrator and Inkscape really
 * emit — Illustrator writes a `<style>` block of `.st0{fill:none;stroke:…}`
 * classes and puts construction geometry on one layer; Inkscape writes layer
 * groups carrying `style="fill:none;stroke:…"` and a transform. Both put a
 * stroked construction line beside filled artwork, which is the ordinary way a
 * part is drawn.
 *
 * Before the cascade work, both produced *two* contours: the construction line
 * solidified into the part. The assertion is therefore not "it parses" but
 * "the construction geometry is excluded and said so".
 */
test('a tool-shaped drawing keeps its artwork and drops its construction lines', () => {
  const illustrator = `<?xml version="1.0" encoding="utf-8"?>
<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" xml:space="preserve">
<style type="text/css">
	.st0{fill:none;stroke:#000000;stroke-miterlimit:10;}
	.st1{fill:#FF0000;}
</style>
<g id="guides"><path class="st0" d="M0,0 L100,0 L100,100 Z"/></g>
<g id="artwork"><path class="st1" d="M20,20 L80,20 L80,80 L20,80 Z"/></g>
</svg>`;

  const inkscape = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns="http://www.w3.org/2000/svg"
   width="100mm" height="100mm" viewBox="0 0 100 100" version="1.1">
  <defs id="defs1" />
  <g inkscape:label="Construction" inkscape:groupmode="layer" id="layer1"
     style="fill:none;stroke:#000000;stroke-width:0.5">
    <path d="M 0,0 100,100" id="path1" />
  </g>
  <g inkscape:label="Part" inkscape:groupmode="layer" id="layer2" transform="translate(5,5)">
    <rect x="10" y="10" width="40" height="40" style="fill:#00ff00" id="rect1" />
  </g>
</svg>`;

  for (const [label, source] of [
    ['Illustrator', illustrator],
    ['Inkscape', inkscape],
  ] as const) {
    const shapes = readSvgShapes(source);
    assert.equal(shapes.contours.length, 1, `${label}: only the artwork becomes solid`);
    assert.ok(
      shapes.unsupported.some((entry) => entry.reason === 'stroke-only'),
      `${label}: and the construction line is reported rather than dropped in silence`,
    );
  }
});

console.log(`\nReal SVG corpus: ${passed} tests passed.`);

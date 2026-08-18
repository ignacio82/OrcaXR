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

console.log(`\nReal SVG corpus: ${passed} tests passed.`);

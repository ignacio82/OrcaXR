/**
 * Project3mf unit tests (run: npx tsx project3mf.test.ts).
 * Round-trips geometry + metadata through the project 3MF writer/reader.
 */
import assert from 'node:assert';
import { writeProject3mf, parseProject3mf, type ProjectMeta } from '../Project3mf';
import { writeMinimal3mf } from '../Write3mf';

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log('  ✓', name); }

const triA = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]);
const triB = new Float32Array([1, 1, 1, 2, 1, 1, 1, 2, 1]);

const meta: ProjectMeta = {
  version: 1,
  profile: { machine: 'Snapmaker U1', process: '0.20 Standard', filament: 'PLA' },
  activePlate: 2,
  plates: [{ id: 1, label: 'Plate 1' }, { id: 2, label: 'Plate 2' }],
  objects: [
    { plate: 1, viewer: { position: [0.1, 0, -0.2], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, display: [0, 0.01, 0] },
    { plate: 2, viewer: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [2, 2, 2] }, display: [1, 2, 3] },
  ],
};

test('round-trips two objects with correct positions', () => {
  const bytes = writeProject3mf([{ positions: triA }, { positions: triB }], meta);
  const parsed = parseProject3mf(bytes);
  assert.ok(parsed, 'parsed non-null');
  assert.strictEqual(parsed!.geometries.length, 2);
  assert.deepStrictEqual(Array.from(parsed!.geometries[0]), Array.from(triA));
  assert.deepStrictEqual(Array.from(parsed!.geometries[1]), Array.from(triB));
});

test('round-trips the metadata (plates, profile, transforms)', () => {
  const bytes = writeProject3mf([{ positions: triA }, { positions: triB }], meta);
  const { meta: m } = parseProject3mf(bytes)!;
  assert.strictEqual(m.activePlate, 2);
  assert.strictEqual(m.plates.length, 2);
  assert.strictEqual(m.profile.process, '0.20 Standard');
  assert.deepStrictEqual(m.objects[0].viewer.position, [0.1, 0, -0.2]);
  assert.deepStrictEqual(m.objects[1].viewer.scale, [2, 2, 2]);
  assert.deepStrictEqual(m.objects[1].display, [1, 2, 3]);
});

test('a plain (non-project) 3MF returns null', () => {
  // A zip without the sidecar isn't an OrcaXR project.
  assert.strictEqual(parseProject3mf(writeMinimal3mf(triA)), null);
});

test('garbage bytes return null (no throw)', () => {
  assert.strictEqual(parseProject3mf(new Uint8Array([1, 2, 3, 4])), null);
});

console.log(`\nProject3mf: ${passed} tests passed.`);

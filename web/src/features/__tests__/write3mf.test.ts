/**
 * Write3mf unit tests (run: npx tsx write3mf.test.ts).
 * Checks the package structure + that the model XML round-trips a triangle.
 */
import assert from 'node:assert';
import * as fflate from 'fflate';
import { writeMinimal3mf, build3mfModelXml } from '../Write3mf';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log('  ✓', name);
}

const oneTri = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]);

test('package has the three required 3MF parts', () => {
  const zip = fflate.unzipSync(writeMinimal3mf(oneTri));
  for (const part of ['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model']) {
    assert.ok(zip[part] && zip[part].length > 0, `missing part ${part}`);
  }
});

test('model XML emits 3 vertices + 1 triangle for one input triangle', () => {
  const xml = build3mfModelXml(oneTri);
  assert.strictEqual((xml.match(/<vertex /g) || []).length, 3);
  assert.strictEqual((xml.match(/<triangle /g) || []).length, 1);
  assert.match(xml, /v1="0" v2="1" v3="2"/);
  assert.match(xml, /unit="millimeter"/);
});

test('vertex coordinates are preserved', () => {
  const xml = build3mfModelXml(oneTri);
  assert.match(xml, /x="10" y="0" z="0"/);
  assert.match(xml, /x="0" y="10" z="0"/);
});

test('two triangles index 0..5 with two <triangle> rows', () => {
  const twoTris = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0]);
  const xml = build3mfModelXml(twoTris);
  assert.strictEqual((xml.match(/<vertex /g) || []).length, 6);
  assert.match(xml, /v1="3" v2="4" v3="5"/);
});

console.log(`\nWrite3mf: ${passed} tests passed.`);

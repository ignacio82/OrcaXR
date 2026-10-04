import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { canonicalStringify, fnv1a64Text } from '../../web/src/project/domain/canonical.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cases = [
  ['empty-object', '{}'], ['empty-array', '[]'], ['null', 'null'],
  ['booleans', '[true,false]'], ['key-order', '{"z":1,"a":2,"10":3,"2":4}'],
  ['duplicates', '{"a":1,"a":2}'], ['prototype-property', '{"__proto__":{"name":"retained"}}'],
  ['surrogate-keys', '{"\\ue000":1,"\\ud800\\udc00":2,"\\ud800":3}'],
  ['unpaired-surrogates', '"\\ud800x\\udc00"'],
  ['unicode', '"🐳 café 漢字 \\u2028\\u2029"'],
  ['escapes', '"\\b\\f\\n\\r\\t\\u0000\\u001f\\\\\\\"\\/"'],
  ['number-boundaries', '[-0,1e-7,1e-6,1e20,1e21,9007199254740993,5e-324,1.7976931348623157e308]'],
  ['nested', '{"assets":[{"id":"mesh:0","transform":[1,0,0,0]}],"name":"OrcaXR"}'],
];
// Reproducible f64 bit patterns challenge rounding and exponent formatting.
let seed = 0x12345678;
const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
const buffer = new ArrayBuffer(8);
const view = new DataView(buffer);
for (let i = 0; i < 256; i++) {
  view.setUint32(0, next(), true); view.setUint32(4, next(), true);
  const value = view.getFloat64(0, true);
  if (Number.isFinite(value)) cases.push([`f64-${i}`, JSON.stringify(value)]);
}
const vectors = cases.map(([id, input]) => {
  const canonical = canonicalStringify(JSON.parse(input));
  return { id, input, canonical, semanticHash: `fnv1a64:${fnv1a64Text(canonical)}`,
    sha256: createHash('sha256').update(canonical).digest('hex') };
});
const result = {
  schemaVersion: 1,
  reference: 'web/src/project/domain/canonical.ts',
  referenceSha256: createHash('sha256').update(readFileSync(resolve(root, 'web/src/project/domain/canonical.ts'))).digest('hex'),
  provenance: 'Synthetic JSON inputs generated for OrcaXR; no user models or credentials.',
  vectors,
  invalid: ['', '01', '1.', '-.1', '[1,]', '{"a":1,}', '[', 'true false', '"\\uZZZZ"', '1e400'].map((input, i) => ({
    id: `invalid-${i}`, input, code: input === '1e400' ? 'non_finite_number' : 'invalid_json',
  })),
};
const target = resolve(root, 'testdata/cross-platform/canonical-vectors.json');
const content = JSON.stringify(result, null, 2) + '\n';
if (process.argv.includes('--write')) { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content); }
else assert.equal(readFileSync(target, 'utf8'), content, 'Canonical reference vectors have drifted');
console.log(`Verified ${vectors.length} canonical vectors and ${result.invalid.length} invalid inputs against the TypeScript authority`);

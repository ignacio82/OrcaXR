import assert from 'node:assert/strict';

import { canonicalStringify, fnv1a64, projectFingerprint } from '../domain/canonical';
import { createProjectFixture } from './fixtures';

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  \u2713 ${name}`);
}

/**
 * The digest this replaced multiplied a BigInt per byte, and the fingerprint
 * built the whole UTF-8 encoding as a JS array first. Both are fine for a few
 * kilobytes and neither survives a 144 MB project state: the array exceeded
 * what a JS array can hold, so a large painted model could be opened but never
 * saved. The rewrite must produce byte-identical digests, which is what these
 * pin against the original implementation.
 */
function referenceFnv1a64(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

test('every single byte value digests exactly as the BigInt form did', () => {
  // The 64-bit multiply carry between the halves is the part worth pinning.
  for (let byte = 0; byte < 256; byte += 1) {
    const input = new Uint8Array([byte]);
    assert.equal(fnv1a64(input), referenceFnv1a64(input), `byte ${byte}`);
  }
});

test('digests match across lengths, including empty input', () => {
  let seed = 12345;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (const size of [0, 1, 2, 7, 63, 255, 1024, 65537]) {
    const bytes = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) bytes[index] = Math.floor(random() * 256);
    assert.equal(fnv1a64(bytes), referenceFnv1a64(bytes), `length ${size}`);
  }
});

test('multi-byte and astral text encodes identically to a standard encoder', () => {
  for (const text of ['a', '\u00e9', '\u2603', '\ud834\udd1e', 'mixed \u00e9\u2603\ud834\udd1e text', '\ufffd']) {
    const bytes = new TextEncoder().encode(text);
    assert.equal(fnv1a64(bytes), referenceFnv1a64(bytes), JSON.stringify(text));
  }
});

test('the streamed fingerprint equals hashing the encoded canonical text', () => {
  const fixture = createProjectFixture();
  const encoded = new TextEncoder().encode(canonicalStringify(fixture.state));
  assert.equal(projectFingerprint(fixture.state), `fnv1a64:${referenceFnv1a64(encoded)}`);
});

console.log(`\nCanonical hashing: ${passed} tests passed.`);

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { UTF8_SHA256_CHUNK_CODE_UNITS, sha256Utf8 } from '../Utf8Sha256';

let passed = 0;

async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  await run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function expected(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

await test('hashes the empty string', async () => {
  assert.equal(await sha256Utf8(''), 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

await test('matches Node SHA-256 for ASCII and padding boundaries', async () => {
  for (const length of [1, 55, 56, 63, 64, 65, 127, 128, 129]) {
    const value = 'abc123'.repeat(Math.ceil(length / 6)).slice(0, length);
    assert.equal(await sha256Utf8(value), expected(value), `length ${length}`);
  }
});

await test('matches Node UTF-8 encoding for non-ASCII text', async () => {
  const value = 'Zażółć gęślą jaźń — 你好 🌊🦑';
  assert.equal(await sha256Utf8(value), expected(value));
});

await test('matches TextEncoder replacement semantics for unpaired surrogates', async () => {
  const values = ['\ud800', '\udc00', 'left\ud800middle\udc00right', '\ud800\ud800\udc00\udc00'];
  for (const value of values) assert.equal(await sha256Utf8(value), expected(value));
});

await test('preserves a surrogate pair split by the UTF-16 chunk boundary', async () => {
  const value = [
    'a'.repeat(UTF8_SHA256_CHUNK_CODE_UNITS - 1),
    '🐋',
    'β'.repeat(UTF8_SHA256_CHUNK_CODE_UNITS + 7),
    '\ud800tail',
  ].join('');
  assert.equal(await sha256Utf8(value), expected(value));
});

console.log(`\n${passed} UTF-8 SHA-256 tests passed.`);

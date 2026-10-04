import assert from 'node:assert/strict';
import { fetchCoreAsset, checkCoreHandshake } from '../core/RustGcodePreview';
import { sha256Bytes } from '../Utf8Sha256';
import {
  CORE_ABI_VERSION,
  PROTOCOL_VERSION,
  CANONICAL_ENCODING_VERSION,
  MAX_INPUT_BYTES,
  MAX_REQUEST_BYTES,
} from '../../../../contracts/generated/core';

const bytes = new TextEncoder().encode('verified core bytes');
const asset = { path: 'core/test.wasm', bytes: bytes.length, sha256: sha256Bytes(bytes).slice(7) };
const base = new URL('https://example.invalid/slicer/');
function response(parts: Uint8Array[], headers: Record<string, string> = {}, status = 200) {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts.shift();
      if (part) controller.enqueue(part);
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { value: new Response(stream, { status, headers }), cancelled: () => cancelled };
}
const valid = response([bytes.subarray(0, 4), bytes.subarray(4)], { 'Content-Length': String(bytes.length) });
assert.deepEqual(
  await fetchCoreAsset(asset, base, (async (url, options) => {
    assert.equal(String(url), 'https://example.invalid/slicer/core/test.wasm');
    assert.equal(options?.redirect, 'error');
    assert.equal(options?.credentials, 'same-origin');
    return valid.value;
  }) as typeof fetch),
  bytes,
);
// Fetch decodes compressed bodies; the transfer header describes compressed bytes.
assert.deepEqual(
  await fetchCoreAsset(
    asset,
    base,
    (async () =>
      response([bytes], {
        'Content-Encoding': 'gzip',
        'Content-Length': '3',
      }).value) as typeof fetch,
  ),
  bytes,
);
for (const [name, fixture] of [
  ['missing', response([bytes], {}, 404)],
  ['short', response([bytes.subarray(1)])],
  ['long', response([new Uint8Array(bytes.length + 1), bytes])],
  ['digest', response([new Uint8Array(bytes.length)])],
  ['length', response([bytes, bytes], { 'Content-Length': '1' })],
] as const) {
  await assert.rejects(fetchCoreAsset(asset, base, (async () => fixture.value) as typeof fetch), Error, name);
  if (name === 'long' || name === 'length') assert.equal(fixture.cancelled(), true, name);
}
let fetched = false;
for (const invalid of [
  { ...asset, bytes: 8 * 1024 * 1024 + 1 },
  { ...asset, path: 'https://other.invalid/core.wasm' },
])
  await assert.rejects(
    fetchCoreAsset(invalid, base, (async () => {
      fetched = true;
      return new Response(bytes);
    }) as typeof fetch),
  );
assert.equal(fetched, false, 'invalid identities fail before a network request');
const info = {
  coreAbiVersion: CORE_ABI_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  canonicalEncodingVersion: CANONICAL_ENCODING_VERSION,
  maxInputBytes: MAX_INPUT_BYTES,
  maxRequestBytes: MAX_REQUEST_BYTES,
};
checkCoreHandshake(JSON.stringify(info));
for (const invalid of [
  null,
  [],
  { ...info, protocolVersion: 999 },
  { ...info, extra: 1 },
  { ...info, maxInputBytes: undefined },
])
  assert.throws(() => checkCoreHandshake(JSON.stringify(invalid)));
assert.throws(() => checkCoreHandshake(' '.repeat(1025)));
console.log(
  'Shared core loader: bounded streaming, compressed responses, digest refusals and strict handshake passed.',
);

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ProfileCatalog } from '../ProfileLoader';

const source = JSON.parse(readFileSync(new URL('../../../public/profiles/catalog.json', import.meta.url), 'utf8'));
const catalog = ProfileCatalog.fromRaw(source);
const original = catalog.profiles;
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response('Unavailable', { status: 503 });
  await assert.rejects(catalog.load(), /HTTP 503/);
  assert.equal(catalog.profiles, original);
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  await assert.rejects(catalog.load(), /validation/);
  assert.equal(catalog.profiles, original);
  let finish!: (value: unknown) => void;
  const body = new Promise((resolve) => {
    finish = resolve;
  });
  globalThis.fetch = async () => ({ ok: true, json: () => body }) as Response;
  const abort = new AbortController();
  const pending = catalog.load(abort.signal);
  abort.abort(new Error('Workspace closed'));
  finish(source);
  await assert.rejects(pending, /Workspace closed/);
  assert.equal(catalog.profiles, original, 'late bodies cannot reconfigure a closed workspace');
  globalThis.fetch = async () => new Response(JSON.stringify(source), { status: 200 });
  await catalog.load();
  assert.ok(catalog.profiles.length > 0);
  assert.notEqual(catalog.profiles, original, 'an explicit retry performs a fresh validated load');
} finally {
  globalThis.fetch = originalFetch;
}
console.log('Profile loading lifecycle passed.');

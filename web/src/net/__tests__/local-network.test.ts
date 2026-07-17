import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  browserClassifiesAddressSpace,
  createLocalNetworkRequest,
  localNetworkTargetForRequest,
  normalizeHttpEndpoint,
} from '../LocalNetworkAccess.ts';

assert.equal(browserClassifiesAddressSpace('192.168.1.5'), true);
assert.equal(browserClassifiesAddressSpace('100.64.0.1'), true);
assert.equal(browserClassifiesAddressSpace('999.168.1.5'), false);
assert.equal(browserClassifiesAddressSpace('[::ffff:192.168.1.5]'), true);
assert.equal(browserClassifiesAddressSpace('printer.local'), true);
assert.equal(browserClassifiesAddressSpace('printer.local.'), true);
assert.equal(browserClassifiesAddressSpace('notlocal'), false);
assert.equal(browserClassifiesAddressSpace('printer.home.arpa'), false);
assert.equal(localNetworkTargetForRequest('http://printer.home.arpa', true), 'local');
assert.equal(localNetworkTargetForRequest('http://192.168.1.5', true), null);
assert.equal(localNetworkTargetForRequest('http://8.8.8.8', true), null);
assert.equal(localNetworkTargetForRequest('http://printer.local', true), null);
assert.equal(localNetworkTargetForRequest('https://printer.home.arpa', true), null);
assert.equal(localNetworkTargetForRequest('http://printer.home.arpa', false), null);
assert.equal(localNetworkTargetForRequest('not a URL', true), null);
assert.equal(normalizeHttpEndpoint('192.168.1.5:7125/'), 'http://192.168.1.5:7125');
assert.equal(normalizeHttpEndpoint('fd00::1234'), 'http://[fd00::1234]');
assert.equal(normalizeHttpEndpoint('https://printer.example/'), 'https://printer.example');
assert.equal(normalizeHttpEndpoint('ftp://printer.example'), '');
assert.equal(normalizeHttpEndpoint('http://'), '');
assert.equal(normalizeHttpEndpoint(''), '');

const nativeRequest = Object.getOwnPropertyDescriptor(globalThis, 'Request');
let capturedInit: (RequestInit & { targetAddressSpace?: string }) | undefined;
class CapturingRequest {
  readonly url: string;
  constructor(input: RequestInfo | URL, init: RequestInit = {}) {
    this.url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    capturedInit = init;
  }
}
Object.defineProperty(globalThis, 'Request', {
  configurable: true,
  writable: true,
  value: CapturingRequest,
});
try {
  const controller = new AbortController();
  const request = createLocalNetworkRequest(
    'http://printer.home.arpa/server/info',
    { method: 'POST', headers: { 'X-Test': 'yes' }, body: 'payload', signal: controller.signal },
    true,
  );
  assert.equal((request as unknown as CapturingRequest).url, 'http://printer.home.arpa/server/info');
  assert.ok(capturedInit);
  assert.equal(capturedInit.targetAddressSpace, 'local');
  assert.equal(capturedInit.method, 'POST');
  assert.deepEqual(capturedInit.headers, { 'X-Test': 'yes' });
  assert.equal(capturedInit.body, 'payload');
  assert.equal(capturedInit.signal, controller.signal);
} finally {
  if (nativeRequest) Object.defineProperty(globalThis, 'Request', nativeRequest);
}

const serviceWorker = readFileSync(new URL('../../../public/coi-serviceworker.js', import.meta.url), 'utf8');
assert.match(
  serviceWorker,
  /if \(url\.origin !== self\.location\.origin\) return;/,
  'COI worker must leave all cross-origin requests to the page',
);

console.log('Local Network Access tests passed.');

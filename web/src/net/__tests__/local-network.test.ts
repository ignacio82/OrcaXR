import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  blockedAsMixedContent,
  browserClassifiesAddressSpace,
  createLocalNetworkRequest,
  diagnoseLocalNetwork,
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

// ---- Why a LAN address could not be reached --------------------------------
//
// Reported against https://orcaxr.martinez.fyi/slicer/, which could reach
// neither http://192.168.1.228 (Moonraker) nor http://192.168.1.90:3000 (the
// slicer server) while both answered fine in a browser tab. The page is HTTPS
// and both endpoints are plain HTTP, so the browser refused them before a
// request was sent — and the app reported "No response: Failed to fetch",
// which is what it also says for a printer that is switched off.
{
  const secure = Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext');
  const setSecure = (value: boolean) =>
    Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value });
  try {
    setSecure(true);
    assert.equal(blockedAsMixedContent('http://192.168.1.228'), true);
    assert.equal(blockedAsMixedContent('http://192.168.1.90:3000'), true);
    assert.equal(blockedAsMixedContent('https://printer.example'), false);
    setSecure(false);
    assert.equal(blockedAsMixedContent('http://192.168.1.228'), false, 'an HTTP page may reach an HTTP printer');

    // Blocked: the message must name the cause and the ways out, and must not
    // suggest retrying something that cannot succeed.
    setSecure(true);
    const blocked = await diagnoseLocalNetwork(
      'http://192.168.1.228',
      'printer',
      "Moonraker's cors_domains",
      new TypeError('Failed to fetch'),
    );
    assert.match(blocked.summary, /http:\/\/192\.168\.1\.228/);
    assert.doesNotMatch(blocked.summary, /Failed to fetch/, 'the browser’s opaque wording explains nothing');
    assert.match(blocked.detail, /HTTPS page load anything over plain HTTP|HTTPS page load|plain HTTP/);
    assert.match(blocked.detail, /Tailscale Serve/, 'the HTTPS route out is named');
    assert.match(blocked.detail, /over HTTP/, 'so is the same-origin route out');
    assert.match(blocked.detail, /cors_domains/, 'and the setting that bites next');
    // No Local Network Access permission in Node, so no retry can succeed.
    assert.equal(blocked.blocked, true);

    // The operator already runs an OrcaXR server, and it publishes this app.
    // Naming it turns a workaround into the move that removes the problem.
    const withServer = await diagnoseLocalNetwork(
      'http://192.168.1.228',
      'printer',
      "Moonraker's cors_domains",
      new TypeError('Failed to fetch'),
      { appOrigin: 'http://192.168.1.90:3000' },
    );
    assert.match(withServer.summary, /open OrcaXR at http:\/\/192\.168\.1\.90:3000/);
    assert.match(withServer.detail, /publishes this app beside the slicer/);
    assert.equal(withServer.openAppAt, 'http://192.168.1.90:3000', 'somewhere to go, not an address to retype');
    // An HTTPS server is not the plain-HTTP case this is about, so it is not
    // offered as the way out of a plain-HTTP problem.
    const httpsServer = await diagnoseLocalNetwork(
      'http://192.168.1.228',
      'printer',
      "Moonraker's cors_domains",
      new TypeError('Failed to fetch'),
      { appOrigin: 'https://slicer.example' },
    );
    assert.doesNotMatch(httpsServer.summary, /slicer\.example/);
    assert.equal(httpsServer.openAppAt, undefined);

    // Not blocked: an ordinary unreachable address keeps an ordinary message,
    // and a real error from the network is worth repeating.
    setSecure(false);
    const offline = await diagnoseLocalNetwork(
      'http://192.168.1.228',
      'printer',
      "Moonraker's cors_domains",
      new Error('connect ECONNREFUSED'),
    );
    assert.equal(offline.blocked, false);
    assert.match(offline.summary, /connect ECONNREFUSED/);
    assert.doesNotMatch(offline.detail, /plain HTTP/);
  } finally {
    if (secure) Object.defineProperty(globalThis, 'isSecureContext', secure);
    else Reflect.deleteProperty(globalThis, 'isSecureContext');
  }
}

const serviceWorker = readFileSync(new URL('../../../public/coi-serviceworker.js', import.meta.url), 'utf8');
assert.match(
  serviceWorker,
  /if \(url\.origin !== self\.location\.origin\) return;/,
  'COI worker must leave all cross-origin requests to the page',
);

console.log('Local Network Access tests passed.');

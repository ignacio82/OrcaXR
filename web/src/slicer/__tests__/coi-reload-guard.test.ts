import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The COI shim's reload decision.
 *
 * In-browser slicing needs SharedArrayBuffer, which needs cross-origin
 * isolation, which on GitHub Pages comes from a service worker that adds
 * COOP/COEP to each response. A reload that bypasses the service worker — the
 * browser's hard reload does — delivers an un-isolated document, and the shim's
 * one job at that point is to reload once so the worker can serve the headers.
 */
// The shim is a plain script served as-is, and this package is ESM, so how Node
// classifies the file depends on the loader. Copying it to a `.cjs` name makes
// the choice explicit: it loads through the export seam, never the worker
// branch, whatever the loader would otherwise have guessed.
const shimPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'public', 'coi-serviceworker.js');
const shimCopy = join(mkdtempSync(join(tmpdir(), 'coi-shim-')), 'coi-serviceworker.cjs');
writeFileSync(shimCopy, readFileSync(shimPath));
const { decideCoiReload, COOLDOWN_MS } = createRequire(import.meta.url)(shimCopy) as {
  decideCoiReload: (state: {
    crossOriginIsolated: boolean;
    secureContext: boolean;
    serviceWorkerAvailable: boolean;
    lastAttemptMs: string | number | null;
    nowMs: number;
  }) => { reload: boolean; clearGuard: boolean };
  COOLDOWN_MS: number;
};

const isolatedPage = {
  crossOriginIsolated: true,
  secureContext: true,
  serviceWorkerAvailable: true,
  lastAttemptMs: null,
  nowMs: 1_000_000,
};
const strandedPage = { ...isolatedPage, crossOriginIsolated: false };

let passed = 0;
function test(name: string, run: () => void): void {
  run();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

test('an isolated page neither reloads nor keeps a stale guard', () => {
  assert.deepEqual(decideCoiReload(isolatedPage), { reload: false, clearGuard: true });
  // Clearing on success is the whole fix: the guard must not outlive the load
  // that set it, or it suppresses the next recovery.
  assert.deepEqual(decideCoiReload({ ...isolatedPage, lastAttemptMs: '999000' }), { reload: false, clearGuard: true });
});

test('an un-isolated page reloads once to pick up the headers', () => {
  assert.deepEqual(decideCoiReload(strandedPage), { reload: true, clearGuard: false });
});

test('a reload just attempted does not immediately reload again', () => {
  const justTried = { ...strandedPage, lastAttemptMs: String(strandedPage.nowMs - 1_000) };
  assert.equal(decideCoiReload(justTried).reload, false, 'a browser that cannot isolate must not loop');
});

test('a page stranded long after its last attempt still recovers', () => {
  const longAgo = { ...strandedPage, lastAttemptMs: String(strandedPage.nowMs - COOLDOWN_MS - 1) };
  assert.equal(decideCoiReload(longAgo).reload, true);
});

test('the hard-reload sequence that broke slicing now recovers', () => {
  // 1. A normal load isolates the page and clears the guard.
  const first = decideCoiReload(isolatedPage);
  assert.equal(first.clearGuard, true);
  const guardAfterSuccess = first.clearGuard ? null : '1';

  // 2. The operator hard-reloads. The service worker is bypassed, so the
  //    document arrives with no isolation headers.
  const afterHardReload = decideCoiReload({
    ...strandedPage,
    lastAttemptMs: guardAfterSuccess,
    nowMs: strandedPage.nowMs + 60_000,
  });

  // 3. Under the old boolean guard this was `false` and the tab stayed
  //    un-isolated for the rest of the session.
  assert.equal(afterHardReload.reload, true, 'a hard reload must not strand the tab without SharedArrayBuffer');
});

test('an insecure or service-worker-less context gives up quietly', () => {
  assert.equal(decideCoiReload({ ...strandedPage, secureContext: false }).reload, false);
  assert.equal(decideCoiReload({ ...strandedPage, serviceWorkerAvailable: false }).reload, false);
});

console.log(`\nCOI reload guard: ${passed} tests passed.`);

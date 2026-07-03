/*
 * coi-serviceworker — makes the page cross-origin isolated on static hosts that
 * can't send COOP/COEP response headers (e.g. GitHub Pages), so the WASM
 * slicer's SharedArrayBuffer worker threads can run.
 *
 * COEP is set to `credentialless` (not `require-corp`) so XR Blocks' cross-origin
 * CDN assets keep loading without a CORP header on every response — the same
 * policy the dev/preview server uses.
 *
 * Adapted from github.com/gzuidhof/coi-serviceworker (MIT). No caching: it just
 * re-serves each response with the isolation headers added.
 */
if (typeof window === 'undefined') {
  // ---------- service worker context ----------
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

  self.addEventListener('fetch', (event) => {
    const req = event.request;
    // Let the browser handle its own cache-only revalidation requests.
    if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

    event.respondWith(
      fetch(req.mode === 'no-cors' ? new Request(req, { credentials: 'omit' }) : req)
        .then((res) => {
          if (res.status === 0) return res; // opaque — can't touch headers
          const headers = new Headers(res.headers);
          headers.set('Cross-Origin-Opener-Policy', 'same-origin');
          headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
          return new Response(res.body, {
            status: res.status,
            statusText: res.statusText,
            headers,
          });
        })
        .catch((err) => {
          console.error('[coi] fetch failed', err);
          return fetch(req);
        }),
    );
  });
} else {
  // ---------- page context: register + one-time reload ----------
  (function () {
    if (window.crossOriginIsolated) return;        // already isolated (real headers)
    if (!window.isSecureContext) return;           // SW needs https or localhost
    if (!('serviceWorker' in navigator)) return;
    const script = document.currentScript;
    const src = script && script.src;
    if (!src) return;

    navigator.serviceWorker.register(src).then((reg) => {
      // On first load we're not yet controlled; once the worker is ready,
      // reload exactly once so the fresh document response carries the
      // isolation headers. A session guard prevents any reload loop if the
      // browser can't isolate (older/no-SW browsers just run un-isolated).
      if (!navigator.serviceWorker.controller) {
        const KEY = 'coiReloaded';
        navigator.serviceWorker.ready.then(() => {
          if (!sessionStorage.getItem(KEY)) {
            sessionStorage.setItem(KEY, '1');
            window.location.reload();
          }
        });
      }
    }).catch((err) => console.error('[coi] registration failed', err));
  })();
}

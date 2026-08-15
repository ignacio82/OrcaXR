/*
 * coi-serviceworker — makes the page cross-origin isolated on static hosts that
 * can't send COOP/COEP response headers (e.g. GitHub Pages), so the WASM
 * slicer's SharedArrayBuffer worker threads can run.
 *
 * COEP is set to `credentialless` (not `require-corp`) so explicit printer,
 * model-catalog, and AI requests remain possible under the same policy used by
 * the dev/preview server. Product UI assets, including XR icons, are local.
 *
 * Adapted from github.com/gzuidhof/coi-serviceworker (MIT). Same-origin app
 * resources use versioned shell/runtime caches, while slicer artifacts use a
 * separate bounded cache. Cross-origin requests bypass this worker.
 */
// Long enough that a browser which simply cannot isolate reloads once and then
// stops; short enough that a later un-isolated load still recovers.
const COI_COOLDOWN_MS = 10_000;

/**
 * Should this load reload itself to become cross-origin isolated?
 *
 * The previous guard was a boolean set on the first reload and never cleared,
 * which made it permanent for the tab. A reload that bypasses the service
 * worker — the browser's hard reload does exactly this — delivers a document
 * with no COOP/COEP headers, and the stale guard then suppressed the one reload
 * that would have restored isolation. The tab stayed un-isolated for the rest of
 * the session and in-browser slicing failed with "needs a cross-origin-isolated
 * context".
 *
 * So: success clears the guard, and the guard is a timestamp rather than a flag.
 * It exists to stop a reload *loop*, not to stop recovery.
 */
function decideCoiReload(state) {
  if (state.crossOriginIsolated) return { reload: false, clearGuard: true };
  if (!state.secureContext || !state.serviceWorkerAvailable) return { reload: false, clearGuard: false };
  const lastAttemptMs = Number(state.lastAttemptMs) || 0;
  const recentlyTried = lastAttemptMs > 0 && state.nowMs - lastAttemptMs < COI_COOLDOWN_MS;
  return { reload: !recentlyTried, clearGuard: false };
}

// Test seam: the decision is pure, so it is checked directly rather than by
// trying to reproduce a header-stripping reload in a headless browser. Neither
// a page nor a service worker defines `module`.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { decideCoiReload, COOLDOWN_MS: COI_COOLDOWN_MS };
} else if (typeof window === 'undefined') {
  // ---------- service worker context ----------
  const CACHE_PREFIX = 'orcaxr-coi-';
  const SHELL_CACHE = `${CACHE_PREFIX}shell-v2`;
  const SLICER_CACHE = `${CACHE_PREFIX}slicer-v1`;

  const withIsolationHeaders = (res) => {
    if (res.status === 0) return res;
    const headers = new Headers(res.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };

  const precacheShell = async () => {
    const scope = new URL(self.registration.scope);
    const cache = await caches.open(SHELL_CACHE);
    const indexRequest = new Request(scope, { credentials: 'same-origin' });
    const indexResponse = await fetch(indexRequest);
    if (!indexResponse.ok) throw new Error(`App shell returned ${indexResponse.status}`);
    await cache.put(indexRequest, indexResponse.clone());

    const html = await indexResponse.text();
    const resources = new Set([
      new URL('coi-serviceworker.js', scope).href,
      new URL('icon.svg', scope).href,
      new URL('manifest.json', scope).href,
    ]);
    for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      const url = new URL(match[1], scope);
      if (url.origin === scope.origin && !url.href.startsWith('data:')) resources.add(url.href);
    }

    const iconManifestUrl = new URL('icons/material/manifest.json', scope);
    const iconManifestResponse = await fetch(iconManifestUrl);
    if (iconManifestResponse.ok) {
      const icons = await iconManifestResponse.clone().json();
      resources.add(iconManifestUrl.href);
      for (const file of icons) resources.add(new URL(`icons/material/${file}`, scope).href);
    }
    await cache.addAll([...resources]);
  };

  self.addEventListener('install', (event) => {
    event.waitUntil(precacheShell().then(() => self.skipWaiting()));
  });
  self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(CACHE_PREFIX) && ![SHELL_CACHE, SLICER_CACHE].includes(name)) {
          await caches.delete(name);
        }
      }
      await self.clients.claim();
    })());
  });

  self.addEventListener('fetch', (event) => {
    const req = event.request;
    
    // Let the page own every cross-origin fetch. This is required for Local
    // Network Access permission (HTTP or HTTPS), and COEP: credentialless
    // already governs the document's cross-origin subresources.
    try {
      const url = new URL(req.url);
      if (url.origin !== self.location.origin) return;
    } catch (e) {}

    // Let the browser handle its own cache-only revalidation requests.
    if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

    if (req.method !== 'GET' || req.headers.has('range')) return;

    // The engine remains NetworkFirst and in its own bounded-by-inventory
    // cache. Other same-origin resources are also refreshed online and fall
    // back to the versioned shell/runtime cache when offline.
    const scope = new URL(self.registration.scope);
    const slicerPath = new URL('slicer/', scope).pathname;
    const cacheName = new URL(req.url).pathname.startsWith(slicerPath)
      ? SLICER_CACHE
      : SHELL_CACHE;
    event.respondWith((async () => {
      const request = req.mode === 'no-cors'
        ? new Request(req, { credentials: 'omit' })
        : req;
      const cache = await caches.open(cacheName);
      try {
        const response = await fetch(request);
        if (response.ok) {
          await cache.put(req, response.clone());
          if (cacheName === SLICER_CACHE) {
            const keys = await cache.keys();
            for (const stale of keys.slice(0, Math.max(0, keys.length - 4))) {
              await cache.delete(stale);
            }
          }
        }
        return withIsolationHeaders(response);
      } catch (error) {
        const cached = await cache.match(req, { ignoreSearch: false })
          || (req.mode === 'navigate' ? await cache.match(scope) : undefined);
        if (cached) return withIsolationHeaders(cached);
        console.error('[coi] offline cache miss', error);
        return new Response('OrcaXR is offline and this resource is not cached.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })());
  });
} else {
  // ---------- page context: register + guarded recovery reload ----------
  (function () {
    const KEY = 'coiReloadedAt';

    const readGuard = () => {
      try {
        return sessionStorage.getItem(KEY);
      } catch {
        return null; // Storage can be blocked; treat it as "never tried".
      }
    };
    const writeGuard = (value) => {
      try {
        if (value === null) sessionStorage.removeItem(KEY);
        else sessionStorage.setItem(KEY, value);
      } catch {
        // A tab that cannot remember its attempt still reloads at most once
        // per load, and the cooldown below is what prevents a tight loop.
      }
    };

    const decision = decideCoiReload({
      crossOriginIsolated: window.crossOriginIsolated === true,
      secureContext: window.isSecureContext === true,
      serviceWorkerAvailable: 'serviceWorker' in navigator,
      lastAttemptMs: readGuard(),
      nowMs: Date.now(),
    });
    if (decision.clearGuard) writeGuard(null);
    if (window.crossOriginIsolated) return; // already isolated (real headers)

    const script = document.currentScript;
    const src = script && script.src;
    if (!src) return;

    navigator.serviceWorker
      .register(src)
      .then(() => {
        if (!decision.reload) return;
        // Once the worker is ready the next document response carries the
        // isolation headers, so one reload is what turns this page isolated.
        navigator.serviceWorker.ready.then(() => {
          writeGuard(String(Date.now()));
          window.location.reload();
        });
      })
      .catch((err) => console.error('[coi] registration failed', err));
  })();
}

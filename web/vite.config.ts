import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages deploy (ORCAXR_DEPLOY=1): serve under /slicer/ and drop the
// VitePWA service worker — the coi-serviceworker shim owns the SW scope there
// (two SWs can't both control /slicer/), and it's what makes the WASM slicer's
// SharedArrayBuffer threads work on a host that can't send COOP/COEP headers.
const deploy = process.env.ORCAXR_DEPLOY === '1';
const securityHeaders = {
  'Content-Security-Policy':
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob: http: https:; media-src 'self' blob: http: https:; connect-src 'self' data: blob: http: https: ws: wss:; form-action 'self'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), xr-spatial-tracking=(self)',
};

export default defineConfig({
  base: deploy ? '/slicer/' : '/',
  build: {
    ...(deploy ? { outDir: '../docs/slicer', emptyOutDir: true } : {}),
    rollupOptions: {
      output: {
        // Stable vendor chunk names keep the entry budget independent from
        // shared runtimes and let Workbox omit optional SDKs from first install.
        // A regular model/slice session should not download AI or Gaussian-splat
        // rendering code just to become available offline.
        manualChunks: {
          genai: ['@google/genai'],
          // Keep the shared renderer/runtime out of the application entry.
          // This chunk is still precached for offline/XR startup, but feature
          // growth in canonical project handling no longer inflates the entry
          // script past its independently enforced budget.
          three: ['three', 'three-mesh-bvh'],
          uikit: ['@pmndrs/uikit'],
        },
      },
    },
  },
  plugins: deploy
    ? []
    : [
        VitePWA({
          registerType: 'autoUpdate',
          includeAssets: ['icon.svg', 'icons/material/*.svg', 'profiles/catalog.json'],
          workbox: {
            maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
            ignoreURLParametersMatching: [/^t$/],
            // The slicer WASM module (slic3r.mjs + the ~16 MB slic3r.wasm) is
            // rebuilt whenever libslic3r changes. Precaching it cache-first pins a
            // stale copy: the browser keeps serving the old binary even after the
            // server ships a fix, which manifests as a slice that hangs forever on
            // an outdated engine. Keep it OUT of the precache manifest and serve it
            // NetworkFirst instead — always fresh when online, with a cached
            // fallback so offline XR use still works after one online load.
            globIgnores: [
              '**/slicer/**',
              // Optional features use normal network-on-demand requests. Keeping
              // them out of precache protects first launch on headset Wi-Fi.
              '**/assets/SimulatorAddons-*.js',
              '**/assets/genai-*.js',
              '**/assets/spark.module-*.js',
              // Upstream calibration geometry: 1.7 MB that only matters to an
              // operator actually running a flow or tolerance calibration.
              // Precaching it would make every install pay for a feature most
              // people never open, and it is verified by hash on arrival, so a
              // cached-and-stale copy would be refused rather than used.
              '**/calibration/*.3mf',
              '**/calibration/*.stl',
            ],
            cleanupOutdatedCaches: true,
            runtimeCaching: [
              {
                // The generated schema is larger than Workbox's default
                // precache patterns and is fetched by URL at runtime. Cache the
                // exact content-hashed v2 asset only after a successful online
                // load so the settings panel remains available offline without
                // pinning an old schema while connected.
                urlPattern: ({ url }: { url: URL }) =>
                  /\/assets\/engine-options\.schema-[^/]+\.json$/.test(url.pathname),
                handler: 'NetworkFirst',
                options: {
                  cacheName: 'orcaxr-settings-schema',
                  expiration: { maxEntries: 2 },
                  cacheableResponse: { statuses: [0, 200] },
                },
              },
              {
                urlPattern: ({ url }: { url: URL }) => url.pathname.startsWith('/slicer/'),
                handler: 'NetworkFirst',
                options: {
                  cacheName: 'orcaxr-slicer',
                  expiration: { maxEntries: 4 },
                  cacheableResponse: { statuses: [0, 200] },
                },
              },
            ],
          },
          manifest: {
            name: 'OrcaXR Slicer',
            short_name: 'OrcaXR',
            description: 'OrcaXR pure-web front-end: XR Blocks + three.js workspace',
            theme_color: '#14171a',
            background_color: '#14171a',
            display: 'standalone',
            icons: [
              {
                src: 'icon.svg',
                sizes: '192x192 512x512',
                type: 'image/svg+xml',
                purpose: 'any',
              },
            ],
          },
        }),
      ],
  server: {
    // Reachable from the headset via `adb reverse tcp:8081 tcp:8081`
    // (Chrome on the headset opens http://localhost:8081 — localhost is a
    // secure context, so WebXR works without certificates).
    host: '0.0.0.0',
    port: 8081,
    // SharedArrayBuffer needs COOP/COEP. CSP deliberately permits explicit
    // LAN/AI/printer connections but blocks remote scripts, frames, objects,
    // and UIBlocks' CDN icon path.
    headers: securityHeaders,
    proxy: {
      '^/moonraker/.*': {
        target: 'http://localhost', // target will be rewritten
        changeOrigin: true,
        router: (req) => {
          const parts = req?.url?.split('/') || [];
          const target = parts[2];
          if (!target) return 'http://localhost';
          return `http://${target}`;
        },
        rewrite: (path) => {
          const parts = path.split('/');
          return '/' + parts.slice(3).join('/');
        },
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            // Strip the origin header to avoid Moonraker's CORS check
            proxyReq.removeHeader('origin');
          });
        },
      },
    },
  },
  preview: {
    headers: securityHeaders,
  },
});

import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages deploy (ORCAXR_DEPLOY=1): serve under /slicer/ and drop the
// VitePWA service worker — the coi-serviceworker shim owns the SW scope there
// (two SWs can't both control /slicer/), and it's what makes the WASM slicer's
// SharedArrayBuffer threads work on a host that can't send COOP/COEP headers.
const deploy = process.env.ORCAXR_DEPLOY === '1';

export default defineConfig({
  base: deploy ? '/slicer/' : '/',
  build: deploy ? { outDir: '../docs/slicer', emptyOutDir: true } : {},
  plugins: deploy ? [] : [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      workbox: {
        maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
        // The slicer WASM module (slic3r.mjs + the ~16 MB slic3r.wasm) is
        // rebuilt whenever libslic3r changes. Precaching it cache-first pins a
        // stale copy: the browser keeps serving the old binary even after the
        // server ships a fix, which manifests as a slice that hangs forever on
        // an outdated engine. Keep it OUT of the precache manifest and serve it
        // NetworkFirst instead — always fresh when online, with a cached
        // fallback so offline XR use still works after one online load.
        globIgnores: ['**/slicer/**'],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
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
            purpose: 'any'
          }
        ]
      }
    })
  ],
  server: {
    // Reachable from the headset via `adb reverse tcp:8081 tcp:8081`
    // (Chrome on the headset opens http://localhost:8081 — localhost is a
    // secure context, so WebXR works without certificates).
    host: '0.0.0.0',
    port: 8081,
    headers: {
      // SharedArrayBuffer for the WASM slicer's pthreads. `credentialless`
      // (not `require-corp`) keeps XR Blocks' CDN-hosted assets loadable
      // without CORP headers on every response.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
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
        }
      }
    }
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
});

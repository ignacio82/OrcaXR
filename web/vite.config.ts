import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      workbox: {
        maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
      },
      manifest: {
        name: 'OrcaXR Web',
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
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
});

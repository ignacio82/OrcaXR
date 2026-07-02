import { defineConfig } from 'vite';

export default defineConfig({
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

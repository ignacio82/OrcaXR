/**
 * The engine builds this client will accept for canonical work.
 *
 * Two engines can carry canonical slicing, and each proves a different thing:
 *
 * - **WASM** — the build this client verified for itself, generated from
 *   `wasm/artifact-provenance.json` and checked by
 *   `npm --prefix wasm run verify:artifacts`. An external server running WASM
 *   must attest to exactly these artifacts.
 * - **CLI** — the official Snapmaker Orca Slicer, built from the pinned commit
 *   in the same image that runs it. Comparing its digest to the WASM artifacts
 *   would be meaningless, so what is pinned instead is the upstream commit and
 *   the exact set of OrcaXR patches applied on top. Those patches are the whole
 *   difference from stock upstream — they make headless multi-filament slicing
 *   behave as the desktop GUI does — so an engine carrying a patch this build
 *   does not know about is refused by name rather than waved through.
 *
 * Keep `CLI_PATCHES` in step with `server/patches/`; `npm run parity:verify`
 * fails when they drift.
 */
export const PINNED_ENGINE_PROVENANCE = Object.freeze({
  commit: '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626',
  /** Pinned Snapmaker Orca release the CLI engine is built from. */
  cliVersion: '2.3.4',
  artifacts: Object.freeze({
    'slic3r.mjs': 'b90d06ccfeb526a4d0d7e08a56ebb5401175f7337f7d9b35c039bd738448f03e',
    'slic3r.wasm': '746503927b36b2d86b63413937f4cef357ac5ab0fe42489bea7cebf41e72a221',
  }),
  /** `server/patches/`, by name and digest, in the order they are applied. */
  cliPatches: Object.freeze({
    '0001-cli-safe-expand-plate-extruders.patch': '0b5cf28ff6c28d00a9a580297c4f97304d1dbcb2d9da6a7f93fc2a95a73a37da',
    '0002-normalize-fdm-partial-config-null-nozzle.patch':
      '7ae55127a840422c143846b932a579d648f7e11d0c8cd052abf301ef030e8b5a',
    '0003-gcodeprocessor-fullspectrum-oob.patch': '73402637904ff1500e04e1ca60fe287df74d8d6b930e5b7889737c729f7d9a7a',
    '0004-cli-safe-plate-name-texture.patch': '8d6df350cba4a0d3ec4b18cc71ba790129d0c00c0a3e5eb1c4a430f323ca1646',
  }),
});

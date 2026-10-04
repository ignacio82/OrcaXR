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
    'slic3r.wasm': '8e9b05f710dd5c6621eaff315477cbe8520a3778f2d31a27e6275b051e0d5cdc',
  }),
  /** `server/patches/`, by name and digest, in the order they are applied. */
  cliPatches: Object.freeze({
    '0001-cli-safe-expand-plate-extruders.patch': '0b5cf28ff6c28d00a9a580297c4f97304d1dbcb2d9da6a7f93fc2a95a73a37da',
    '0002-normalize-fdm-partial-config-null-nozzle.patch':
      '7ae55127a840422c143846b932a579d648f7e11d0c8cd052abf301ef030e8b5a',
    '0003-gcodeprocessor-fullspectrum-oob.patch': '73402637904ff1500e04e1ca60fe287df74d8d6b930e5b7889737c729f7d9a7a',
    '0004-cli-safe-plate-name-texture.patch': '8d6df350cba4a0d3ec4b18cc71ba790129d0c00c0a3e5eb1c4a430f323ca1646',
  }),
  /**
   * Features each attested engine carries beyond stock Snapmaker Orca. The
   * wave-overhang port is in the WASM build only (`wasm/patches/`); none of the
   * CLI patches above add it, so a CLI server reads no wave key and prints those
   * overhangs as though the switch were off. Attestation pins each engine to an
   * exact build, which is what makes this list knowable; change it in the same
   * commit that changes either patch set.
   */
  features: Object.freeze({
    wasm: Object.freeze(['wave-overhangs'] as const),
    cli: Object.freeze([] as const),
  }),
});

export type EngineKind = keyof typeof PINNED_ENGINE_PROVENANCE.features;
export type EngineFeature = (typeof PINNED_ENGINE_PROVENANCE.features)[EngineKind][number];

export function engineSupports(engine: EngineKind, feature: EngineFeature): boolean {
  return (PINNED_ENGINE_PROVENANCE.features[engine] as readonly EngineFeature[]).includes(feature);
}

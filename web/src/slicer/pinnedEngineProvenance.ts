/**
 * The engine build this client verified for itself, generated from
 * `wasm/artifact-provenance.json` and checked by `npm --prefix wasm run
 * verify:artifacts`. An external slicer may only receive canonical work when it
 * attests to exactly these artifacts.
 */
export const PINNED_ENGINE_PROVENANCE = Object.freeze({
  commit: '9fd12ffb2b1b80c9fb4c14564754d2ec1573a626',
  artifacts: Object.freeze({
    'slic3r.mjs': 'b90d06ccfeb526a4d0d7e08a56ebb5401175f7337f7d9b35c039bd738448f03e',
    'slic3r.wasm': '746503927b36b2d86b63413937f4cef357ac5ab0fe42489bea7cebf41e72a221',
  }),
});

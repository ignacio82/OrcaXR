# OrcaXR parity fixtures

This directory contains a compact, redistributable **synthetic oracle seed**. It is designed to
prove that structural comparison notices semantic loss before larger official-Orca fixtures are
qualified. It is not evidence that OrcaXR has full Snapmaker Orca parity.

The generated `reference.3mf` deliberately exercises archive relationships, a multi-object /
multi-part component graph, repeated instances, build transforms, physical and virtual filament
assignments, object/part/layer settings, all four FullSpectrum recipe modes, color/support/seam/
fuzzy facet payloads, modifier and negative volumes, two plates, custom G-code, and an unknown
extension member. The representative G-code exercises layers, tool order, roles, motion bounds,
absolute and relative extrusion, temperatures, estimates, and stable warnings. The tiny OBJ,
STL, and STEP files use the same analytic tetrahedron geometry.

Run from the repository root:

```sh
node tools/parity-oracles/generate-fixtures.mjs --check
node tools/parity-oracles/self-test.mjs
node tools/parity-oracles/compare-3mf.mjs \
  testdata/parity/fixtures/reference.3mf testdata/parity/fixtures/reference.3mf
node tools/parity-oracles/compare-gcode.mjs \
  testdata/parity/fixtures/reference.gcode testdata/parity/fixtures/reference.gcode
```

`recipes/reference-project/` is the unpacked source for the deterministic stored ZIP. Mutation
descriptors remove one load-bearing value at a time; generated mutation fixtures are committed so
CI does not depend on a local slicer. ZIP member order, compression, and timestamps are ignored by
the comparator. Member names, relationships, XML/config semantics, and every unknown payload are
not ignored.

`expected/reference.semantic.json` is the reviewed compact golden projection (including a hash of
the complete normalized 3MF), so an intentional recipe change produces a legible semantic diff.

`provenance.json` records why each source is redistributable. `generated-manifest.json` records the
SHA-256 and recipe for every generated artifact. Real qualification artifacts from the pinned
Snapmaker Orca application/CLI must be recorded separately with command, profile hash, source
commit, engine hash, and reviewer; do not relabel this synthetic seed as that evidence.

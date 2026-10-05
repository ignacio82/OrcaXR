# Canonical slice reference fixtures

These fixtures provide known input bytes and published-browser-engine outputs
for the [native Android migration](../android-native-rust-plan.md). They do not
qualify an Android engine, application route or physical printer. Generated
archives, G-code and reports stay under the ignored `tools/native-engine/build/`
directory. Only synthetic, redistributable geometry is used.

`generate-slice-fixtures.mjs` uses the existing canonical project fixture,
profile catalog and `Bbs3mfProjectSerializer`. It hashes the project/profile
sources and each generated archive/configuration pair. The fixture profile must
be the bundled Snapmaker U1 0.4 mm profile; an unrelated fallback is rejected.
These are single-plate serializer inputs, not a replay of the application's
complete preflight, profile capture or multi-plate projection flow. Configuration
is embedded in the canonical/BBS archive; the additional override files are
empty. Native route qualification must subsequently cover those host workflows.

The eleven cases cover a plain cube, physical color paint, FullSpectrum mixed paint,
object wall count, part infill density, a height-range layer override, manual
support with/without enforcement, automatic support with/without a blocker,
and wave overhangs. All five overhang cases use one closed
L-section prism with consistently wound manifold edges and a checked 3,100 mm³
volume. Its shelf starts at 8 mm and extends 15 mm past a 10 mm pillar. The older
support harness's edge-touching boxes provide no supported area beneath their
upper section and produced no wave paths; they are not used for this comparison.

`slice-reference.mjs` verifies the published WASM artifact set, rejects changed,
missing, duplicate, indirect or escaping fixture inputs, and runs each actual
archive slice in a separate owned process. Each process consumes bytes checked
against the captured digests and exits after output handoff, releasing its WASM
heap/workers. It has a 180-second deadline, a 128 MiB G-code limit and bounded
diagnostics. Engine text and full G-code are excluded from failure messages.
Output files remain diagnostic inputs until every case and feature check passes
and the result manifest is written.

The checks require observable tool changes from physical/mixed paint, increased
material from scoped walls/infill, support paths added by manual enforcement
and removed by a blocker from an automatic-support baseline, extra layers only
inside the selected height band, and positive
XY extrusion in every wave block. Wave settings or header strings alone are
insufficient. The report records G-code hashes and summaries from the existing
independent parity oracle, together with engine, fixture, runner and oracle
identities. Future native comparisons must consume these exact captured inputs
and the established oracle without relaxing its tolerances to mask differences.

Run with the installed, locked web development dependencies:

```sh
npm --prefix wasm run verify:artifacts
node --import ./web/node_modules/tsx/dist/loader.mjs tools/native-engine/generate-slice-fixtures.mjs
node tools/native-engine/test-reference-inputs.mjs <generated-manifest-path>
node tools/native-engine/slice-reference.mjs <generated-manifest-path>
```

`slice-reference.mjs <generated-manifest-path> --check-inputs` validates inputs
without instantiating the engine. Seven guard cases exercise the valid capture
and six deliberate corruptions using temporary copies. The separate native CI
fixture job runs the same commands and retains generated evidence for seven days.
Its declaration does not establish a completed hosted CI run.

Local evidence on 2026-10-05: all eleven real archive slices and their semantic
checks pass, including 44 extruding wave blocks, and all seven input guard cases
pass. The captured fixture manifest SHA-256 is
`59c11bd1fa2829e10e079cc47e7fe541e27a6c720b6b0e4daee9818dc163679e`;
the reference report SHA-256 is
`9b7fdf46ef7374ed06af47403e0b4916b9e8b04ab8d8567630cdbf5f86d3119f`.
Its eleven G-code outputs total 5,707,502 bytes. Manual enforcement adds 27
support-path markers and increases reported filament use from 848.28 to
1,114.65 mm; a blocker removes the same automatic support and returns material
use to 848.28 mm. Repeated generation can record a
new host commit or engine timestamp; compare the captured identities and print
semantics, not an assumed byte-identical output across separate runs.

Native compilation, identical-input Android slicing, output comparison,
arm64/16 KB runtime checks and physical-device qualification remain open. No
migration phase exit is closed by these browser reference results.

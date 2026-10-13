# Third-party attributions

OrcaXR builds on several upstream projects. Source pinned by submodule
or by snapshot date in this file.

## Shared Rust archive reader

The development `orcaxr-archive` crate uses the pure Rust DEFLATE backend and
checksums below, pinned by `core/Cargo.lock`. These dependencies are not yet
linked into the production browser package or Android application. License
identifiers are taken from the corresponding published crate manifests.

| Crate | Version | License | Source |
| --- | --- | --- | --- |
| flate2 | 1.1.10 | MIT OR Apache-2.0 | [flate2-rs](https://github.com/rust-lang/flate2-rs) |
| miniz_oxide | 0.9.1 | MIT OR Zlib OR Apache-2.0 | [miniz_oxide](https://github.com/Frommi/miniz_oxide) |
| crc32fast | 1.5.2 | MIT OR Apache-2.0 | [rust-crc32fast](https://github.com/srijs/rust-crc32fast) |
| adler2 | 2.0.1 | 0BSD OR MIT OR Apache-2.0 | [adler2](https://github.com/oyvindln/adler2) |
| simd-adler32 | 0.3.10 | MIT | [simd-adler32](https://github.com/mcountryman/simd-adler32) |

## Unicode normalization for export file names

`orcaxr_archive::exports` offers a merged STL and a saved project under the
browser's suggested names, which apply NFKC. It uses ICU4X's normalizer,
pinned by `core/Cargo.lock` and already linked through the `url` crate's IDNA
support: `icu_normalizer` 2.3.0 and `icu_normalizer_data` 2.3.0 (Unicode 17
data), with `icu_collections`, `icu_provider`, `icu_properties`, `zerovec`,
`yoke`, `zerofrom`, `zerotrie`, `tinystr`, `writeable`, `litemap` and
`potential_utf`, all **Unicode-3.0**
([ICU4X](https://github.com/unicode-org/icu4x)); `smallvec` and
`stable_deref_trait` are MIT OR Apache-2.0, `utf8_iter` Apache-2.0 OR MIT.

## Unicode package casing

`contracts/opc-lowercase.json` and its generated Rust/TypeScript tables pin
Unicode 16 default lowercase mappings and Cased/Case_Ignorable properties,
captured from Node 22.21.0 (V8/ICU Unicode 16.0). They stabilize OPC declarations
across runtime upgrades. Unicode data: Copyright © 1991-2026 Unicode, Inc.;
**[Unicode License V3](https://www.unicode.org/license.txt)**, retained in
[`core/licenses/Unicode-3.0.txt`](core/licenses/Unicode-3.0.txt).
See the [Unicode 16 default case algorithms](https://www.unicode.org/versions/Unicode16.0.0/core-spec/chapter-3/).

## OrcaSlicer

`third_party/OrcaSlicer/` is a git submodule pinned to upstream
`SoftFever/OrcaSlicer` tag **v2.3.2**. Source at
https://github.com/SoftFever/OrcaSlicer.

License: **GNU AGPL v3.0** (`third_party/OrcaSlicer/LICENSE`). OrcaXR
links libslic3r and is therefore AGPL-bound.

## u1-slicer-for-android (mobile GL viewer)

`app/src/main/java/dev/orcaxr/app/mobile/viewer/{Camera,ShaderProgram,
MeshData,BaseGLViewerView,ModelRenderer,ModelViewerView}.kt` and
`app/src/main/assets/shaders/{model,grid}.{vert,frag}` are ported from
`taylormadearmy/u1-slicer-for-android`, snapshotted from `main` on
2026-05-07. Source at
https://github.com/taylormadearmy/u1-slicer-for-android.

License: **GNU AGPL v3.0**. Slimmed for OrcaXR's mobile shell — bed +
grid + single mesh + orbit + drag-to-move. The upstream viewer also
ships a Snapmaker U1 logo texture, a bundled `bed/u1_bed.stl`,
multi-instance arrange, a wipe-tower box, and per-extruder vertex
recoloring; OrcaXR drops these (or moves them to the XR shell) and
generates a rectangular bed mesh at runtime from the active profile's
`printable_area` so any printer's bed renders without shipping
per-vendor STLs. Two-light shader constants in `model.vert` match
upstream byte-for-byte.

## Snapmaker OrcaSlicer profiles

`app/src/main/java/dev/orcaxr/app/SlicerProfile.kt` carries
`Snapmaker_U1_PLA_Standard` — a flattened profile derived from
`Snapmaker/OrcaSlicer`'s `resources/profiles/Snapmaker/{machine,
process, filament}/...` JSON files. Source at
https://github.com/Snapmaker/OrcaSlicer.

Snapshotted from `main` branch in 2026-04. We do **not** copy the
verbatim `machine_start_gcode` / `machine_end_gcode` /
`change_filament_gcode` macro blocks (those reference Snapmaker-stock
Klipper macros that don't exist on vanilla MainsailOS / FluiddPi).
What we copy is slicing-relevant scalar data (layer heights, walls,
infill, temperatures, fan curves, retraction, max accelerations) plus
factual machine geometry (bed size, nozzle diameter, Z height).

`app/src/main/assets/profiles/Snapmaker/filament/Snapmaker PLA*` are
byte-identical snapshots of the Snapmaker fork's branded U1 PLA-family
leaves and their inheritance ancestors (`fdm_filament_common.json`,
`fdm_filament_pla.json`, `fdm_filament_pla_eco.json`, plus each
`Snapmaker PLA … @U1 base.json` / `Snapmaker PLA … @U1.json` pair for
PLA, PLA Matte, PLA Eco, PLA Silk, PLA Metal, PLA-CF). These feed the
B3 per-slot filament-type override path with material-tuned
`nozzle_temperature` / `pressure_advance` / `filament_max_volumetric_speed`
values without rewriting the active machine profile.

`app/src/main/assets/profiles/Snapmaker/machine/Snapmaker U1 (0.{2,8}
nozzle).json` plus the matching `process/0.{06..14} … (0.2 nozzle)` /
`0.{24..56} … (0.8 nozzle)` leaves and their `fdm_process_U1_<height>_
nozzle_<dia>` parents are byte-identical snapshots of Snapmaker fork
v2.3.1, vendored under F1 to round out the U1 nozzle picker (alongside
the previously vendored 0.4 + 0.6 sets).

`app/src/main/assets/profiles/Snapmaker/filament/Snapmaker (ABS|ASA|
PETG|PETG-CF) @U1{,base}.json` plus their `fdm_filament_(abs|asa|
petg).json` parents are byte-identical snapshots of Snapmaker fork
v2.3.1, vendored under F2's "second slice" (PLA family was the first
slice). Adds non-PLA branded leaves to the per-slot dropdown without
expanding into exotic materials (PA / PC / TPU 95A) that gate on F5's
`filament_is_high_temperature` consumer.

License: **GNU AGPL v3.0** — same as the upstream OrcaSlicer fork.

## Elegoo Centauri Carbon OrcaSlicer profiles

`app/src/main/assets/profiles/Elegoo/{machine,process,filament}/*.json`
are byte-identical snapshots of OrcaSlicer's bundled Elegoo profiles
under `resources/profiles/Elegoo/`, taken from the upstream
`SoftFever/OrcaSlicer` v2.3.2 tag. Bundled subset:

* **Machines:** Elegoo Centauri Carbon 0.2 nozzle, 0.4 nozzle, plus
  the `fdm_machine_ecc{,_common}` parents in their `inherits` chain.
* **Processes:** quality tiers 0.08–0.12 mm for the 0.2 nozzle,
  0.12–0.28 mm for the 0.4 nozzle, plus the `fdm_process_ecc_*`
  parents.
* **Filaments:** Elegoo PLA, PLA-CF, PLA Matte (the user's daily
  filaments), Generic PLA / PLA Matte / PETG / ABS @Elegoo, plus
  the `fdm_elegoo_filament_*` and `fdm_filament_*` parents.

License: **GNU AGPL v3.0** — same as the upstream OrcaSlicer fork.

## OkHttp

`com.squareup.okhttp3:okhttp:4.12.0`. License: Apache 2.0. Source at
https://github.com/square/okhttp. Used by `MoonrakerClient` after
Android's stock `HttpURLConnection` proved unreliable against
Mainsail's nginx-fronted Moonraker on the headset's WiFi (see
Phase 3 commit log).

## V8 timestamp parser

`core/crates/orcaxr-project/src/validation/timestamp.rs` adapts the V8 date
parser from Node **v22.21.0**, including its tokenizer, date/time composers,
legacy grammar and explicit UTC-offset overflow behavior. Sources:
[`dateparser-inl.h`](https://github.com/nodejs/node/blob/v22.21.0/deps/v8/src/date/dateparser-inl.h),
[`dateparser.h`](https://github.com/nodejs/node/blob/v22.21.0/deps/v8/src/date/dateparser.h),
[`dateparser.cc`](https://github.com/nodejs/node/blob/v22.21.0/deps/v8/src/date/dateparser.cc),
[`builtins-date.cc`](https://github.com/nodejs/node/blob/v22.21.0/deps/v8/src/builtins/builtins-date.cc).

Copyright 2011 the V8 project authors. License: **BSD-3-Clause**, retained in
[`core/licenses/V8-BSD.txt`](core/licenses/V8-BSD.txt). Distributions containing
this parser must include that notice, license and disclaimer. The Rust library
does not embed a JavaScript engine or a timezone database.

## Bundled assets

`app/src/main/assets/cube_20mm.stl` is a 20 mm calibration cube. It's
trivial geometry but for the record it was generated locally in
April 2026.

`app/src/main/assets/handy_models/` (3DBenchy, Orca Cube v2, Voron
Design Cube v7, Stanford Bunny, Cali Cat, Orca Tolerance Test, Orca
String Hell, Autodesk FDM Test) are vendored verbatim from
`third_party/OrcaSlicer/resources/handy_models/` at upstream tag
**v2.3.2**. Each model carries the license its original author
attached upstream — refer to OrcaSlicer's repository for the per-model
authorship and licensing (3DBenchy is CC-BY-ND, Stanford Bunny is the
Stanford Computer Graphics Laboratory's reference release, Voron
Cube v7 is GPL-3.0, the Orca-authored calibration prints follow
OrcaSlicer's AGPL-3.0). OrcaXR redistributes them unchanged.

`app/src/main/assets/handy_models/calib_*.drc` are the seven core
calibration meshes from `third_party/OrcaSlicer/resources/calib/`
(temperature_tower, retraction_tower, pressure_advance_test,
input_shaping/ringing_tower, vfa, cornering/SCV-V2,
volumetric_speed/SpeedTestStructure), vendored verbatim from upstream
v2.3.2. Same AGPL-3.0 license as the rest of OrcaSlicer's calib tree.
Renamed with a `calib_` prefix on the file system to match the
HandyModelCatalog id namespace; original mesh data unchanged.

---

OrcaXR's own first-party code (everything under `app/src/main/java/`
that isn't a snapshot of upstream values) is licensed under AGPL-3.0
to match libslic3r. The repository as a whole is AGPL-bound the
moment we link libslic3r — the choice is forced, not chosen.

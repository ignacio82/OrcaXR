# Third-party attributions

OrcaXR builds on several upstream projects. Source pinned by submodule
or by snapshot date in this file.

## OrcaSlicer

`third_party/OrcaSlicer/` is a git submodule pinned to upstream
`SoftFever/OrcaSlicer` tag **v2.3.2**. Source at
https://github.com/SoftFever/OrcaSlicer.

License: **GNU AGPL v3.0** (`third_party/OrcaSlicer/LICENSE`). OrcaXR
links libslic3r and is therefore AGPL-bound.

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

## Bundled assets

`app/src/main/assets/cube_20mm.stl` is a 20 mm calibration cube. It's
trivial geometry but for the record it was generated locally in
April 2026.

---

OrcaXR's own first-party code (everything under `app/src/main/java/`
that isn't a snapshot of upstream values) is licensed under AGPL-3.0
to match libslic3r. The repository as a whole is AGPL-bound the
moment we link libslic3r — the choice is forced, not chosen.

# Bambu Studio 3MF → OrcaXR (Snapmaker U1) import

Status: proposed
Inspiration: `Dakros66/DOC-U1-Link` (GPLv3, desktop Python GUI) — we re-implement the rules in Kotlin/JNI to live inside OrcaXR's existing 3MF load path. No source ported; the key-list and template-injection rules are facts.

## Why

OrcaXR opens OrcaSlicer / Snapmaker-flavor 3MFs (`PeggyPalette38+Mini+BRYW.3mf` and similar) end-to-end. A Bambu Studio 3MF carries the same libslic3r config-key names but with **Bambu-specific hardware values** baked in: `printer_model="Bambu Lab X1 Carbon"`, `bed_shape=256x256`, Bambu Klipper start g-code with `M620 S[next_extruder]` tool-change macros, etc. Letting that 3MF through `read3mfProjectOverrides` as-is would clobber the user's U1 profile with the wrong machine envelope, the wrong toolchange dialect, and (worst) the wrong bed bounds — the slice would either crash on validate or produce gcode the U1 firmware rejects.

The user wants the OrcaSlicer-on-Android workflow they already have to *also* accept a Bambu 3MF the way `DOC-U1-Link` does on desktop: load, slice, print. The user picks the U1 profile they want (existing flow); the 3MF's process settings (layer height, infill density, etc.) ride along; the machine settings come from the U1 profile.

## Approach

A small Bambu-detection-and-translation pass that runs at 3MF load, *between* the existing `read3mfProjectOverrides` call and the `loadedProjectOverrides` state mutation. Three steps, one new Kotlin file, no new JNI:

1. **Detect**: read `printer_model` / `printer_settings_id` from `Metadata/project_settings.config` via the existing `extract_3mf_string_value` JNI extractor (no new native code — just call `read3mfProjectOverrides` with the printer-detect keys). Treat the 3MF as Bambu when either:
    - `printer_model` matches `^Bambu Lab `, OR
    - `printer_settings_id` matches `@BBL` / `@P1S` / `@A1` / `@X1`.
2. **Strip + remap**: build a filtered `Map<String, String>` from the 3MF's project_settings that:
    - **drops** every Bambu hardware key (full literal list below).
    - **rewrites** Klipper-toolchanger-incompatible start/end g-code to OrcaXR's `GENERIC_KLIPPER_START_GCODE` / `_END_GCODE` (already defined in `MainActivity.kt:8875`).
    - **keeps** process-tunings: layer_height, sparse_infill_density / pattern, wall_loops, top/bottom_shell_layers, supports, speeds — i.e. the existing `PROJECT_OVERRIDE_KEYS` allowlist filtered against the *non-Bambu-hardware* set.
    - **clamps** filament_colour / filament_type / filament_settings_id to 4 entries (or pads with `Generic PLA` / `#FFFFFF`) so multi-extruder configs survive.
3. **Apply**: feed the filtered map into the existing `loadedProjectOverrides` state — the rest of the slice pipeline (`mergedConfig`, MixedFilamentManager, `nativeSlice`) doesn't know or care that the 3MF used to be Bambu-flavor.

A small XR-side info banner ("Imported as Bambu Studio 3MF — using U1 profile defaults for machine settings") tells the user what happened. One tap dismisses; one tap shows the strip+remap details.

### Bambu hardware keys to STRIP

From the DOC-U1-Link template manifest, verbatim:

- Machine identity: `printer_model`, `printer_settings_id`, `printer_variant`, `curr_bed_type`, `default_bed_type`
- Bed + envelope: `bed_shape`, `printable_area`, `printable_height`, `bed_custom_model`, `bed_custom_texture`, `bed_exclude_area`, `extruder_clearance_height_to_lid`, `extruder_clearance_height_to_rod`, `extruder_clearance_radius`
- Toolchange g-code: `machine_start_gcode`, `machine_end_gcode`, `change_filament_gcode`, `before_layer_change_gcode`, `layer_change_gcode`, `machine_pause_gcode`
- Machine limits: `machine_max_acceleration_x`, `_y`, `_z`, `_e`, `_extruding`, `_retracting`, `_travel`, `machine_max_speed_x`, `_y`, `_z`, `_e`, `machine_max_jerk_x`, `_y`, `_z`, `_e`, `machine_max_junction_deviation`, `machine_min_extruding_rate`, `machine_min_travel_rate`
- Bambu-only conveniences: `bbl_calib_mark_logo`, `bbl_use_printhost`, `host_type`, `printhost_authorization_type`, `printhost_ssl_ignore_revoke`, `default_print_profile`, `default_filament_profile`, `inherits_group`

### Filament-type → U1 filament-profile remap

`filament_type[i]` → looked up against this table to populate `filament_settings_id[i]` so the U1 filament profile picks up:

| filament_type | filament_settings_id |
| --- | --- |
| `PLA` | `Snapmaker PLA SnapSpeed @U1` |
| `PETG` / `PETG-HF` | `Snapmaker PETG HF` |
| `ABS` | `Generic ABS` |
| `ASA` | `Snapmaker ASA U1` |
| `TPU` | `Generic TPU` |
| (anything else) | `Generic PLA` (fallback + log) |

The user can override via the existing FilamentEntries store after load.

## Critical files modified

- `app/src/main/java/dev/orcaxr/app/bambu/BambuImportTranslator.kt` (new, ~250 lines) — pure-function translator: `fun translateProjectOverrides(raw: Map<String, String>): Result` where `Result` carries the filtered map + a list of dropped keys (for the banner) + a `was_bambu: Boolean`.
- `app/src/main/java/dev/orcaxr/app/MainActivity.kt:1535` — wrap the existing `loadedProjectOverrides = SlicerEngine.read3mfProjectOverrides(bakeSource)` so the result first goes through `BambuImportTranslator.translateProjectOverrides`. Surface the `was_bambu` flag + dropped-key list as new Compose state, used by the banner.
- `app/src/main/java/dev/orcaxr/app/UiPanels.kt` — add the dismissable banner row alongside the existing "loaded from 3MF" hints (the bed-fit and filament-color hint pattern already exists; reuse it).
- `app/src/test/java/dev/orcaxr/app/bambu/BambuImportTranslatorTest.kt` (new) — JVM unit test, covers: (a) X1 Carbon 3MF detection, (b) `bed_shape` + `machine_start_gcode` dropped, (c) `layer_height` + `sparse_infill_density` retained, (d) filament_type=PLA → U1 PLA profile, (e) non-Bambu 3MF passes through unchanged (no false positive on a Snapmaker 3MF).
- `app/src/androidTest/java/dev/orcaxr/app/bambu/BambuImportInstrumentedTest.kt` (new) — end-to-end on Galaxy XR: load a known-Bambu 3MF, switch to U1 0.20 profile, slice, assert (a) no validate error, (b) gcode header `printer_settings_id = Snapmaker U1` (not Bambu Lab), (c) gcode starts with the Klipper start macro, not the Bambu macro.

## Reused existing utilities

- `SlicerEngine.read3mfProjectOverrides` — already extracts arbitrary string keys from a 3MF (the new BambuImportTranslator extends `PROJECT_OVERRIDE_KEYS` to include detection keys + the strip list, so one zip-open round trip covers everything).
- `MainActivity.kt:8875 GENERIC_KLIPPER_START_GCODE` / `GENERIC_KLIPPER_END_GCODE` — the fallback macros are already there; we just route a Bambu 3MF onto them.
- `loadedProjectOverrides` state + `mergedConfig` precedence — the existing layer-on-top pattern means we don't need to change any slice-call site.
- `FilamentEntriesStore` — already exposes the 4-slot palette; the filament_colour overwrite + filament_settings_id remap goes through its existing setters, so the inline color picker and "loaded in printer" row keep working.
- The existing "loaded from 3MF" info-chip pattern in `UiPanels.kt` — the banner is one more row.

## Verification

End-to-end signal that this is shipped:

1. Pick three reference Bambu 3MFs (one X1, one P1S, one A1) from MakerWorld or the user's library. Load each into OrcaXR on Galaxy XR — banner appears, machine envelope correctly shows U1 (270×270mm), layer height + infill match what the file authored, slice succeeds, gcode validates against the U1 firmware's expected macro shape (`SM_PRINT_*` instead of `M620`).
2. Pick the PeggyPalette Snapmaker 3MF — banner does NOT appear (no false positive), behavior unchanged from before this feature.
3. `./gradlew :app:test` passes the new BambuImportTranslatorTest cases.
4. `./gradlew connectedAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=dev.orcaxr.app.bambu.BambuImportInstrumentedTest` passes on Galaxy XR.
5. User signs off after a real print of a Bambu 3MF on the Snapmaker U1.

Out of scope (deliberate):
- AMS slot mapping (Bambu AMS slot N → U1 toolhead N is currently a 1:1 pad-and-truncate; deeper material-property translation is a follow-up).
- Bambu-specific painted-MM segmentation differences. Bambu uses the same `mmu_segmentation_facets` shape as OrcaSlicer so the existing JNI reader works; if a real-world Bambu paint comes through and slices wrong, that's a libslic3r-side bug, not a translator scope creep.
- A user-facing "edit the stripped keys" UI à la DOC-U1-Link's checkbox panel. Defer until at least one user actually asks for it; the auto-strip + profile-pick covers the 99% case.

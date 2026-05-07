# OrcaXR Roadmap

Forward-looking feature roadmap. **This is the single source of truth for "what's next."** Every entry is enough for a fresh AI session to pick it up, execute it, and verify it without re-discovering prior context.

When you ship a feature: collapse its full entry to a one-line row in the appendix table at the bottom of this file (with the commit SHA), update any unblocked downstream items, and do it in the same commit as the code change (mirrors the GEMINI.md self-update mandate).

## How to use this file

1. **Pick a feature** — prefer items with `🔴 Not started` and no unmet dependencies, then `🟡 Partial` items.
2. **Read GEMINI.md** for the load-bearing technical constraints — every Jetpack XR rendering gotcha and libslic3r gotcha applies. The numbered gotchas there are referenced directly from this file (e.g., "gotcha #11d").
3. **Read the existing code** at the file paths each entry calls out — that's where the deep context lives.
4. **Land the change**, then update this file in the same commit:
   - move the entry to the shipped-appendix as a one-liner with the commit SHA
   - bump any unblocked downstream features

## Status legend

| Symbol | Meaning |
|---|---|
| 🟢 | Shipped & verified (on Galaxy XR or via instrumented test) — moved to Appendix |
| 🟡 | Partial / scaffolded — has a working fallback but not the real thing |
| 🔴 | Not started |
| ⚪ | Deliberately deferred — has an entry-criterion that hasn't been met (hardware, upstream merge, user request) |
| 📌 | Open design question — needs a decision before the depending feature can land |

---

## A. Slicing engine correctness & libslic3r parity

### A2. FullSpectrum engine emission ⚪ Deferred — waiting on Snapmaker upstream merge

> **Patches required:** `0025-fullspectrum-engine-emission.patch` (new). **Patch budget:** ~3700 LoC in `PrintObjectSlice.cpp` alone.

Mixed-filament data layer (patches 0015–0019, 0023, 0024) and config keys are landed; `nativeWriteColoredGlb` paint preview works; project-side overrides flow through `mergedConfig`. What's missing: alternating-layer G-code emission. Requires porting Snapmaker's `feature_mix_filament_sm` deltas in `PrintObjectSlice.cpp` (+3749), `LayerRegion.cpp` (+118), `GCode.cpp` (+490), `GCode/ToolOrdering.cpp`.

**Entry criteria:**
1. Snapmaker `feature_mix_filament_sm` branch merges to their main (PRs #270/#272/#276/#277/#278 in flight as of 2026-04-29). Pin to a stable SHA before porting.
2. Dedicated ASAN sweep of `PrintObjectSlice`'s parallel_for sites with the new code (interacts with our patch 0014 TBB serial shim).

**Exit criteria:** A 2-physical-filament + 1-virtual-mix project produces alternating T0/T1 commands per layer in painted regions; existing 4-color dragon autotest preserves the gotcha #23 baseline (442 T-cmds, 17.4 MB, 4 filaments used).

### A3. Filament → physical extruder full port 🟡 Partial — Kotlin-side modulo wraps, libslic3r-side unported

> **Patch:** `0028-filament-physical-extruder-map.patch` (not yet authored).

Kotlin-side `mergedConfig()`/`computeFilamentMap()` already enforces `(target % numPhysical) + 1` so 5+ filaments cycle into real T-commands without going OOB. The full Snapmaker PR #160 port (libslic3r-aware `m_filament_extruder_map` member, `get_physical_extruder()` accessor, per-filament-prefixed config-vector inheritance) remains queued for if/when a regression that resize-from-index-0 doesn't cover surfaces.

**Trigger to schedule:** any user-reported defect on a 5+-filament U1 project where Kotlin-side resize doesn't match Snapmaker desktop output (e.g., wrong `retraction_length` baked into a T-command).

### A12. Height-range modifiers (per-Z-range per-object settings) 🔴 Not started

> **Files (planned):** `app/src/main/cpp/slic3r_jni.cpp` (apply `ModelObject::layer_config_ranges` before slice), `PlacedModel.kt` (add `heightRanges: List<HeightRange>`), new `HeightRangePanel.kt`, MCP tool `add_height_range`. Depends on **D16** (per-volume Object Settings UI) for the per-range setting editor.

Upstream's "Edit height range" lets the user split an object into Z bands (e.g., 0–5 mm, 5–10 mm, 10+ mm) and override `layer_height`, `sparse_infill_density`, `wall_loops`, and a curated set of process keys per band. Stored as `ModelObject::layer_config_ranges` (`std::map<std::pair<double,double>, ModelConfig>`). Common workflows: 100 % infill in the bottom 5 mm to add weight; coarser layer height above a feature line; different wall count over the top of an embedded magnet pocket.

**Implementation outline:** Per-PlacedModel `List<HeightRange(zMin, zMax, overrides: Map<key, value>)>`. JNI walks the list and writes onto `mo->layer_config_ranges` before `print.process()`. UI: a vertical Z-bar gizmo in `HeightRangePanel` with split / merge / edit affordances; tapping a band opens the existing per-volume settings editor (D16). 3MF round-trip via libslic3r's existing serializer. Range overlap rules match upstream (later range wins).

**Exit criteria:** Author a 0–5 mm range with `sparse_infill_density=100` on a 20 mm cube; sliced gcode shows 100 % infill density in layers 1–25 and the project's default density above.

---

## B. XR UI / UX completeness

### B2. Mixed-Filament UX panel for FullSpectrum 🔴 Not started

> **Files:** existing `MixedColorsPanel.kt` + `MixedFilamentStore.kt` (scaffold landed in commit `734410b`); needs full buildout.

The current `ColorMappingPanel` and `VirtualColorsSection` (`UiPanels.kt:585-871`) cover basics — virtual rows, A+B swap, ratio slider. Rewrite the UX to match FullSpectrum v0.9.8's actual surface (the prior scaffold misnamed several modes — `LayerCycle / Pointillisme / Local-Z` are NOT parallel modes; per-layer alternation is just on by default, dithering and Local-Z are orthogonal modulators).

**Implementation outline (in slices):**
- **B2.1** rename header to "Mixed Filaments" (FullSpectrum's `_L("Mixed Filaments")`).
- **B2.2** add three creation buttons: Add Gradient (existing "+ New mix"), Add Pattern (`mf.manual_pattern = "12"`), Add Color (opens B2.5 dialog).
- **B2.3** keep the existing "Advanced ▾" inline expander pattern (`UiPanels.kt:927-933`); do NOT add a separate popup.
- **B2.4** per-row controls: component swatch pickers (2D weight surface for 3+ components, single slider for 2), manual pattern field with chip-builder (XR keyboard is too painful), bias row gated on `mixed_filament_component_bias_enabled`, apparent-color preview via FilamentMixer (NOT naive RGB lerp).
- **B2.5** Color-Match dialog: 2D color simplex (line/triangle/quad/radial), laser-drag a cursor, live blend update, Delta-E-sorted preset chips, OK creates a row with `distribution_mode` auto-set.
- **B2.6** "Mixed Filaments" optgroup in Settings — group 11 keys into sub-accordions (Local-Z, Step / Painted zones, Bias, Region adjustment, Advanced ordered dithering, Wipe tower, Cadence height overrides). **Do not surface** `mixed_filament_gradient_mode`, `mixed_filament_pointillism_pixel_size`, `mixed_filament_pointillism_line_gap` (hidden in v0.9.8 — research-grade only).
- **B2.7** auto-generation prompt when filament count changes (mirrors FullSpectrum's `Plater::confirm_auto_generated_gradients`).
- **B2.8** tooltip plates for non-obvious settings (Local-Z bounds, Bias semantics, region collapse interaction).

**Dependency on A2** — the panel can author mixed-filament definitions and persist them, but they only affect G-code output once engine emission lands.

**Exit criteria:** A user with 2 physical filaments can author a "blue+yellow=green" virtual mix via Color-Match; the row persists in `MixedFilamentStore`; the apparent-color swatch matches the Kubelka–Munk blend; once A2 lands, slicing emits alternating-layer G-code in painted regions.

### B6. XR tooltip primitive 🟡 Partial — chip + popover shipped, gizmo/B2 reuse pending

> **Files:** `SpatialTooltip.kt` (`SettingHelpChip` + `TooltipState`), `SettingDescriptions.kt`, `UiPanels.kt::SettingNumericEditor`.

Tap-to-toggle popover wired into `SettingNumericEditor` for every Quality / Speed / Support row. Pending: reuse on B1 gizmo handle labels and B2 mixed-filament settings rows; true laser-hover (vs tap) trigger once XR's pointer-event reliability supports it without trading legibility for jitter.

---

## C. Connectivity & monitoring

### C1. Print queue (Moonraker queue plugin) ⚪ Deferred — wait for user demand

> **Files:** `MoonrakerClient.kt`, `UiPanels.kt::PrintMonitorPanel`.

Moonraker exposes a job queue plugin (`/server/job_queue/*`). The user has stated the workflow is one-job-at-a-time today. Ship if/when a real workflow ask appears.

**Implementation outline (when scheduled):** `MoonrakerClient.queryJobQueue()`, list/add/remove/move job actions, a queue panel adjacent to PrintMonitorPanel.

### C2. Bed mesh visualization ⚪ Deferred — wait for SceneCore heatmap shader path

Render the probed bed-mesh grid as a heatmap GLB on the build plate. Today we'd hand-roll vertex colors; ship once SceneCore (or an `androidx.xr.compose.material3` future release) exposes a clean heatmap material.

**Trigger to schedule:** SceneCore alpha14+ release notes mention a vertex-color or heatmap material.

### C3. Telemetry opt-in 🔴 Not started — needs backend decision

> Local crash reporting (`CrashReporter`, JSON files under `${filesDir}/crashes/`) is shipped; remote shipping is what's missing.

📌 **Open design question:** what backend? Options: (a) Sentry self-hosted; (b) Anthropic-style minimal POST endpoint; (c) GitHub Issues auto-filed via GitHub App. Decision shapes the data-format + privacy story.

**Implementation outline (post-decision):**
1. UserPreferences: `telemetryOptIn: Boolean = false` (DataStore).
2. Settings UI: a checkbox + privacy explainer in About panel.
3. `CrashReporter` POST when opt-in is true; queue offline; redact filenames.

**Exit criteria:** Toggle opt-in, force-crash via debug broadcast, confirm event lands at the chosen backend; toggle off, confirm no egress.

---

## D. Painting / object editing extensions

**Moved to [ROADMAP-painting-and-editing.md](ROADMAP-painting-and-editing.md)** under the "<600 lines" maintenance rule. That sibling file is the single source of truth for D1–D21. Cross-references in this file (e.g., A11 → D14, B12 → A11) still resolve — link targets are the section heading anchors in the sibling.

---

## E. Architecture / scaling beyond MVP

### E1. Module split 🔴 Not started — ship when single-module pain bites

> See GEMINI.md "Module layout" section for the aspirational split.

Currently single `:app` module. The aspirational split: `:slicer:xr` (XR presentation), `:slicer:core` (domain), `:slicer:native` (JNI), `:data` (printer connectivity), `:settings` (DataStore). Do NOT speculatively split — wait for boundaries to hurt.

**Trigger to schedule:** Compose recompositions cross JNI/UI boundaries in unobvious ways, or build times exceed ~3 min, or a non-XR form factor enters scope.

### E2. Hilt DI 🔴 Not started — bundled with E1

Currently no DI, single-module Compose state. Add Hilt when E1 lands.

### E4. Companion phone app 📌 Open design question

> **Status:** blocked on numeric/text-entry decision (G1).

Possible role: parameter editing on a phone screen for users who don't want to type via XR keyboard. Decision shapes whether the slicing UI ships as profiles-first (no freeform numeric entry) or hybrid.

**Decision input needed:** does the user prefer (a) profiles-first, (b) phone companion, (c) Bluetooth keyboard, (d) hybrid?

### E5. Phone / TV form factors ⚪ Deferred — XR must be solid first

> See GEMINI.md "Target platform" section.

Out of scope until XR has a 1.0-quality release.

### E6. Vision Pro port ⚪ Deferred indefinitely

Full Metal + RealityKit rewrite — essentially a separate product, not a port.

### E7. Multi-user collaborative slicing ⚪ Deferred

Shared XR space, multiple users editing the same scene. Speculative.

---

## F. Profile catalog breadth

### F2. Branded U1 filament leaves 🟡 Partial — PLA + ABS/ASA/PETG/PETG-CF vendored; exotic (PA-CF / PC / TPU) still pending

> Snapmaker fork ships ~58 branded leaves; OrcaXR now ships Generic PLA + Generic ABS + Generic PETG + Snapmaker PLA + Snapmaker PLA Matte + Snapmaker PLA Eco + Snapmaker PLA Silk + Snapmaker PLA Metal + Snapmaker PLA-CF + Snapmaker ABS + Snapmaker ASA + Snapmaker PETG + Snapmaker PETG-CF + Elegoo PLA Matte + Elegoo PLA-CF.

Branded leaves cover PLA HF / PLA Eco / PLA Metal / PLA Silk / PETG HF / PETG-CF / PETG-GF / ASA / PA-CF / PCTG / PVA / BVOH / PC / TPU / TPU 95A HF / Breakaway Support + Polymaker/PolyLite/PolyTerra third-party. APK cost <100 KB; UX cost is picker clutter.

**Implementation:** stage-roll. PLA family landed first; ABS/PETG branded next, exotic (PA/PC/TPU) last. Ship a nozzle filter chip in the picker if clutter becomes a complaint.

**Pending — entry-criteria for the green flip:**
- Exotic-material leaves (PA-CF, PC, TPU 95A HF) once F5's `filament_is_high_temperature` flag has a real consumer.
- Snapmaker Breakaway Support For PLA — gated on resolving the Snapmaker J1 PVA parent chain it inherits from.

### F3. Centauri Carbon profile breadth 🔴 Not started

Currently 0.2 + 0.4 nozzles, Elegoo PLA Matte + PLA-CF + Generic PETG/ABS. Mirror F2 for the Centauri Carbon side. Defer until the user requests a specific filament; Centauri-tuned leaves are harder to source than Snapmaker-fork-vendored ones.

---

## G. Open design questions (📌 — resolve before depending features land)

These block downstream work. The user should call them; AI should surface them.

### G1. Numeric / text entry strategy 📌 Blocks E4 (companion app)

Options: (a) profiles-first (no freeform numeric entry — only preset pick + relative tweak sliders); (b) companion Android phone app for parameter editing; (c) assume paired Bluetooth keyboard; (d) hybrid.

**Current state:** TransformPanel ships TextField with the system XR keyboard. Per-key Print Settings TextField in Quality/Strength/Speed tabs also use the keyboard. So the "hybrid" path is implicitly half-shipped.

**Decision needed:** Is the keyboard-first path the long-term answer, or do we want a phone companion / Bluetooth fallback for power users?

### G2. Local vs remote slicing default 📌 Currently local-only

Slice on-device for everything? Offer a "slice on paired PC/server" mode? Both? Galaxy XR thermal + memory budget so far holds (gotcha #23: 20mm cube p50=807ms / peak 262 MB / Δ1.1°C over 10 runs). Not a forcing function yet.

**Decision needed:** ship a remote-slicing fallback, or commit fully to on-device?

### G3. Printer connectivity scope expansion 📌 Currently Klipper/Moonraker only

Add OctoPrint? Bambu cloud? Snapmaker native? The user's two printers (Snapmaker U1 + Elegoo Centauri Carbon) are both Klipper + Moonraker — already covered. Adding OctoPrint costs the most engineering (different polling shape, different upload endpoint) for the smallest user base.

**Decision needed:** stay Moonraker-only, or commit to OctoPrint as a parallel backend?

### G4. 3MF round-trip for Object Settings 📌 Open — see D9 in [`ROADMAP-painting-and-editing.md`](ROADMAP-painting-and-editing.md)

---

## H. Audit follow-ups (2026-05-07 codebase audit)

Bugs and improvement opportunities surfaced by a multi-agent audit on 2026-05-07. None block the current alpha but every Critical item should land before Play Store wide release. File:line citations are pinned to the audit snapshot — re-grep before fixing if the codebase has drifted.

### H1. CRITICAL — `SharedIntentHandler.stageUri()` has no size cap 🔴

> **File:** `app/src/main/java/dev/orcaxr/app/SharedIntentHandler.kt:97-108`.

A share intent pointing at a multi-GB file streams into the disk cache with no `MAX_FILE_SIZE_BYTES` check; trivial DoS via Android's share sheet (no malicious app required, just a large URL). Add a 500 MB cap inside the read loop and reject before the rename. Also add a `withTimeoutOrNull(30_000)` around the stream read so a pathological `content://` provider can't hang the importer indefinitely.

**Exit criteria:** importing a 600 MB file via share fails fast with a Toast; importing a 50 MB file still succeeds; `SharedIntentHandlerTest` covers both bounds.

### H2. CRITICAL — MCP `/resources/<token>.png` route bypasses bearer-token auth, and the token is only 64 bits 🔴

> **Files:** `app/src/main/java/dev/orcaxr/app/mcp/McpServer.kt:138-184`, `app/src/main/java/dev/orcaxr/app/mcp/AiSessionState.kt::contentToken`.

The route is matched at line 138 *before* the auth block at line 206. Comment claims "the token is itself the capability," but a 64-bit cache key (SHA-256 truncated to 16 hex chars) was never designed as a security primitive. With 50 LRU entries and shared-LAN binding (`0.0.0.0`), a network attacker can scan tokens.

**Fix:** widen `contentToken` to 128 bits (32 hex chars) **and** require the bearer header on `/resources/` (still allow inline base64 image parts so LLM clients without LAN access keep working). Alternative: bind to loopback by default with an explicit "Expose to LAN" toggle in `McpServerCard`.

### H3. CRITICAL — Anthropic API key persisted plaintext in DataStore 🔴

> **File:** `app/src/main/java/dev/orcaxr/app/mcp/McpSettings.kt:55-60`.

If the device is lost or filesystem-dumped, key is immediately compromised. Wrap with Android Keystore (EncryptedSharedPreferences or a Keystore-derived AEAD) before persisting. Also redact from any debug log path.

**Exit criteria:** `McpSettings.anthropicApiKey` reads/writes through Keystore-backed encryption; rotating-key migration shipped so existing installs upgrade without user re-entry; new gotcha in GEMINI.md documenting the threat model.

### H4. CRITICAL — `flush_actions` can deadlock if MainActivity tears down mid-flush 🔴

> **Files:** `app/src/main/java/dev/orcaxr/app/mcp/tools/WorkspaceTools.kt` (`flush_actions`), `app/src/main/java/dev/orcaxr/app/mcp/WorkspaceBinding.kt` (action collector).

The `timeout_ms` only gates the *condition* — the upstream `actions.first()` Flow collection itself isn't wrapped in `withTimeoutOrNull`, so a backgrounded activity holds the MCP coroutine forever.

**Fix:** wrap the Flow `first()` in a `withTimeoutOrNull(timeout)`. Add a unit test: simulate the activity-detached state and assert the tool returns `isError: true` within `timeout_ms + 200`.

### H5. IMPORTANT — HTTP framing accepts negative `Content-Length` 🔴

> **File:** `app/src/main/java/dev/orcaxr/app/mcp/HttpFraming.kt:76-79`.

`Content-Length: -1` passes the upper-bound check, body read is skipped, socket desyncs. Add `if (contentLength < 0) throw IOException("invalid Content-Length")`. Add an `HttpFramingTest` round-trip suite (none exists today — covered only incidentally by `McpServerEndToEndTest`).

### H6. IMPORTANT — `extraHeaders` map written without CRLF / name validation 🔴

> **File:** `app/src/main/java/dev/orcaxr/app/mcp/HttpFraming.kt:177`.

Latent header-injection / response-splitting if any future tool puts caller-controlled values into headers. Validate names (`[A-Za-z0-9-]+`) and reject CR/LF in values. Add a regression test.

### H7. IMPORTANT — Moonraker default scheme is `http://` 🔴

> **File:** `app/src/main/java/dev/orcaxr/app/MoonrakerClient.kt:467`.

Bare hostnames (the user-friendly path) leak the printer API key over LAN. Default to `https://` and downgrade only when an explicit `http://` is given, or surface a "plaintext warning" once per host.

### H8. IMPORTANT — Three bare `catch (_: Throwable)` blocks swallow OOM/IOException 🔴

> **File:** `app/src/main/java/dev/orcaxr/app/SharedIntentHandler.kt:87, 110, 156`.

Users hit "share didn't work" with zero diagnostics. Log at WARN before returning null — at minimum the exception class + message.

### H9. IMPORTANT — `AiSessionState.evictOldest()` is non-atomic on `ConcurrentHashMap` 🔴

> **File:** `app/src/main/java/dev/orcaxr/app/mcp/AiSessionState.kt:143-151`.

Sort-then-iterate-and-remove can drop a freshly-stored artifact under concurrent renders. Switch to `compute()` or `synchronized(this)` around the size-check + eviction. Same shape applies to `AiPaintSessionStore.kt:92-100`.

### H10. IMPORTANT — Tier-B `WorkspaceAction` handlers log a warning and silently succeed 🔴

> **File:** `app/src/main/java/dev/orcaxr/app/mcp/WorkspaceBinding.kt:48-54, 455-639`.

~28 actions where MCP tools think they ran but nothing happened. Each handler should return `isError: true` (or the action itself should fail and surface back) so the LLM knows to retry / pick another path. This violates the GEMINI.md principle that tools must reflect ground truth.

### H11. IMPORTANT — `load_paint_recipe` requires the model to have *some* paint state first 🔴

> **File:** `app/src/main/java/dev/orcaxr/app/mcp/tools/PaintRecipeTools.kt:165`.

Gross UX: paint-one-stroke, then load. Initialize `paintFilamentIndex` to a zeroed buffer of size `bvh.triCount` lazily on first recipe load. Same fix shape for the `D18i` paint-template path.

### H12. IMPORTANT — 3MF layer-height override is invisible in the UI 🔴

> **File:** `app/src/main/java/dev/orcaxr/app/SlicerEngine.kt:1568`.

Picker shows 0.12, the loaded 3MF silently overrides to 0.20, no in-XR cue. Surface in `LeftProjectPanel` (`Layer height (3MF override: 0.20)`). Comment in the code documents the UX gap.

### H13. IMPORTANT — Release builds are not minified, no baseline profile 🔴

> **File:** `app/build.gradle.kts:124` (`isMinifyEnabled = false`).

Per the `configuring-r8-for-compose` skill, R8 full mode + resource shrinking is ~75 % startup / ~60 % frame-render gain on Compose. Worth re-enabling now that alpha13 has stabilized; verify against the existing `BaselineBenchTest`. Generate + ship a baseline profile in the same change for ~30 % cold-start.

### H14. IMPORTANT — `MainActivity.kt` is 9 478 lines and contains the entire XR shell + paint dispatch + slice coordinator + crash UI 🔴

Not a bug today, but a sustained risk: the stale-closure trap inside `BindWorkspaceModel` (per GEMINI.md) is exactly the kind of bug that hides in a 10 K-line file. Carve out `XrPaintCoordinator`, `XrSliceCoordinator`, and `XrCrashSurface` as the next refactor. Pre-condition for E1 (module split) becoming worthwhile.

### H15. IMPORTANT — `slic3r_jni.cpp` lacks hardening flags 🔴

> **File:** `app/CMakeLists.txt:49-58`.

Missing `-Wformat=2 -Wformat-security`, `-fstack-protector-strong`, `-D_FORTIFY_SOURCE=2`, `-fstack-clash-protection`. Add to release build options. The wrap-trampolines for `tbb::scalable_malloc` are correct (gotcha #18) but a future `lld` change could break them silently — add a one-line CMake assertion that the `__wrap_*` symbols resolve (compile-time test via `nm`).

### H16. IMPORTANT — `crash_log.txt` (38 MB) committed to repo root 🔴

Not secrets, but bloat. Delete and verify `.gitignore` covers future writes. Confirm `local.properties`, `regions.json`, `parse.py`, `get_regions.py`, `playstore/`, `nanobanana-output/` stay gitignored (verified clean in audit).

### H17. IMPORTANT — No CI / pre-commit hooks 🔴

`.github/workflows/` doesn't exist. With 100+ unit tests already wired, a single `gradlew test` job + a `secrets-scan` would catch the regressions GEMINI.md warns about, and would have caught most of the bugs in this audit before they shipped. Add a minimal GitHub Actions workflow gating PRs on `gradlew test` + ktfmt + a TruffleHog scan.

### H18. NICE-TO-HAVE — JSON marshalling everywhere uses `org.json` with string-literal keys 🔴

`OrcaProfileLoader.kt`, `SettingsBackup.kt`, `PlateStore.kt`, `MoonrakerClient.kt`, etc. Migrate to `kotlinx.serialization` (~2 K LOC saved, schema-mismatch caught at compile time). Big diff but pays for itself across the next year of MCP tool growth.

### H19. NICE-TO-HAVE — `SubnetScanner.kt:57` magic numbers 🔴

`chunked(32)` and `connectTimeoutMs = 800` are buried magic numbers. Lift to named `const val`s with one-line rationale (parallelism vs connection-pool contention).

### H20. NICE-TO-HAVE — `RecessedFeaturesTest` is `@Ignore`d 🔴

Synthetic fixture has winding inconsistencies. Either fix the fixture or delete the test; ignored tests rot.

### H21. NICE-TO-HAVE — Several tests use `Thread.sleep` 🔴

`ControllerInputTest`, `AiPaintSessionStoreTest`, `FlushActionsTest`. Flake risk. Replace with `runTest` / virtual time / `CountDownLatch`.

### H22. NICE-TO-HAVE — `PaintInput.kt:34` documents an optimization opportunity but no benchmark 🔴

Closest-triangle-lookup vs BVH path. Add a microbench under `app/src/test/java/dev/orcaxr/app/PaintInputBenchTest.kt` before optimizing.

### H23. NICE-TO-HAVE — `slic3r_jni.cpp:4780` mesh-boolean output is single-mesh 🔴

Even when the operation produces disjoint pieces. Quick win: split with the existing connected-components helper and emit N `PlacedModel`s.

### H24. NICE-TO-HAVE — `slic3r_jni.cpp:6003` slab/chamber primitive is a placeholder cube 🔴

Either implement the real shape or remove the option from `Primitives.kt`.

### H25. NICE-TO-HAVE — Vision tools have no rate limit 🔴

`FindFeatureAnchorsTool`, `ScorePaintAgainstReferenceTool`, `GenerateMaskFromPoint`, `GetMaskForText` — a runaway LLM client can burn through Anthropic quota in seconds. Add a leaky-bucket (~2 req/s) shared between the tools.

### H26. NICE-TO-HAVE — Capabilities have inconsistent threat models 🔴

Render tokens, Anthropic key, Moonraker key, MCP bearer all have different storage/exposure characteristics. One unified `Capability` interface (Keystore-backed, with a documented threat model in GEMINI.md) would tighten H2/H3/H7 in one go.

### H27. NICE-TO-HAVE — No `HttpFramingTest` 🔴

Only tested incidentally via `McpServerEndToEndTest`. Add direct round-trip + malformed-input cases (negative Content-Length, oversized body, header injection, CRLF in name). Pairs with H5 + H6.

---

## Appendix: Already-shipped milestones (do not re-implement)

Reference index. Use `git log --oneline --grep=<topic>` for the full commit chain. Items here are intentionally compact — if you need the design rationale, it lives in `GEMINI.md` (gotcha numbers cross-referenced) or in the commit message.

### Phase 0–3 baselines

| Feature | Status |
|---|---|
| Phase 0 — Cross-compile spike (libslic3r → arm64) | 🟢 |
| Phase 1 — Viewer MVP (load STL, slice, layer scrub) | 🟢 |
| Phase 2 — Polish, profiles, multi-panel XR shell | 🟢 |
| Phase 3 (most) — Connectivity, multi-color, multi-model, hand-tracking gizmos | 🟢 |
| Selection bbox (yellow outline + tap-to-select) | 🟢 commit `efc0430` |
| TransformPanel — numeric XYZ + mirror + place-on-bed | 🟢 commit `836d270` |
| Lay-on-face + Convert units + Auto-orient | 🟢 commits `1d9efdf`, `472f158`, lay-on-face |
| Multi-volume JNI bridge + per-object Object Settings | 🟢 commits `36782db`..`dd64382` |
| Cut tool | 🟢 commit `39ce263` |
| Mesh boolean + Split + A/B picker UX | 🟢 commits boolean-phase, `40b54d1` |
| Support paint, Seam paint, Clone-pattern | 🟢 commits `0f744e7`, `6cb5f45` |
| SAFE_KEYS expansion + Pressure Advance | 🟢 |
| Profile breadth — 0.6 nozzle U1, Generic ABS, Generic PETG | 🟢 commit `878fe25` |
| Filament map modulo (Kotlin-side) | 🟢 commit `ef8b9a2` |
| Wipe-tower stability fixes (3 patches) | 🟢 commit `fd9dd42` |
| Filament/bed compatibility rules | 🟢 commit `f6a7505` |
| Multi-model UI | 🟢 commit `85e9a10` |
| Snapmaker small flags (high-temp, top-cover, slot edit isolation) | 🟢 commit `fa05537` |
| Moonraker AFC sync + filament-runout badges | 🟢 commit `fa05537` |
| FullSpectrum F.1 — LocalZOrderOptimizer scaffold | 🟢 patch 0023 |
| FullSpectrum F.3 — bbs_3mf max-filament-id helper | 🟢 patch 0024 |
| In-XR laser color paint + slice integration | 🟢 commit `dfdd3c5` |
| Galaxy XR controllers — input pump | 🟢 commit `dfdd3c5` |
| Galaxy XR controllers — Sliced-mode layer scrubbing | 🟢 |
| Galaxy XR controllers — Prepare-mode stick X/Y nudge + rotate | 🟢 |
| UI/UX — Radial menu wiring | 🟢 commit `0d78d26` |
| UI/UX — Top nav pill cleanup | 🟢 |
| UI/UX — Speed + Support print-settings tabs | 🟢 |
| PreviewPalette swatch row ("as-will-print") | 🟢 commit `410e860` |
| Flush-tower volume fix (3MF-authored matrix) | 🟢 commit `9bf4f55` |
| Fuzzy Skin paint (mode + JNI + UI + cache) | 🟢 commit `cc75ead` |
| Smart Fill / bucket brush sub-mode | 🟢 commit `7534f25` |
| Multi-step paint undo/redo | 🟢 commit `5cf152e` |
| 3MF paint round-trip (4 facet annotations) | 🟢 commit `d2d30d2` |
| Brim Ears point-placement tool | 🟢 commit `69b783b` |
| Paint-mode stick brush/angle adjust | 🟢 commit `f85380c` |

### Section A — Slicing engine (shipped)

| # | Feature | Commits / notes |
|---|---|---|
| A1 | Auto-arrange via libnest2d | `13f3c66` — JNI bridge fixed, libnest2d integration live |
| A4 | Honor 3MF-authored flush settings | `9bf4f55` — matrix + multiplier extracted via direct miniz read |
| A5 | Cross-platform mesh repair ("Fix Model") | `nativeRepairModel` with ADMesh + CGAL self-union; `RepairModelTest` |
| A6 | Bed-collision check (full mesh-vs-bed) | `e6937e3`, `61875bb`, `6aa1151` — banner + slice-gate + red-tri preview |
| A7 | Toolpath rendering as triangulated tubes | `9731320` + streaming + miter joins; cap 1.5M segments |
| A8 | G-code thumbnails for Snapmaker/OrcaSlicer parity | Software rasterizer + JNI callback + SAFE_KEYS whitelist |
| A9 | Snapmaker fork profile + engine value sync | Phase 1 (filament leaves synced) + Phase 2 (PROJECT_OVERRIDE_KEYS 11→56). Residual estimate divergence (planner refactor) understood and accepted |
| A10 | Variable / adaptive layer height per object | `nativeAdaptiveLayerHeights` + 4 MCP tools + `AdaptiveLayerPanel` |
| A11 | Custom G-code per print Z (pause / color change / template) | `apply_custom_gcodes` + `CustomGcodePanel` + scrubber tick strip + 4 MCP tools |
| A13 | Wipe-tower auto-positioning | Pure-Kotlin scorer + `auto_position_wipe_tower` MCP + `WipeTowerAutoPositionRow` Switch |
| A14 | G-code feature-type color mode for toolpath viewer | `ToolpathGlb.ColorMode` + 3-button SegmentedButton in `BottomLayerPreviewPanel` |

### Section B — XR UI / UX (shipped)

| # | Feature | Commits / notes |
|---|---|---|
| B1 | 3D Transform Gizmo (rings + arrows + handles) | `d81ee20` — TransformGizmo + GizmoGlb generation + laser-drag handlers |
| B3 | Slot picker filament-type dropdown | `2a4b21c` — `loadFilaments` + per-slot override path |
| B4 | Galaxy XR Controller bindings — face buttons | A/B/X/Y wired through `XrShell` LaunchedEffect |
| B5 | Galaxy XR Controller help card | `aac69c2` — `ControllerHelpCard` + Top-nav Help icon |
| B7 | Empty-state guidance | `f00c60e` — `EmptyStatePanel` + `RecentFilesStore` |
| B8 | Numeric input validation | `7fa3970` (transforms) + `5a4328b` (print settings tabs) |
| B9 | Per-part selection & transform from multi-object archives | `3364b9c` — STL extraction per object + `groupId` flat hierarchy |
| B11 | Multi-selection & batch actions | `27f1b2c` — `selectedModelIds: Set<String>` + group gizmo |
| B12 | Calibration print library | 7 `.drc` calibration meshes + `CalibrationRampGenerator` + `generate_calibration_ramp` MCP tool |
| B13 | Settings backup / restore as JSON | `SettingsBackup.exportJson/importJson` + 11 stores + 2 MCP tools |
| B14 | Android share-target for STL / 3MF / OBJ | Three intent-filters + `SharedIntentHandler` + `singleTask` launchMode |

### Section C — Connectivity & monitoring (shipped)

| # | Feature | Commits / notes |
|---|---|---|
| C4 | AFC slot auto-population | "Sync" TextButton in `LeftProjectPanel` reads cached `printerLoadedFilaments` |
| C5 | Filament runout badges | `MoonrakerClient.queryStatus` subscribes to `filament_detect`; amber pills in `LivePrintStatus` |
| C6 | MCP Server (Phase 1–2.5) | 67+ tools live; `OrcaXRApplication.onCreate` boot; `McpServerCard` UI; `McpForegroundService` |
| C7 | Spatial Digital Twin Monitoring | `liveZmm` from `toolhead.position[2]` → binary-search vs `parsedToolpath.layerZs` → `maxLayer` re-bake |
| C8 | Voice-to-Action Integration (Speech-to-MCP) | `VoiceIntentMapper` (~25 patterns) + `VoiceCommandPanel` + Mic chip; 12 unit tests |
| C9 | AI-Driven Semantic Paint (M1–M4) | 18 base tools (paint primitives + render + introspection + multi-view + mask projection); pure-Kotlin rasterizer + PNG encoder; `AiSessionState` LRU |

### Section E — Architecture (shipped)

| # | Feature | Commits / notes |
|---|---|---|
| E3 | Multi-plate workspace | `3364b9c` — `PlacedModel.plateId` + `PlateStore` + plate tab strip |
| E8 | Foreground-service background slicing | `SliceForegroundService` + `SliceLifecycle` + `nativeAbort` JNI hook + Cancel notification action |
| E9 | Native build toolchain pin (NDK 26+ / Clang 17+) | GEMINI gotcha §29 + `build_native.sh` floor assert + `verifyNdkClangFloor` Gradle task |
| E10 | Android Test Orchestrator | `androidx.test:orchestrator` + `clearPackageData=true` + `ANDROIDX_TEST_ORCHESTRATOR` execution |

### Section F — Profile catalog (shipped)

| # | Feature | Commits / notes |
|---|---|---|
| F1 | Additional U1 nozzle sizes (0.2, 0.8) | Full Snapmaker fork v2.3.1 nozzle line vendored |
| F4 | `requires_top_cover` flag | Patch `0026-requires-top-cover-flag.patch` + `TopCoverRule.kt` warning banner |
| F5 | `filament_is_high_temperature` flag | Patch `0025-filament-high-temperature-flag.patch` (dormant infrastructure for F2 exotics) |

---

## Maintenance rules

- **Update this file in the same commit** as the code change that flips a status. Don't let it lag the code.
- **Don't restate GEMINI.md gotchas here.** Cross-reference them by number (e.g., "gotcha #11d").
- **Don't dump deep context into a side file.** This roadmap is intentionally the only forward-looking document — when a feature needs more detail than fits here, expand the entry inline with file paths and exit criteria, not a separate plan doc.
- **Keep this file under ~600 lines.** If it grows past that, split a subsection out as a sibling roadmap (e.g., `ROADMAP-painting.md`) and link from here. When a feature ships, collapse it to a one-line appendix entry — don't leave the full design body.

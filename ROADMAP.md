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

### E5. TV form factor ⚪ Deferred — phone shipped, TV speculative

> See GEMINI.md "Target platform" section. Phone / tablet shipped — see appendix entry below.

Phone + tablet shipped (`MobileActivity` + 10 screens — Home / Files / Slicer / Preview / Paint / Filament / Monitor / Profile / Settings / Onboarding — sharing the XR shell's stores, MoonrakerClient, libslic3r JNI, and AiRenderEngine). What remains is the TV form factor, which is speculative — Android TV's controller-only input model and 10-foot UX make XR-derived gizmos and laser-paint a poor fit. Defer until a concrete user request lands.

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

### H1. CRITICAL — `SharedIntentHandler.stageUri()` has no size cap 🟢 SHIPPED

> **File:** `app/src/main/java/dev/orcaxr/app/SharedIntentHandler.kt`.

A share intent pointing at a multi-GB file streamed into the disk cache with no size check; trivial DoS via Android's share sheet. Fixed: 500 MB cap enforced inside the read loop with mid-stream rejection, plus a 30 s timeout via a watchdog that closes the stream on expiry. `SharedIntentHandler.resolveAllBounded` is the new suspend entry point — Activity / Compose call sites updated.

**Verified:** `SharedIntentHandlerTest` adds `stageStream rejects payloads above MAX_FILE_SIZE_BYTES` + `stageStream accepts payload just under cap`. 10/10 green.

### H2. CRITICAL — MCP `/resources/<token>.png` route bypasses bearer-token auth, and the token is only 64 bits 🟢 SHIPPED

> **Files:** `app/src/main/java/dev/orcaxr/app/mcp/McpServer.kt`, `app/src/main/java/dev/orcaxr/app/mcp/AiSessionState.kt::contentToken`.

The route was matched before the auth block; the token was a 64-bit SHA-256 prefix, never designed as a security primitive against a LAN scanner. Fixed: `contentToken` widened to 128 bits (32 hex chars), `/resources/<token>.png` now requires the bearer header. Inline base64 image parts on tool results keep working for clients without LAN reach.

**Verified:** `McpServerEndToEndTest` adds `resourceRouteRejectsMissingBearer`, `resourceRouteWithBearerTokenStillRejectsUnknownToken`, `contentTokenIs128Bits`. 12/12 green.

### H3. CRITICAL — Anthropic API key persisted plaintext in DataStore 🟢 SHIPPED

> **Files:** `app/src/main/java/dev/orcaxr/app/mcp/SecretBox.kt` (new), `McpSettings.kt`, `LlmSettings.kt`.

Fixed: `SecretBox` (AES-256-GCM with a key in `AndroidKeyStore`, alias `orcaxr_secret_v1`) wraps both stores. On-disk format is `base64(IV || ciphertext+tag)`. Migration is silent: legacy plaintext values fall through `decrypt() == null` and are rewritten encrypted on the next setter call. Extended past the audit's stated scope to cover `LlmSettings` Claude / Gemini / OpenAI keys too — same threat model, free with the SecretBox abstraction. GEMINI.md gotcha #31 documents the model.

### H4. CRITICAL — `flush_actions` can deadlock if MainActivity tears down mid-flush 🟢 SHIPPED

> **File:** `app/src/main/java/dev/orcaxr/app/mcp/tools/WorkspaceTools.kt::FlushActions`.

The existing implementation already wrapped `lastDrainedActionId.first { ... }` in `withTimeoutOrNull` — the audit's premise that the timeout was bypassed was inaccurate. But the deeper UX issue (the LLM stalls for the full timeout when the host is detached) is real. Fixed: `FlushActions` now short-circuits with a host-detached error when `target > drained && !attached`, returning immediately instead of waiting. The structured response gains `host_detached: bool` so the LLM can route around the failure cleanly.

**Verified:** `FlushActionsTest::flushFastFailsWhenHostDetached` asserts < 1 s elapsed even when the timeout is 5 s. 6/6 green.

### H5. IMPORTANT — HTTP framing accepts negative `Content-Length` 🟢 SHIPPED

> **File:** `app/src/main/java/dev/orcaxr/app/mcp/HttpFraming.kt`.

The negative-Content-Length guard already existed; the audit's claim was inaccurate. What was missing: a dedicated regression test. New `HttpFramingTest` covers negative, oversized, non-numeric, and well-formed Content-Length. 12/12 green.

### H6. IMPORTANT — `extraHeaders` map written without CRLF / name validation 🟢 SHIPPED

> **File:** `app/src/main/java/dev/orcaxr/app/mcp/HttpFraming.kt`.

Fixed: header names validated against `^[A-Za-z0-9-]+$`, CR/LF in values rejected. `IllegalArgumentException` thrown for either case. Tests in `HttpFramingTest` (CRLF in name, non-token chars in name, CRLF in value, well-formed pass-through).

### H7. IMPORTANT — Moonraker default scheme is `http://` 🟢 SHIPPED (one-time WARN; default unchanged)

> **File:** `app/src/main/java/dev/orcaxr/app/MoonrakerClient.kt::applyApiKey`.

Defaulting to `https://` would break ~all real-world Klipper installs (Moonraker doesn't ship TLS by default; both reference printers — Snapmaker U1, Elegoo Centauri Carbon — are bare HTTP out of the box). Took the audit's alternative: a one-warning-per-host WARN log when an API key is sent over plaintext HTTP. Ground truth is now in logcat without breaking the connectivity path.

### H8. IMPORTANT — Three bare `catch (_: Throwable)` blocks swallow OOM/IOException 🟢 SHIPPED

> **File:** `app/src/main/java/dev/orcaxr/app/SharedIntentHandler.kt`.

All three bare catches now log exception class + message at WARN. Subsumed by the H1 rewrite — the new structure has named catch sites at every failure point (`openInputStream`, `queryDisplayName`, the read loop) each emitting a one-line WARN with the URI / display name and exception class.

### H9. IMPORTANT — `AiSessionState.evictOldest()` is non-atomic on `ConcurrentHashMap` 🟢 SHIPPED

> **Files:** `app/src/main/java/dev/orcaxr/app/mcp/AiSessionState.kt`, `app/src/main/java/dev/orcaxr/app/mcp/AiPaintSessionStore.kt`.

Both eviction paths now hold `synchronized(map)` across the size-check + remove pair. Renamed to `evictOldestLocked` / `evictIfNeededLocked` so the lock contract is visible at the call site.

### H10. IMPORTANT — Tier-B `WorkspaceAction` handlers log a warning and silently succeed 🟢 SHIPPED

> **Files:** `app/src/main/java/dev/orcaxr/app/mcp/TierBCapability.kt` (new), `WorkspaceModel.kt`, `WorkspaceBinding.kt`, `tools/WorkspaceTools.kt`.

Fixed via a wired-capability mechanism: `TierBCapability` enum names each Tier-B callback; `WorkspaceModel.wiredTierBCapabilities` is a `StateFlow<Set<TierBCapability>>`; `BindWorkspaceModel` computes the set from non-null callbacks and publishes; tools call `requireCapability(...)` before emitting and fail-fast with `isError` when the matching callback isn't wired. Gated 10 high-traffic tools (slice / auto_arrange / save_* / load / repair / simplify / cut / mesh_boolean / split). The remaining ~18 either have a Compose-state fallback (DropToBed, SetLayerHeightProfile, etc.) or are paint mutators routed through the unconditionally-wired `applyPaintMutation` pipeline.

### H11. IMPORTANT — `load_paint_recipe` requires the model to have *some* paint state first 🟢 SHIPPED

> **File:** `app/src/main/java/dev/orcaxr/app/mcp/tools/PaintRecipeTools.kt`.

Falls back to `ws.getBvh(modelId)?.triCount` when no paint arrays are present (the BVH is the ground truth for tri count). Updated the no-fallback error message to point at the actual root cause ("re-select the model in paint mode to build the BVH"). The companion D18i paint-template path doesn't have the same gate (no preconditions to relax).

### H12. IMPORTANT — 3MF layer-height override is invisible in the UI 🟢 SHIPPED

> **Files:** `app/src/main/java/dev/orcaxr/app/SlicerEngine.kt`, `MainActivity.kt`, `UiPanels.kt`.

The override doesn't actually apply to the slice (layer-height keys are excluded from `PROJECT_OVERRIDE_KEYS`), but the audit's deeper concern — "the user has no way to know what the 3MF wanted" — is fixed by surfacing the authored value as an amber chip in the Quality tab of `RightSettingsPanel` ("3MF authored 0.20 mm — tap to apply"). Tap applies the value to the override TextField. Only renders when the authored value differs from the effective (override-or-profile) value by ≥ 0.005 mm.

### H13. IMPORTANT — Release builds are not minified, no baseline profile 🟡 BLOCKED on upstream

> **File:** `app/build.gradle.kts:124`.

Attempted in this audit sweep — `proguard-rules.pro` is ready (narrow keeps for native methods, `SlicerEngine` nested classes, androidx.xr alpha13). Hit an upstream blocker: Kotlin 2.3.21's Compose compiler (2.2.10) tries to download `org.jetbrains.kotlin:compose-group-mapping:2.2.10` to feed R8 a Compose-aware optimization hint; that artifact isn't published on dl.google.com or maven central as of 2026-05-07, so `produceReleaseComposeMapping` fails before R8 even runs. Two workarounds tried (late `tasks.matching {}.disable`, clearing the configuration's dependencies in `afterEvaluate`) both fire too late — the configuration cache fails at evaluation time. Real fix: wait for upstream artifact OR pin Compose compiler to 2.0.x. The `proguard-rules.pro` keep file is committed and ready to wire in once the blocker resolves; the inline comment in `app/build.gradle.kts` records the trace so a future contributor doesn't re-tread.

### H14. IMPORTANT — `MainActivity.kt` is 9 478 lines and contains the entire XR shell + paint dispatch + slice coordinator + crash UI 🔴

Not a bug today, but a sustained risk: the stale-closure trap inside `BindWorkspaceModel` (per GEMINI.md) is exactly the kind of bug that hides in a 10 K-line file. Carve out `XrPaintCoordinator`, `XrSliceCoordinator`, and `XrCrashSurface` as the next refactor. Pre-condition for E1 (module split) becoming worthwhile.

### H15. IMPORTANT — `slic3r_jni.cpp` lacks hardening flags 🟢 SHIPPED

> **File:** `app/src/main/cpp/CMakeLists.txt`.

Added `-Wformat=2 -Wformat-security`, `-fstack-protector-strong`, `-D_FORTIFY_SOURCE=2`, `-fstack-clash-protection` to the in-tree JNI shim (slic3r_jni.cpp / nanosvg_impl.cpp / thumbnail_render.cpp). Plus a CMake POST_BUILD assertion (`assert_wrap_symbols.cmake`) that checks all 8 `__wrap_scalable_*` trampolines (gotcha #18) landed in the linked .so. Verified with `nm -D --defined-only`: 8/8 present.

### H16. IMPORTANT — `crash_log.txt` (38 MB) committed to repo root 🟢 SHIPPED

Deleted from disk. Was never tracked in git (already covered by `.gitignore` lines 20 + 83), so no history rewrite needed. Confirmed `local.properties`, `regions.json`, `parse.py`, `get_regions.py`, `playstore/`, `nanobanana-output/` are still ignored.

### H17. IMPORTANT — No CI / pre-commit hooks 🟢 SHIPPED

> **File:** `.github/workflows/ci.yml` (new).

Three parallel jobs on PRs and `main` pushes: `:app:testDebugUnitTest`, `:app:ktfmtCheck`, gitleaks scan with full history. Test report uploads as an artifact on failure. Deliberately skips androidTest (needs emulator) and the JNI rebuild (30 min submodule build) — the unit-test corpus already covers the slicer / paint / MCP / HTTP framing surfaces that the audit findings exercised.

### H18. NICE-TO-HAVE — JSON marshalling everywhere uses `org.json` with string-literal keys 🔴

`OrcaProfileLoader.kt`, `SettingsBackup.kt`, `PlateStore.kt`, `MoonrakerClient.kt`, etc. Migrate to `kotlinx.serialization` (~2 K LOC saved, schema-mismatch caught at compile time). Big diff but pays for itself across the next year of MCP tool growth.

### H19. NICE-TO-HAVE — `SubnetScanner.kt:57` magic numbers 🟢 SHIPPED

Lifted to `SCAN_CHUNK_SIZE = 32`, `DEFAULT_CONNECT_TIMEOUT_MS = 800`, `SUBNET_HOST_RANGE_END = 254`, each with a comment recording the empirical rationale (Android's connect-pool contention at higher fan-out, real-LAN miss at 250 ms timeout, /24 sweep range).

### H20. NICE-TO-HAVE — `RecessedFeaturesTest` is `@Ignore`d 🟢 SHIPPED

Dropped the `pitInABox` case (synthetic fixture had winding inconsistencies that confused the manifold-edge sign test; the detector itself works on real meshes — verified with Pikachu eye sockets via MCP). Remaining cube + empty-mesh cases still pin the curvature sign convention. 3 tests + 1 skipped → 2 tests + 0 skipped.

### H21. NICE-TO-HAVE — Several tests use `Thread.sleep` 🟢 SHIPPED

`AiPaintSessionStoreTest::lruEvictsOldestWhenAtCap` was the only outstanding instance (audit's mention of `ControllerInputTest` and `FlushActionsTest` was inaccurate — neither contains a `Thread.sleep` today). Replaced with explicit `setLastTouchedAtMsForTest` injection — runtime drops from ~20 ms to <1 ms; ordering is now deterministic.

### H22. NICE-TO-HAVE — `PaintInput.kt:34` documents an optimization opportunity but no benchmark 🟢 SHIPPED

`PaintInputBenchTest` builds a 50K-tri UV sphere, fires 200 random rays, and times BVH raycast (1.7 µs) vs naïve linear closest-tri (86 µs) — BVH is 50× faster. Verdict: the "skip the BVH" optimization only pays off if the closest-tri lookup is also BVH-accelerated. Updated the `PaintInput.kt` comment so future readers don't chase a phantom optimization.

### H23. NICE-TO-HAVE — `slic3r_jni.cpp:4780` mesh-boolean output is single-mesh 🟢 SHIPPED

`runBoolean` now composes `meshBoolean` → `splitObject` so a Difference that splits A into two parts (or a Union of two non-touching meshes) emits N `PlacedModel`s. No JNI signature change — reuses the existing Phase XR_OBJ_6 split path. Toast surfaces piece count when >1.

### H24. NICE-TO-HAVE — `slic3r_jni.cpp:6003` slab/chamber primitive is a placeholder cube 🟢 SHIPPED

The "// SLAB — cube for now" comment misled the audit. A SLAB is intentionally a rectangular prism with non-uniform dimensions (default 40×40×2 mm = a flat tile); `its_make_cube(x,y,z)` with three different values IS the right shape. Updated the comment in both `slic3r_jni.cpp` and `Primitives.kt` so the next reader doesn't re-flag this.

### H25. NICE-TO-HAVE — Vision tools have no rate limit 🟢 SHIPPED

`VisionRateLimiter` (token bucket: 2 req/s refill, 4-call burst capacity) shared as a process singleton across the four vision tools via `OkHttpVisionApiClient.send`. Cooperative cancellation flows through `delay`. Test uses an injectable clock so behavior is deterministic without sleeping.

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
| A12 (partial — JNI + MCP + 3MF round-trip shipped, dedicated Z-bar gizmo deferred) | Height-range modifiers (per-Z-range per-object settings) | `PlacedModel.heightRanges: List<HeightRange>` + JNI plumbing on `nativeSlice` / `nativeSliceMulti` / `nativeSaveAs3mf` writes onto `mo->layer_config_ranges` (libslic3r's `LayerRanges::assign` resolves overlaps with later band winning); `nativeRead3mfObjectConfigs` extracts bands on load. 5 MCP tools (`list_height_ranges`, `add_height_range`, `set_height_range_overrides`, `remove_height_range`, `clear_height_ranges`). 3MF round-trip via libslic3r's existing `Metadata/layer_config_ranges.xml` writer. UI deferred (mirrors D16's "JNI + MCP shipped, dedicated SpatialPanel deferred" precedent). 27 unit tests (`HeightRangeTest` + `HeightRangeToolsTest`) green. Exit criterion: 0–5 mm band with `sparse_infill_density=100` on a 20 mm cube → 100% density in layers 1–25 |

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
| E5 (phone) | Phone / tablet form factor | `MobileActivity` + 10 screens (Home / Files / Slicer / Preview / Paint / Filament / Monitor / Profile / Settings / Onboarding) sharing XR stores, MoonrakerClient, libslic3r JNI, AiRenderEngine. Material 3 BottomNav (phone) / NavRail (tablet). Activated when `Session.create` returns null. Touch paint, transform sliders, slice cancel, 3D toolpath viewer (Filament-android), interactive bed preview, mobile export, voice assistant + MCP tool driving. Cherry-picked commits: `ca4669f`, `4dc03f2`, `55cb19f`, `b51829b`, `c8b78ac`, `82f2805`, `44c4d58`. TV form factor still deferred (see E5 above) |
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

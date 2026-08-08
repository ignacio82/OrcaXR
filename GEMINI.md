# GEMINI.md

Canonical technical context for OrcaXR. Auto-loaded by Claude Code via
CLAUDE.md and by Codex via AGENTS.md at the start of every session in
this repo. Read this before any non-trivial work.

## Self-update mandate

**When any claim in this file becomes wrong or incomplete, fix it in the
same commit as the code change that caused the drift.** Do not append
errata sections. Do not let this file rot.

Update triggers (save it here, not as a throwaway comment):

- **Build quirks** — NDK flags, CMake workarounds, dependency version pins
  that matter, things that broke once and will break again.
- **Dependency gotchas** — versions of libs with known bugs, incompatibilities
  between Jetpack XR artifacts, upstream OrcaSlicer commits that must/must-not
  be picked up.
- **Architectural decisions** reached in conversation — module splits,
  threading model, JNI boundaries. Record the decision *and the reason*.
- **User preferences** expressed during work — how they want commits
  structured, code style calls, what they consider out-of-scope.
- **Non-obvious code behavior** — things that surprised you reading the
  code and will surprise the next session too.

Do **not** record things already derivable from reading the code (file
paths, function signatures, module names) unless they're load-bearing
*and* easy to get wrong. Keep this file under ~500 lines; split into a
separate doc if it grows past that.

## User preferences

**Always ship the best version, never the easiest.** When asked for
improvements or fixes, do not present an "easy vs. best" tradeoff and
do not ask the user to pick. List the improvements and execute all of
them in priority order. Only stop to confirm if there's a genuinely
irreversible action or a specification ambiguity the code cannot
resolve. The user wants OrcaXR to be the best it can be, period —
asking for permission to do less work wastes their time.

**For overnight / async work:** ship verified end-to-end commits, not
plans. Build, run the relevant tests, and iterate until green before
calling it done. A failing test left for the user to find is a
half-finished task.

## Mission

Build an XR-first 3D printing slicer for Web and XR devices. Not a port of
OrcaSlicer's wxWidgets UI — a ground-up XR UX with OrcaSlicer's slicing
engine (`libslic3r` via WASM) as the computational core.

## Target platform

- **Primary:** Web browsers and XR devices via WebXR/XRBlocks.
- **Target printers:** Snapmaker U1 (4-head toolchanger), Elegoo Centauri
  Carbon. Both are Klipper + Moonraker; this codebase has *no* serial,
  USB, or vendor-cloud printer support.
- **Not currently targeted:** native Android, native PCVR.

## Stack

| Layer | Choice |
|---|---|
| UI | HTML/JS/CSS |
| 3D & XR | XRBlocks for Spatial UI, 3D interaction, WebXR |
| Slicing core | OrcaSlicer `libslic3r` via WASM in the browser or via the Node.js backend server |
| Network | `fetchLocalNetwork`; typed Moonraker HTTP/WebSocket boundary (live read-only handshake/slot inspection) |

## Parity implementation invariants

- `docs/parity.md` is the canonical phased plan/evidence policy. The generated
  `docs/parity/snapmaker-v2.3.4.json` currently maps 1,622 upstream leaves in
  13 families to a task/adaptation using 17 exact Git blobs. Generate/check it
  only with `tools/parity/`; never hand-edit it or derive truth from a dirty
  upstream worktree. A mapped leaf is scope coverage, not implemented parity.
- `web/src/project/` is the UI-independent canonical graph/history boundary;
  domain code must not import DOM, XRBlocks, or Three UI objects. Enforce it
  with `npm --prefix web run architecture:check`. The explicit Three browser
  adapter stays in `project/surfaces`, is direct-imported, and is not exported
  by the headless project index. Transactional import and the per-plate revision/
  asset-guarded slice coordinator remain headless; live legacy state is only a
  migration source, never a second canonical model. Published G-code is bound
  to the exact submitted semantic snapshot; preview/download/send fail closed
  after drift; printer mutation stays disabled until P9 safety. Mixed recipes use stable physical-head IDs, never virtual rows; live Match uses a bounded worker, while auto-pair generation defaults off and requires count-bound confirmation above four physical filaments. Refined facet selection uses the version-1 root/source-face and child-path encoding: source vertices precede float32 shared midpoints, commit applies leaf targets before recursively collapsing homogeneous children, and malformed/deep/shared trees fail closed. Live UI and slicing share exact catalog-backed canonical preflight; ambiguous profile/build/nozzle mappings block, and Three/display defaults are never safety inputs. Preview projections consume rich typed columns and must return explicit unsupported metadata for missing exact filament colors or authoritative layer durations rather than inventing palette/time values. Split-to-objects must capture the exact revision/hash/selection/object scope before confirmation, revalidate it at commit, and leave canonical state untouched on cancel, stale input, unsupported metadata, or topology failure. Calibration requests bind exact definition version/fingerprint plus printer/nozzle/filament/process/firmware prerequisites; vendor automatic execution and any unsafe/stale/unbounded plan fail closed before canonical mutation. G-code inspection derives layer, move, tick, tool, source-window, and focus state from unrenumbered rich record IDs, retains only bounded source text, exposes incomplete prefixes, and never treats headless projection as proof of live controls. Official statistics require a same-export engine sidecar plus an opaque rich-source handle created by streaming SHA-256 over the exact UTF-8 G-code; source/source-asset identities use canonical FNV-1a64, project/config/output/artifact identities use SHA-256, and job/plate/revision/engine bindings also match. Sidecars are exact-key JSON with canonical dense capped arrays and finite bounded arithmetic; `plannerBlockCount` bounds float32 partitions and move subsets, `volumeSampleCount` bounds double material reconciliation, nonempty ordered custom segments cover planner total while a synthetic tail remains conditional, and sparse role-by-tool volumes equal model + support + wipe tower with flush excluded. Rich columns remain observations, missing assumptions propagate unavailable, detected conflicts are non-exhaustive/partial, and all-plate sums group by tool plus profile, expose partial silent coverage, retain a sole known cost unit while affected totals stay unavailable, and never reuse first-plate metadata.
- The live G-code viewer renders the bounded rich model plus the preview
  projection: `GcodePreviewSession` (UI-free) owns mode, layer window, and
  move-class filters, and `ui/preview/GcodePreviewSurface` draws exactly the
  projected records with the projection's RGBA. Never colour or filter a
  toolpath in the renderer, and never fabricate metadata the projection reports
  as unsupported. Standalone G-code opens read-only and must not touch canonical
  project state.
- Colour painting is canonical end to end: `web/src/project/painting/` owns the
  stable-ID palette projection and a UI-independent `PaintStrokeService`; live
  surfaces stream pointer samples, preview with a derived overlay, and commit one
  labelled undoable command on release. A facet stores the stable physical or
  mixed filament ID, never a palette index or predicted RGB, and the legacy
  display-colour paint panel/brush state is deleted. The `1`-`9` palette keys are
  nine discrete registry actions, matching upstream. The same tool set authors
  support (enforce/block), seam (prefer/avoid), and fuzzy-skin facets - the
  active modal tool owns the channel, so `PAINT_TOOL_CHANNELS` is the only
  channel authority - and the XR rail is an explicit seven-action list, never
  "every action with a tool". Standard-BBS export still
  projects a facet onto the transient engine slot, so official-Orca colour
  round-trip remains unproven.
- Model import (STL/OBJ/AMF/compressed AMF/ZIP) is signature-first and transactional:
  `web/src/project/import/formats/` decides the container from content, refuses a
  recognised extension that disagrees with the signature, and returns typed
  `requires-project-import`/`requires-native-kernel`/`requires-emboss-workflow`/
  `not-a-model-format` reasons for 3MF/STEP/SVG/G-code instead of re-parsing the
  bytes. `ModelImportParser` stages decoded objects/parts/instances through the
  same `ProjectImportCoordinator` as Open Project, so every add is previewed,
  deduplicated, undoable in one command, and leaves canonical state untouched on
  failure or cancel. Never add a second direct scene-insert import path.
- `ActionRegistry` is constructed once at the composition root and is the only
  invocation/availability gateway for DOM, menus, shortcuts, command palette,
  XR, and contextual Objects selection/rename/reveal. `implemented` requires a real
  handler/evidence mapping; all other states remain visibly and machine-readably honest. Generate shortcut matching and Help rows from registry declarations through the strict conflict-rejecting catalog; do not add a second hand-maintained shortcut list.
- CI and clean clones have no `third_party/SnapmakerOrca`, so every gate that
  derives from the pinned engine must degrade honestly instead of crashing:
  `profiles:verify` falls back to byte-exact SHA-256 verification of
  `web/scripts/profile-overlays.lock.json` (mirrors and adaptations both carry
  hashes), and `calibration:verify` falls back to integrity-checking the
  committed inventory's schema, pinned commit, and per-source blob hashes. Both
  print that upstream re-derivation was skipped; `--write`/sync still requires
  the checkout. Never make a gate silently pass when the checkout is missing.
- The browser engine must link with `-sDYNAMIC_EXECUTION=0`: embind otherwise
  builds its invokers with `new Function`, which the app's CSP (`script-src
  'self' 'wasm-unsafe-eval'`) refuses, so every in-browser slice fails while
  Node keeps working. Relinking also picks up whatever is in the fork worktree,
  so revert unrelated engine edits before rebuilding.
- An imported project slices as authored: its embedded printer/filament
  configuration is the preflight authority (`source: 'authored-project'`), so
  catalog preset identity is not required — but every safety fact must still be
  declared exactly by that configuration. Import must therefore keep per-tool
  `filament_type` and temperature ranges instead of collapsing them to
  "Unknown".
- Never emit an OPC relationship whose target is not in the same package: the
  pinned engine rejects the entire archive ("Archive does not contain a valid
  model"). Projections that drop preserved members must drop their
  relationships too.
- `wasm/slic3r_wasm.cpp`, `wasm/patches/`, `wasm/shim-include/`, and the build
  script hash into `wasm/artifact-provenance.json`. Editing any of them without
  rebuilding and republishing the artifacts breaks `verify:artifacts`, and the
  edit would ship as source that the checked-in engine does not contain. Engine
  changes must land as committed `wasm/patches/*.patch` (a dirty
  `third_party/SnapmakerOrca` worktree is never the authority), then rebuild,
  publish, and update the provenance manifest in the same change.
- `./scripts/quality.sh` is the clean-clone repository gate. Web-only changes
  must at minimum pass `npm --prefix web run quality`; do not weaken a failing
  check or claim broad parity before P12.6 is independently verified.

## XRBlocks spatial UI contract (load-bearing)

OrcaXR exact-pins **XRBlocks 0.17.0** and **`@pmndrs/uikit` 1.0.74** in
both `web/package.json` and `web/package-lock.json`. Treat the installed XRBlocks
types/source and `web/node_modules/xrblocks/src/addons/uiblocks/SKILL.md` as
the API authority for that version. Then use the version-matched samples and
the official [Spatial UI](https://xrblocks.github.io/docs/manual/UI/),
[UIBlocks](https://xrblocks.github.io/docs/manual/UIBlocks/),
[Inputs](https://xrblocks.github.io/docs/manual/Inputs/), and
[Simulator](https://xrblocks.github.io/docs/manual/Simulator/) manuals for
intent. Generic `@pmndrs/uikit` knowledge and unversioned snippets come last.
The high-level docs already disagree with 0.17.0 on constructors, defaults,
color parsing, and behavior property names, so never guess an API. On upgrade, inspect the new
types/source, rerun XR interaction/performance tests, and update this section.

Choose one UI system for each physical panel:

- Use the core `View` family for simple standalone surfaces: `Panel`,
  `SpatialPanel`, `Grid`/`Row`/`Col`, `ImageView`, `TextView`, pagers,
  scrolling text, and the virtual keyboard. Core views use relative `x`/`y` in
  roughly `[-0.5, 0.5]`, fractional `width`/`height`, scene-depth render order,
  and a centered largest-square local coordinate system exposed through
  `aspectRatio`, `rangeX`, and `rangeY`. Let the parent run
  `updateLayoutsBFS()` after structural/layout changes.
- Use the `uiblocks` addon for production application cards that need nested
  flex layout, padding/gaps, strokes, gradients, rounded corners, shadows,
  images, icons, or rich interaction. **Never mix core `Panel`/`SpatialPanel`
  children with `UIPanel`/`UICard` children on the same physical surface.** A
  core pager or keyboard must be its own spatial panel.

Core `TextButton`/`IconButton` use `onTriggered` across mouse, controller, and
pinch. The separate `xrblocks/addons/virtualkeyboard/Keyboard.js` panel exposes
`onTextChanged`, `onEnterPressed`, and `setText`; its 1.0 m × 0.555 m default at
`(0, 1.2, -1)` is a starting pose to requalify for OrcaXR, not a fixed layout.

UIBlocks initialization is all-or-nothing: call `options.enableUI()`, call
`options.uikit.enable(uikit)`, and set
`xb.core.input.raycaster.sortFunction = raycastSortFunction` during script
initialization. Missing any one commonly produces visible but non-interactive
UI. `UICore.createCard()` registers the card and adds it to the owning script;
do not add it to the scene a second time. `unregister()` and `clear()` remove
and dispose cards, so use them only when destruction is intended.

Build each independently positioned spatial surface as **one `UICard` pivot**
with nested `UIPanel`s; do not make every visual section a separate card.
Always specify the card's physical `sizeX`/`sizeY` in metres and `pixelSize` in
metres per layout pixel—0.17.0 defaults differ from published guidance. Set an
explicit flex direction, alignment, padding/gap, and child sizing; use
`width: 'auto'` plus `alignItems: 'center'` for centered shrink-wrapped content
when appropriate. Do not use large Z offsets for hierarchy: use stroke/shadow/
contrast and only a tiny measured offset (about 0.001 m) to resolve real
z-fighting.

Use the exact 0.17.0 construction and mutation APIs:

- `new UIPanel(options)`, `new UIText(text, options)`,
  `new UIIcon(iconName, options)`, and `new UIImage(src, options)`.
- There is no built-in button class. Compose a `UIPanel` with text/icon,
  `onClick`, and explicit default/hover/pressed/disabled/selected/focus states.
  The pinned callback is `() => void`; do not depend on returning a boolean to
  consume an event.
- Change live state with signal-aware methods such as `setFillColor`,
  `setStrokeColor`, `setStrokeWidth`, `setCornerRadius`, `setProperties`,
  `setText`, and `setColor`. Direct assignments such as `.fillColor`, `.color`,
  or `.opacity` are neither the typed nor reliably reactive API.
- UIBlocks uses `fillColor`, `strokeWidth`, `strokeColor`, and `cornerRadius`,
  not CSS-like `backgroundColor`, `borderWidth`, `borderColor`, or
  `borderRadius`. Prefer portable `#RRGGBB` plus explicit opacity; use alpha hex
  only where the pinned parser is covered by a test. Avoid `rgba()`/`hsla()`.
- `UIIcon` loads Material Symbols from a CDN in 0.17.0. Core product UI must
  instead use bundled, pure-white SVGs through `UIImage` (or a verified local
  icon wrapper) so icons work offline, under CSP, and without runtime tracking
  or layout shifts.

The 0.17.0 behavior names and units are exact: `HeadLeashBehavior` takes
`offset: THREE.Vector3` plus optional `posLerp`/`rotLerp`; `BillboardBehavior`
takes `mode: 'cylindrical' | 'spherical'` and optional `lerpFactor`;
`ManipulationBehavior` takes `draggable`, `faceCamera`,
`manipulationMargin`/`manipulationCornerRadius` in layout pixels;
`ObjectAnchorBehavior` takes a target, pose mode, and offsets; and
`ToggleAnimationBehavior` takes scale animations plus duration in seconds.
Properties seen in older examples such as `constrainToCameraY`, `distance`,
`heightOffset`, or `lerpSpeed` are invalid for the pinned version. Use gentle
head leash only for user-critical HUDs, cylindrical billboard for stable
world panels, and a deliberate header/frame as the manipulation grab target.
Do not combine pose anchoring with billboarding, or head leash with another
rotation-owning behavior; they write the same transform each frame.

Design for spatial comfort and inclusion, not a flat desktop UI in 3D:

- Derive placement from `xb.user.height`, `xb.user.panelDistance`, and the
  safe-space radius. Keep primary controls around eye/chest height and within
  comfortable arm/ray reach; start body text near 20–28 layout px at roughly
  1.5–1.75 m only as a testable baseline, never as a universal constant.
- Use a small token system for `pixelSize`, type scale, spacing, corner shape,
  depth, and a restrained palette. Passthrough surfaces need sufficiently
  opaque text backplates, contrast at both ends of every gradient, and
  stroke/shadow separation. Never communicate state by color alone.
- Keep motion short and purposeful (about 0.2 s is a starting point), provide
  visible hover/press/selection feedback, avoid repeated head-locked motion,
  and add OrcaXR-owned reduced-motion behavior because XRBlocks does not supply
  the product policy.
- Every flow must work with simulator mouse, tracked-controller rays, hands,
  and Android XR gaze/select where available. Validate hit ordering, occlusion,
  scroll/pager behavior, modal focus, cancel/back, destructive confirmation,
  tooltips, text entry, and the virtual keyboard on a real headset. XRBlocks'
  simulator abstracts input but does **not** emulate the WebXR API.
- UIBlocks has no stable semantic buttons, fields, dialogs, focus order, ARIA/
  screen-reader bridge, or proven XR scrolling primitive. OrcaXR must own those
  composites and metadata, keep a complete accessible DOM counterpart, and use
  paging/search/disclosure until scrolling is proven with ray and hand input.
  Never use `window.prompt()` in XR or cycle an unknown choice on each pinch;
  open an explicit labelled list/dialog with confirm, cancel, and keyboard.

`UICard` is itself an XRBlocks script. The scene `ScriptsManager` is the sole
per-frame update owner; never restore a manual `UICard.update()` loop. Core is
the sole scene-gesture dispatcher; do not add another `selectstart`/`selectend`
manipulation path. The only native `XRSession` `select` exception is
`OrcaWorkspace`'s synchronous file-picker activation listener; it is lifecycle-
disposed and must never manipulate the scene. Its idempotent `dispose()` also
removes the sole capability subscription, window/canvas/XR listeners, controls,
cards, and owned GPU resources. A gesture starting beneath any `UICard` stays
suppressed through release for that controller; controllers remain independent.
Hidden scripts need a measured detach/pause lifecycle, not `visible = false`.
P10.10 still requires counters, repeated lifecycle leak checks, and Galaxy XR qualification.

## Upstream slicer strategy

- **Parity/production base:** Snapmaker OrcaSlicer v2.3.4, exact commit
  `9fd12ffb2b1b80c9fb4c14564754d2ec1573a626`. Browser WASM, Node/WASM,
  native server CLI, parity extraction, and oracles must name this same revision.
- `third_party/SnapmakerOrca` is a developer source checkout. Truth tooling reads
  exact Git blobs at the pinned commit and never trusts its dirty worktree.
- `wasm/artifact-provenance.json` records the engine revision, aggregate build-
  input hash, output hashes, and the only tracked published copies:
  `wasm/dist` and `web/public/slicer`. `npm --prefix wasm run verify:artifacts`
  fails on source/patch or copy drift. A hash match proves provenance consistency,
  not a clean source rebuild; the manual container source-build gate remains.
- The old upstream-v2.3.2 Android submodule/patch history below is retained only
  for the retired native-Android implementation. It is not the web parity source
  and must not drive new browser/server behavior.

## libslic3r gotchas (load-bearing)

1. **Uninitialized POD members in `Print.hpp` / `WipeTower.hpp` silently corrupt slices on Android arm64 Release.** Patches `0011-skip-gcode-append-full-config.patch` and `0012-print-init-uninitialized-members.patch` cover this.

2. **A config key set via `set_deserialize_nothrow` only takes effect if libslic3r recognizes it as a known PrintConfig option, AND the key is whitelisted in `OrcaProfileLoader.SAFE_KEYS`.** Unknown keys are silently dropped.

3. **JNI `ScopedUtf` releases must happen before `DeleteLocalRef`, not after.**

4. **`ConfigOptionEnumsGeneric` instances need their `keys_map` re-attached after `FullPrintConfig::defaults()`.**

5. **Don't override the U1 profile's `machine_start_gcode`.**

6. **Real multi-tool slicing requires `single_extruder_multi_material=false`.**

7. **`update_values_to_printer_extruders_for_multiple_filaments` null-derefs on filament-prefixed nullable options.** Patch `0013-toolchanger-handle-nullable-cast.patch` fixes this.

8. **3MF loader dispatch is BBS-leaning and breaks on Prusa / MakerWorld files.** Use `Model::read_from_archive` which sniffs Prusa-vs-BBS. In browser imports, official BBS multi-plate membership lives in `Metadata/model_settings.config` as `(object_id, instance_id)` pairs; core `<build>` transforms use the global 1.2×-bed plate grid, so resolve exact membership and `printable_area` or fail closed, then subtract the source origin. Canonical transforms stay plate-local; only standard BBS export re-adds that virtual origin. Never guess from thumbnails or spatial clusters. Production-extension `p:path` IDs are model-part-local: key references by normalized package path plus ID, permit external paths only from the root model, recursively compose same-part child components including repeats, and reject missing/conflicting paths or IDs, traversal, cycles, depth over 64, and expansion over 16,384 nodes. Preserve original split `.model` members opaquely, but remove `p:path` from the generated flattened core. A read-only `MarbleRunTube_V7.3mf` smoke resolved 26 external parts into 5 plates/28 objects/29 volumes/28 instances and passed in-memory canonical save/reopen; this is headless evidence, not official GUI qualification. Do not add a blanket affine-shear rejection: that real Orca archive contains such build matrices, while arbitrary shear remains an explicit residual of the canonical TRS projection.

9. **`load_bbs_3mf` requires `LoadStrategy::LoadModel | LoadConfig | AddDefaultInstances`.** DO NOT add `LoadAuxiliary` (=16) as it fails on Android's read-only filesystem.

10. **`load_bbs_3mf` segfaults if you pass `nullptr` for `file_version`.**

10b. **3MF preview colors live in the embedded `filament_colour` array.** Read it directly from the zip to avoid filesystem issues.

11. **GLB writer OOMs on large meshes if using one big ByteBuffer.** Stream to a `BufferedOutputStream` instead.

12. **Multi-object 3MFs need an explicit row layout.** Use the `row_layout` helper in `slic3r_jni.cpp`.

13. **Per-plate temperature keys must all be in `SAFE_KEYS`.**

14. **`Print::set_status_callback` fires from TBB worker threads.** The JNI shim must attach/detach the JVM.

15. **Headless slice tests must inject `before_layer_change_gcode = "G92 E0\n"`.**

16. **Patch `0011-skip-gcode-append-full-config` is permanent.**

17. **Multi-color slicing on arm64 needs the TBB serial shim opted into four specific TUs.** Patch `0014-android-tbb-serial-shim-activation.patch` handles this to prevent race conditions on ARM64.

18. **`tbb::scalable_malloc` is broken on Android arm64.** We wrap it to libc malloc/free at link-time.

19. **PrintConfig collection delimiters are type-dependent.** Every `coStrings`
    option uses `;`; every other vector option uses `,`. A comma-joined color
    list parses as one color and can silently shrink the engine's filament
    count—the trigger for patch 0075 (see 19d). Web's shared
    `web/src/settings/configSerialization.ts` classifier is used by ConfigIO
    and ProfileLoader; its 26 unique `coStrings` keys are checked against all
    174 generated PrintConfig vector definitions; direct overrides follow it too.

19b. **`coord_t` is `int64_t` but `size_t` is 32-bit on wasm32 — `some_vector.size() - 1` assigned to a `coord_t` underflows to `+4294967295`, not `-1`.** This is the WASM slicer's #1 crash class: `SkeletalTrapezoidation::interpolate` (Arachne) did `for (coord_t next_inset_idx = left.toolpath_locations.size() - 1; next_inset_idx >= 0; …)`. When `left` is an empty beading (thin feature → `bead_count 0` → `compute()` returns empty vectors), `0u - 1` is a 32-bit `0xFFFFFFFF` that **zero-extends** into the signed 64-bit `coord_t` as `+4294967295`, so the loop runs and indexes `toolpath_locations[4294967295]` → `RuntimeError: memory access out of bounds` inside `propagateBeadingsDownward`. On 64-bit builds `size_t` is 64-bit so `0-1` → `-1` and the loop is skipped — which is why native Android/desktop never hit it while the WASM slicer crashed on essentially **every** model with a thin region (3DBenchy, logos). Fix: `coord_t(v.size()) - 1` (cast to signed before subtracting). Shipped as `patches/0074-arachne-32bit-size-underflow-oob.patch`. **When auditing the WASM port for crashes, grep for `.size() - 1` / `.size()-1` feeding a signed `coord_t`/`int` index and any other 32-bit-vs-64-bit width assumptions.** **ENGINE SWITCH (2026-07-05): the WASM slicer now builds from the Snapmaker fork** — `third_party/SnapmakerOrca` (gitignored clone of Snapmaker/OrcaSlicer v2.3.4, FullSpectrum-native since 2.3.3), the SAME source the external slicer container's CLI builds, so web and CLI G-code match at the source level. After editing a libslic3r `.cpp`: `ninja -C third_party/SnapmakerOrca/build-wasm libslic3r`, then relink via `wasm/build_wasm_module_snapmaker.sh`, publish only `wasm/dist/{slic3r.mjs,slic3r.wasm}` and `web/public/slicer/`, and run `npm --prefix wasm run verify:artifacts`; the server image copies `wasm/dist` and `web/dist/slicer` is generated by the web build. Full from-clean rebuild recipe + working-tree snapshot: `wasm/patches/README-snapmaker.md` + `snapmaker-fork-wasm-port.diff` (Emscripten gates, Arachne 0074 fix, `init_filament_option_keys()` ctor fix, `normalize_fdm` null-guard, `append_full_config` gate — the fork shares those bugs with upstream; the 0075 BBS multi-extruder OOB family does NOT exist in the fork's older ToolOrdering). The old upstream-v2.3.2 port (patches 0001-0075 + `wasm/build_wasm_module.sh`) remains the ANDROID engine; its wasm build assets were reclaimed by `build_native.sh`'s clean (`wasm/patches/wasm-port-tracked-changes.diff` snapshots it if ever needed again). **FullSpectrum project slicing is LIVE in the web engine**: `startSliceProject` + `SlicerClient.sliceProject` slice a loaded FS 3MF as-authored (embedded mixed_filament_definitions, per-part virtual extruders) — PeggyPalette produces 294 layers / 296 tool changes / T0-T3 in ~43 s (Node) and in-browser. `OrcaWorkspace.sliceNow` now captures the live canonical state, serializes the active plate to BBS 3MF through `CanonicalWorkspaceSlicer`, and publishes only a revision/project-hash/asset-hash guarded browser-WASM result. Scene-baked STL and immutable raw-source fallbacks were deleted; configured external slicing fails closed until independent engine-provenance attestation exists.

19c. **Do NOT precache the slicer WASM in the PWA service worker — serve `/slicer/` NetworkFirst.** `web/vite.config.ts`'s VitePWA once raised `maximumFileSizeToCacheInBytes` to 20 MB specifically to precache the ~16 MB `slic3r.wasm` cache-first. That pins a stale engine: after a libslic3r fix rebuilds the wasm, the browser's SW keeps serving the OLD binary, so a slice **hangs forever with no progress and no error** on the outdated module (verified 2026-07-03 — node + a headless-browser slice of the fresh wasm both completed in ~13–17 s while the user's SW-controlled session hung). Fix in place: `workbox.globIgnores: ['**/slicer/**']` + a `NetworkFirst` `runtimeCaching` route for `/slicer/` (fresh when online, cached fallback for offline XR). **Gotcha within the gotcha:** in dev (`npm run dev`) VitePWA registers no SW, and dev serves the wasm with `Cache-Control: no-cache`, so dev itself is always fresh — BUT a SW registered by a *prior* `vite preview`/prod visit on the **same localhost origin** keeps controlling the page and serving stale cache, and the dev server won't replace it. If a web slice hangs at 0 % with a fixed wasm on disk, suspect a stale SW first: DevTools → Application → Service Workers → Unregister + Clear storage, then reload (on Galaxy XR Chrome: clear site data / `chrome://serviceworker-internals`). Validate SW behaviour against `vite preview` (which serves `sw.js`), not dev.

19d. **Multi-material tool ordering had a whole OOB family — patch 0075 — and painted (multi-colour) WASM slicing is now ENABLED.** Symptoms before the fix: slicing anything whose regions used a filament other than #1 either hard-crashed the WASM module (`memory access out of bounds` in `calc_filament_change_info_by_toolorder` / heap-corrupting write in `cal_most_used_extruder` → abort in `emscripten_builtin_free`) or **silently truncated the print at the colour boundary** (`reorder_extruders_for_minimum_flush_volume` returns EMPTY per-layer sequences for filaments outside its universe and overwrites `m_layer_tools[i].extruders` with them). Root theme: per-filament vectors vs the filament count consumers disagree — ToolOrdering sized from `filament_colour`, PrintApply from `filament_diameter`, `filament_map` defaults to `{1}` and NOTHING resizes it because **upstream defines `PrintConfigDef::init_filament_option_keys()` but never calls it, making `DynamicPrintConfig::set_num_filaments()` a silent no-op** (fixed in the ctor). Fix layers: patch 0075 (ctor call + bounds guards + `max(colour, diameter)` sizing + keep collected extruders when the reorder DP loses a layer), the wasm shim normalizes filament vectors + `filament_map` AFTER overrides (`finish_slice`), and the web sends `;`-separated string vectors (gotcha 19). Regression tests: `wasm/test_slice_painted.mjs` (two stacked cubes, filaments 1+2, deliberately comma-broken colour list; run plain and with `ORCAXR_PRIME_TOWER=1`). `OrcaWorkspace.paintedSliceEnabled` is now `true`; the prime tower is no longer force-disabled on the painted path. Note the wipe tower requires relative E (per-layer `G92 E0`, gotcha 15) — real profiles carry it. The Android JNI never calls `set_num_filaments`, so 0075 is behaviourally inert there for well-formed configs.

20. **FullSpectrum mixed-filament integration: data-model + wire format are at FS v0.9.9 parity, engine emission is NOT ported.** As of 2026-05-10 the patches 0015-0024 land all data structures (`MixedFilament.{cpp,hpp}`, `filament_mixer*`, `LocalZOrderOptimizer.hpp`), register the 17 PrintConfig keys (`mixed_filament_*`, `dithering_*`, `local_z_wipe_tower_purge_lines`), and add the `MixedFilamentManager` member on `Print`. The Kotlin side (`MixedFilamentEntry`, `MixedFilamentStore.toMixedFilamentDefinitions`, `parseMixedDefinitionsForKotlin` in MainActivity, `OrcaProfileLoader.SAFE_KEYS`, `SlicerEngine.PROJECT_OVERRIDE_KEYS`, `MixedAdvancedEditor` UX, MCP `set_mixed_filament_row` / `delete_mixed_filament_row` / `list_mixed_filaments`) all speak the v0.9.9 wire format and round-trip cleanly. **Patches 0027-0067 landed + verified compile-clean 2026-05-11. Local-Z gcode emission is live end-to-end with no double-print. FullSpectrum-specific JVM test (`MixedFilamentWireFormatTest`) passes. Pre-existing 24-test JVM-suite flakiness in MCP paint tools (`runTest` virtual-time timeouts in `AiPaintToolsTest`/`PaintWithMirrorTest`/`LlmPaintingAmplifiersTest`/etc.) is unrelated to FullSpectrum — none of patches 0044-0067 touched those test sources or their deps; don't confuse the two when investigating regressions.** Every FS file delta NOT entangled with the Local-Z planner has been ported:
  - 0027 `PrintConfig.hpp` typed fields for the 20 FS dithering + mixed-filament keys
  - 0028 `ToolOrdering.hpp::LayerTools::object_layer_count`
  - 0029 `ExtrusionEntity.hpp` inset_idx propagation through MultiPath/Loop copy/move/assignment
  - 0030 `PerimeterGenerator.cpp` inset_idx population on emitted Loops/MultiPaths
  - 0031 `VariableWidth.cpp` gap-fill loop dedup + closed-loop single-extrusion shortcut (FS print-quality improvement)
  - 0032 `LayerRegion.cpp` + `Layer.hpp` + `Fill/Fill.cpp` virtual filament resolution at the per-layer flow / extruder level
  - 0033 `Layer.cpp` surface metadata preservation across merged-region perimeter generation
  - 0034 `Preset.cpp` + `PrintRegion.cpp` infill-filament-override at preset / extruder-collection time
  - 0035 `PrintApply.cpp` mixed-component expansion for painted virtual filament IDs
  - 0036 `ToolOrdering.cpp` infill resolution (FS override + boundary-layer + grouped manual_pattern)
  - 0037 `PrintObject.cpp` config-key invalidation for the FS keys
  - 0038 `PrintConfig.cpp` registers the three FS region-level override keys (defaults + GUI metadata)
  - 0039 `ToolOrdering.cpp::collect_extruders` populates object_layer_count + routes 100%-density solid infill via sparse path + emits through LayerTools FS-aware methods
  - 0040 `PrintObject.cpp` apply_to_print_region_config / slicing_parameters / combine_infill respect the FS override toggle
  - 0041 `PrintApply.cpp` painted-region creation gated on mm_paint_applies_to_parent_region + unique-region instances per painted extruder
  - 0042 `PrintObject.cpp` separate invalidation block for the 8 FS mixed-filament gradient + region-collapse keys (without it `mixed_filament_definitions` changes silently reuse old slice state)
  - 0043 `PresetBundle.cpp::s_project_options` adds the 15 FS keys so `mixed_filament_definitions` persists into the saved .3mf's `Metadata/project_settings.config` (without this, virtual rows are lost on save+reopen)
  - 0044 `Print.hpp` Local-Z type scaffolding: `LocalZInterval` struct + `SubLayerPlan` struct + `PrintObject::local_z_intervals()` / `local_z_sublayer_plan()` / `set_local_z_plan()` / `clear_local_z_plan()` accessors + `m_local_z_intervals` / `m_local_z_sublayer_plan` private members + `WipeTowerData::local_z_tool_changes` field. **Dead code** — nothing populates or reads these yet.
  - 0045 `PrintObjectSlice.cpp` Local-Z helper batch 1: `bool_from_full_config`, `float_from_full_config`, `segmentation_channel_filament_id`, `mixed_filament_reference_nozzle_mm`, `clamped_mixed_component_surface_offset` + `#include <numeric>`. All static helpers, dead-code until `build_local_z_plan` (future patch) consumes them.
  - 0046 `PrintObjectSlice.cpp` Local-Z helper batch 2 (pass-height math, ~390 LoC): `fit_pass_heights_to_interval`, `sanitize_local_z_pass_heights`, `build_uniform_local_z_pass_heights`, `build_uniform_local_z_pass_heights_exact`, `compute_local_z_gradient_component_heights`, `choose_local_z_start_with_component_a`, `build_local_z_alternating_pass_heights`, `build_local_z_two_pass_heights`, `build_local_z_shared_pass_heights`, `build_local_z_pass_heights` (dispatcher). All static, redistribute a nominal layer's vertical budget across N sub-passes while honoring [lo, hi] envelopes.
  - 0047 `PrintObjectSlice.cpp` Local-Z helper batch 3 (row-sequence decoders, ~375 LoC + LocalZActivePair struct): `decode_manual_pattern_sequence`, `decode_gradient_component_ids`, `decode_gradient_component_weights`, `reduce_weight_counts_to_cycle_limit`, `build_weighted_gradient_sequence`, `pointillism_sequence_for_row` (`#if 0`-gated mirror of FS), `local_z_eligible_mixed_row`, `local_z_direct_multicolor_row`, `unique_extruder_count` + `struct LocalZActivePair { component_a, component_b, mix_b_percent, uses_layer_cycle_sequence, valid_pair() }`. Turns MixedFilament row config strings into per-extruder cycles.
  - 0048 `PrintObjectSlice.cpp` Local-Z helper batch 4 (pair-cycle planner, ~250 LoC): `append_local_z_pair_option`, `build_local_z_pair_cycle_for_row`, `build_local_z_direct_multicolor_pass_heights`, `build_local_z_direct_multicolor_sequence`, `derive_local_z_active_pair`. Maps a row's gradient ID list into a per-cadence sequence of LocalZActivePair options + multi-component pass height/sequence pairs.
  - 0049 `PrintObjectSlice.cpp` Local-Z helper batch 5 (mask stripes, ~150 LoC): `split_masks_pointillism_stripes` (XY stripe splitter, alternates vertical/horizontal each layer), `non_empty_mask_count`, `collect_layer_region_slices`. Pure geometric helpers.
  - 0050 `PrintObjectSlice.cpp` `apply_mixed_region_surface_offsets` (~145 LoC): walks every LayerRegion of every Layer and, for mixed-filament regions with non-zero per-component surface offsets, contracts (offset > 0) or expands (< 0) the region's slice geometry, subtracting stolen geometry from neighbours when expanding. Gated off when `dithering_local_z_mode` is on or `mixed_filament_component_bias_enabled` is off.
  - 0051 `PrintObjectSlice.cpp` Local-Z helper batch 7 (planner input-prep, ~278 LoC): `export_local_z_plan_debug` (no-op stub — FS body needs <fstream>+SVG.hpp), `whole_object_local_z_segmentation_by_mixed_wall`, `local_z_planner_segmentation_with_whole_object_mixed_wall`, `collect_local_z_fixed_state_masks_by_extruder`, `build_local_z_transition_fixed_masks_for_pass`. Prepares the (layer × channel × ExPolygons) segmentation grid + per-sublayer fixed-region mask emission that `build_local_z_plan` consumes.
  - 0052 `PrintObjectSlice.cpp` **build_local_z_plan** template (~990 LoC) — the central Local-Z planner. Walks every layer, reads the FS dithering config keys, builds per-mixed-row state (pair cycles + direct-multicolor solver + pointillism eligibility), and emits LocalZInterval + SubLayerPlan records into `PrintObject::set_local_z_plan` with painted_masks_by_extruder + fixed_painted_masks_by_extruder routed per sublayer Z pass. Honors per-row cadence + layer-cycle indices so A/B sequences don't restart at painted boundaries. Consumes every helper landed in 0044-0051. Compile-clean on first try via bottom-up ordering.
  - 0053 `WipeTower2.hpp/cpp` Local-Z scaffold (LZ4a, ~466 LoC): adds WipeTowerInfo::local_z_tool_changes + local_z_reserve_slot_depth/_count members + planned_depth() accessor; m_local_z_wipe_tower_purge_lines ctor-time field; plan_local_z_toolchange(z, h, old, new, wipe_vol) + plan_local_z_reserve(z, h, count, wipe_vol) method bodies.
  - 0054 `WipeTower2.hpp/cpp` soluble + depth helpers (LZ4b, ~521 LoC): layer_has_soluble_toolchange(layer) + cumulative_toolchange_depth_before(tool_change*) — both UNION layer.local_z_tool_changes with layer.tool_changes so callers can treat a wipe-tower layer as a single sequence.
  - 0055 `WipeTower2.hpp/cpp` Local-Z emission (LZ4c, ~677 LoC): local_z_tool_change(new_tool, cleaning_box, wipe_volume) emits one per-sub-Z purge as gcode (unload+change+load+wipe); get_local_z_reserve_boxes() returns per-layer pre-reserved purge boxes sized from local_z_reserve_slot_depth/_count; static rotate_local_z_reserve_point() helper. Adapts FS to our v2.3.2 baseline (5-arg WipeTowerWriter2 ctor, no m_change_pressure, toolchange_Wipe takes interface_layer bool).
  - 0056 `PrintObjectSlice.cpp` Local-Z planner wired into slice_volumes (LZ5a, 52 LoC): `dithering_local_z_mode` gate, whole_object_local_z_segmentation_by_mixed_wall → build_local_z_plan → set_local_z_plan; also actually CALLS apply_mixed_region_surface_offsets (was dead code prior). First patch in series where Local-Z code runs end-to-end at slice time. Painted-Local-Z path (FS line 5005, merged via local_z_planner_segmentation_with_whole_object_mixed_wall) deferred to LZ5c — needs apply_mm_segmentation refactored to expose the intermediate segmentation grid.
  - 0057 `Print.hpp/GCode.hpp/GCode.cpp` Local-Z purges plumbed into WipeTowerIntegration (LZ5b, 339 LoC): WipeTowerData::local_z_reserve_boxes vector + clear(); WipeTowerIntegration ctor + 4 new members (m_local_z_tool_changes, m_local_z_reserve_boxes refs + m_local_z_tool_change_idx, m_local_z_reserve_slot_idx per-layer cursors); next_layer() resets the cursors; call site at GCode.cpp:3290 forwards the new WipeTowerData fields.
  - 0058 `GCode.hpp/GCode.cpp` WipeTowerIntegration::tool_change Local-Z dispatch (LZ5c, 225 LoC): signature gains two optional params (`local_z_unplanned=false`, `local_z_nominal_layer_z=-1.`); early-return branch when `local_z_unplanned` is true that tries to consume the next preplanned tcr from `m_local_z_tool_changes[m_layer_idx]` matching (initial_tool, new_tool), else falls back to `gcodegen.set_extruder()` at `toolchange_print_z`. OrcaXR adapts FS's `writer().extruder()` to our `writer().filament()` (same accessor, different name). The reserve-box ad-hoc emission path (FS lines 1003-1188 — ephemeral WipeTower2 on a reserve box) is deferred — needs Print& threading.
  - 0059 `Print.cpp/WipeTower2.hpp` Local-Z reserve-box hook (LZ5d, 203 LoC): captures `wipe_tower.get_local_z_reserve_boxes()` into `m_wipe_tower_data.local_z_reserve_boxes` after the legacy `WipeTower2::generate(...)` call; promotes `local_z_tool_change` / `get_local_z_reserve_boxes` from private to public in `WipeTower2.hpp`.
  - 0060 `Print.cpp` `collect_local_z_wipe_tower_toolchanges` + wipe-tower planning hook (LZ5e, 530 LoC): anonymous-namespace block with `LocalZWipeTowerToolchange` + `LocalZWipeTowerPassRef` structs, perimeter intersection probes, small extruder-ordering helpers, and the ~325-LoC `collect_local_z_wipe_tower_toolchanges` itself (legacy print_z-group mode + dependency-chain topological scheduler). Wires `collect_layers_to_print` → `collect_local_z_wipe_tower_toolchanges` → `WipeTower2::plan_local_z_toolchange` into the wipe-tower planning loop. **With patch 0060, Local-Z purges are actually PLANNED through the wipe tower.**
  - 0061 `GCode.cpp` `process_layer` Local-Z context setup (LZ5f scaffold, 255 LoC): `LocalZPassBucket` / `LocalZLayerContext` struct defs + per-LayerToPrint setup loop that walks `PrintObject::local_z_sublayer_plan()` and accumulates one bucket per `split_interval` plan with perimeter-expanded per-extruder masks (compensation = 0.10 mm). Gated off when `is_anything_overridden` is true.
  - 0062 `GCode.cpp` `process_layer` Local-Z pass-ref prep (LZ5g-prep, 352 LoC): `local_z_perimeter_phase_b_enabled` flag + `LocalZPassRef` struct + `local_z_pass_refs` sort + three accessor lambdas. Diagnostic log on prep.
  - 0063 `GCode.cpp` Local-Z extrusion-clipping helpers (LZ5g helpers, 539 LoC): file-scope static helpers — `apply_local_z_flow_height_override`, `append_clipped_path`, `local_z_compensate_masks`, `struct LocalZPathHeightStats` + 3 overloads, `clip_extrusion_collection_for_local_z`. All static, used by patch 0065.
  - 0064 `GCode.cpp` Local-Z mixed_masks_union setup (LZ5g population step 1+2, 583 LoC): extends patch 0061's setup loop to populate `ctx.mixed_masks_union` from each appended bucket's compensated masks; computes `mixed_masks_union_for_base_exclude` via `local_z_compensate_masks` with the 0.04 mm base epsilon; rejects contexts with empty unions (sets `ctx.enabled = false`). Removes (void)-cast on `local_z_base_mask_expand` — now used.
  - 0065 `GCode.cpp` Local-Z perimeter clipping into pass_buckets (LZ5g population step 3, 675 LoC): adds the per-extrusion clipping branch that populates `LocalZPassBucket::by_extruder` via `clip_extrusion_collection_for_local_z`. ADDITIVE — normal flow continues for now.
  - 0066 `GCode.cpp` **Local-Z phase-b Z-walk emission (LZ5g-emit, 866 LoC)**: emits the actual sub-Z gcode. When `local_z_pass_refs` is non-empty: emits `; local-z phase-b perimeter passes begin\n`, defines `emit_local_z_toolchange` (calls `m_wipe_tower->tool_change(.../*local_z_unplanned=*/true)` or `set_extruder` fallback) + `emit_local_z_pass_for_extruder` (retract→`travel_to_z(pass_z)`→`sort_print_object_instances`→per-island `extrude_perimeters`), runs `emit_local_z_legacy` (print_z-grouped via `LocalZOrderOptimizer::order_bucket_extruders`). Dependency-chain mode falls through to legacy. Adds top-of-file `#include "LocalZOrderOptimizer.hpp"`.
  - 0067 `GCode.cpp` **Local-Z base-mask exclude (LZ5h, 938 LoC) — FINALIZES Z-walk**: closes the LZ5g over-extrusion gap. After the LZ5g clipping branch, introduces `filtered_extrusions = extrusions` and (for PERIMETERS + enabled context + non-empty `mixed_masks_union`) calls `clip_extrusion_collection_for_local_z` with `include=nullptr` and `exclude=mixed_masks_union_for_base_exclude` (0.04 mm-expanded raw mask from patch 0064). If the clip is null (whole collection painted), `continue` skips the normal-flow append entirely. Otherwise `filtered_extrusions` points at the clipped base; the four downstream `extrusions` references (`layer_tools.extruder(...)`, `get_extruder_overrides(...)`, `point_inside_surface(...)`, `by_region.append(...)`) are rewritten to use `filtered_extrusions`. Painted geometry now emits exactly once at sub-Z; non-painted emits exactly once at base Z. **FullSpectrum Local-Z engine port is COMPLETE end-to-end.** Deferred: dependency-chain scheduler (FS 5826-6000, ~170 LoC topological mode — legacy covers default behavior). Next gate: Phase 6 hardware print on Snapmaker U1.

Each patch verified by incremental `cmake --build` (0 FAILED objects) + `./gradlew :app:assembleDebug` (full APK assembled). The build also fixed three pre-existing latent compile errors in `app/src/main/cpp/slic3r_jni.cpp` from commit 6942a12 (most-vexing-parse + namespace-qualified alias under NDK 29 Clang 19) — mechanical `static_cast<size_t>(n_t)` + bare `double` cast.

**LayerCycle SHIPPED 2026-05-17 (supersedes BOTH the 2026-05-11 "SHOULD work" claim AND the 2026-05-15 "Gap 3 = no standalone propagation fix / ~800-LoC emission port" verdict below — both wrong).** An instrumented re-test on a clean from-patches build (Galaxy XR) proved the bundled `FullSpectrumLayerCycleTest` was blocked **solely by Gap 1**: `Slic3r::Model::add_object`'s `extruder=1` stamp clobbered the project virtual `wall_filament` in `region_config_from_model_volume`, so `resolve()` never ran (Gap 2 was off-path — the wall *was* emplaced, `nonoverriddable=1`; Gap 3 was moot — `lt.extruders` was already single-tool pre-reorder). Shipped as two small config-propagation patches: **`patches/0072-fullspectrum-region-config-virtual-propagation.patch`** (when the parent/project config targets a virtual row and the object `extruder` stamp demoted it to a physical id, restore the parent virtual id — FS-desktop semantic; PeggyPalette-inert because its project wall is physical) + **`patches/0073-fullspectrum-reorder-cadence-preservation.patch`** (`ToolOrdering`'s `get_custom_seq` pins each layer's resolved `lt.extruders` cadence when `mixed_filament_definitions` is non-empty so the flush-min DP can't collapse the alternation). `FullSpectrumLayerCycleTest` un-`@Ignore`'d (real unpainted `wall_filament=<virtual>` UX + hardened ≥40-each / ≥80%-alternation assertions); LayerCycle + LocalZ + Roundtrip + PeggyPalette all GREEN on a clean 0001–0073 device build. The "~800-LoC emission port" estimate was wrong — the real blocker was ~75 LoC of config propagation. Everything from "LayerCycle status correction (2026-05-15…)" down is the historical probe trail; its "NO standalone propagation fix / 0072/0073 dropped" verdict is **void** (the shipped 0072/0073 ARE that standalone fix, re-derived after the empirical re-test; the earlier prototypes were dropped only because the *then* PeggyPalette gate flagged the conserved-purge non-bug `1b4ef8b` later neutralised). Pointillisme stays deferred (`#if 0`'d upstream).

**LayerCycle status correction (2026-05-15, supersedes the 2026-05-11 audit's "SHOULD already emit alternating T0/T1" claim — that claim is WRONG, proven by instrumented diagnosis on Pixel 10 Pro XL + Galaxy XR).** Unpainted LayerCycle is **three** stacked gaps; full evidence + probe trail in `docs/proposals/fullspectrum-layercycle-engine.md` §Status. Gap 1 = region-config propagation (`Slic3r::Model::add_object`'s unconditional `extruder=1` stamp is force-mapped onto `wall_filament` by `apply_to_print_region_config`, clobbering a project-level virtual `wall_filament`; AND the BBS `extruder` key is indistinguishable between the spurious auto-stamp and a deliberate per-object choice — so propagation canNOT be fixed in isolation). Gap 2 = FS-virtual-wall regions are wipe-tower `is_overriddable` (so `collect_extruders` never emplaces the resolved per-layer extruder). Gap 3 = the resolved per-layer extruder does not survive `reorder_filaments_for_minimum_flush_volume` (`ToolOrderUtils.cpp`, **zero** MixedFilament awareness) + `_make_wipe_tower` planning into the emission `ToolOrdering` — post-reorder `layer_tools.extruders` collapses to `[0]`/`[]`, `process_layer` emits zero per-layer toolchanges. **All three are the same FS v0.9.9 emission port (~800-LoC `GCode.cpp` + ~311-LoC `ToolOrdering` + the reorder DP); there is NO standalone propagation fix.** Candidate patches 0072/0073 were prototyped, verified at the resolver/override layer, then **dropped** (no standalone benefit; can't certify regression-free against an already-broken parity reference). The submodule is back to the verified pinned + 0001-0071 state. **PeggyPalette gate — GREEN (re-gated by `1b4ef8b`, do NOT bisect).** The earlier "+5.4 % T1 regression on main" claim is **resolved and stale**: `1b4ef8b` ("test(parity): gate PeggyPalette on model extrusion, not total filament-mm") re-baselined `PeggyPaletteFullSpectrumParityTest` onto the real invariant — per-tool **MODEL** extrusion within 2 % (wipe-tower / prime-tower purge excluded). The old +5.4 % was a *total* filament-mm delta that counted purge; OrcaXR's stock flush-minimiser legitimately purges less than the FS reference, so asserting total flagged a print-quality **win** as a regression. The re-gated test passes GREEN (device run SM-I610 Galaxy XR arm64-v8a, 2026-05-16, clean `tests="1" failures="0"`). Do NOT re-open the `afc6f7d..e8a7cad` bisect — there is no T1 regression to chase; the [[feedback_peggypalette_commit_gate]] precondition is satisfiable today. (Historical note: `afc6f7d` "gate clamp_filament_arrays on mixed_filament_definitions" + `e8a7cad` "strip painted facets when profile can't safely handle them" are the in-`main` fixes that preceded the re-gate.) The historical analysis below is retained for the Pointillisme / Local-Z context but its LayerCycle "SHOULD work" conclusion is void. — patches 0015 + 0017 + 0018 + 0019 + 0024 already provide every piece the per-layer alternating-extruder path needs — (1) `MixedFilament.cpp::resolve()` lines 1980-1988 implement the `((layer_index % cycle) + cycle) % cycle` LayerCycle algorithm directly; (2) `PrintApply.cpp::1361-1364` calls `m_mixed_filament_mgr.clear_custom_entries()` + `auto_generate()` + `load_custom_entries(serialized_defs, physical_filament_colors)` during config application; (3) `ToolOrdering.cpp::693-710` defines a `resolve_filament_for_layer` lambda that wraps `MixedFilamentManager::resolve(...)`; (4) `ToolOrdering.cpp::749 + 780 + 782 + 784` calls that lambda for `wall_filament` / `solid_infill_filament` / `sparse_infill_filament` / `extruder_override` per region, populating `layer_tools.extruders` with the resolved physical extruder; (5) `MultiMaterialSegmentation.cpp::2208-2213` already sizes `num_facets_states` via `MixedFilamentManager::total_filaments(num_physical)` so painted virtual-slot triangles flow into proper per-extruder regions; (6) `GCode.cpp` iterates `layer_tools.extruders` for emission. So a 2-physical + 1-virtual project authored via `mixed_filament_definitions=A,B,1,1,50,0,g,w,m0,z0,xa0,xb0,d0,o0,u1` with `wall_filament=3` (or painted facets with slot=3) SHOULD already emit alternating T0/T1 layers — no patches 0029-0033 needed for LayerCycle. **Pointillisme is `#if 0`'d upstream as of FS v0.9.9.** Audit 2026-05-11: `pointillism_sequence_for_row_for_gcode` in `src/libslic3r/GCode.cpp:3884-3951` is wrapped in `#if 0 ... #endif` and unconditionally returns `{}`. The downstream integration site (`GCode.cpp:5423-5462`) treats an empty sequence as "skip Pointillisme branch," so even with every other piece of the FS port (helpers `split_polyline_by_length_for_pointillism`, `trim_polyline_for_pointillism_gap`, `split_extrusion_collection_for_pointillism_paths`, `PointillismPathSplitStats`, the `k_pointillism_path_inset_marker` sentinel) in place, Pointillisme prints fall back to LayerCycle behavior. **Implication for OrcaXR:** we should NOT enable broken upstream code. Pointillisme is deferred until FS un-disables it (likely v0.9.10+ per the iteration trajectory in `ratdoux/OrcaSlicer-FullSpectrum` commit history). Mechanical prerequisite patches landed 2026-05-11: 0029 (`ExtrusionEntity.hpp` inset_idx propagation through ExtrusionMultiPath/Loop copy/move/assignment), 0030 (`PerimeterGenerator.cpp` populates inset_idx on emitted Loops/MultiPaths), 0031 (`VariableWidth.cpp` gap-fill loop dedup + closed-loop single-extrusion shortcut — a FS print-quality improvement unrelated to Pointillisme, ships standalone). **What's still required for Local-Z** (the second-most-impactful remaining mode): the engine-level sublayer planner in `PrintObjectSlice.cpp` (+3750 LoC — FS goes from 1641 to 5391 LoC, mostly Local-Z planner introducing `SubLayerPlan` struct + `LocalZWipeTowerToolchange` types), `Print.cpp`/`PrintObject.cpp`/`PrintApply.cpp` +636 LoC for planner lifecycle, `WipeTower2.cpp` +229 LoC for purge sequencing, `GCode.cpp` +818 LoC for Z-walk emission + infill base-layer override, `LayerRegion.cpp` +121 LoC adding `extruder(FlowRole)` method that `Fill/Fill.cpp` +11 LoC now calls. Local-Z is genuinely active in FS v0.9.9 (not `#if 0`'d), so this port would deliver working sub-layered painted-zone Z slicing. Verification is gated on a connected arm64-v8a Android device — `FullSpectrumLayerCycleTest` is now @Ignore-free and lives at `app/src/androidTest/.../FullSpectrumLayerCycleTest.kt`; running `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=dev.orcaxr.app.FullSpectrumLayerCycleTest` against a Galaxy XR (or the Snapmaker U1's Android-based control panel) is the hardware-side test that confirms or refutes this analysis. **What's still missing (engine emission)**: the FS port of `PrintObjectSlice.cpp` (+2414 LoC sublayer planner — single biggest patch), `GCode/ToolOrdering.cpp` callers of `resolve_mixed_1based` (+311 LoC; patch 0019 already wires four call sites — `wall_filament`, `sparse_infill_filament`, `solid_infill_filament`, generic `extruder()` — but the planner that populates `LayerTools::layer_index/print_z/layer_height_for_mixed` is missing), `GCode.cpp` (+818 LoC toolchange-aware emission, Local-Z Z-walk, infill base-layer override), `WipeTower2.cpp` (+229 LoC Local-Z purge), `Print.cpp`/`PrintObject.cpp`/`PrintApply.cpp` (combined +636 LoC for `MixedFilamentManager` lifecycle + `WipeTowerData::local_z_tool_changes` plumbing), and segmentation routing (`MultiMaterialSegmentation.cpp` +13, `LayerRegion.cpp` +121, `Layer.cpp` +49, `VariableWidth.cpp` +139, `TriangleSelector.cpp` +52, `PerimeterGenerator.cpp` +8, `Fill.cpp` +11). Until those patches land, the slicer ACCEPTS `mixed_filament_definitions` (loaded into the `MixedFilamentManager` and round-tripped via 3MF) but EMITS single-filament-per-slot G-code — no alternating layers, no XY pointillism stripes, no Local-Z sub-layering. Source-of-truth for the port is FS tag `v0.9.9` (`ratdoux/OrcaSlicer-FullSpectrum`, commit b3c41fda), accessed semantically not via `git apply` because the fork sits on Snapmaker/OrcaSlicer 2.3 while OrcaXR pins upstream OrcaSlicer-Org v2.3.2. Headless instrumented tests (`FullSpectrumLayerCycleTest`, `FullSpectrumPointillismeTest`, `FullSpectrumLocalZTest`, `FullSpectrumRoundtripTest`) are scaffolded under `app/src/androidTest/` with `@Ignore` annotations referencing this gotcha — remove them once the engine patches land. **Auto-overrides:** when at least one enabled `MixedFilamentEntry` exists, `MainActivity.fullSpectrumExtraOverrides()` sets `mixed_filament_advanced_dithering=1` + `dithering_step_painted_zones_only=1` on every slice call (parallel to `wipeTowerExtraOverrides`); the rest of the dithering knobs use libslic3r defaults from patch 0016 until a dedicated per-printer Settings card surfaces them.

21. **All multi-object 3MFs are decomposed into separate STLs on import.** To allow per-object selection and transform (Phase B9), generic multi-object 3MFs extract each `ModelObject::mesh()` to a temporary STL in `cacheDir/extracted/<hash>/`. Each `PlacedModel` points to one of these STLs, sharing a `groupId` (the source 3MF's hash). `originalSource` tracks the original 3MF container path so `nativeWriteColoredGlb` can re-load the per-triangle `paint_color` metadata during re-bakes. STL has no material metadata, so carry the source object's one-based default extruder in `PlacedModel.previewFilamentIndex` as a fallback. **`runSliceMulti` MUST re-route to `originalSource` and pass `groupOrdinal` in the `objectOrdinals` parameter for any PlacedModel that has an `originalSource`** — the JNI then clones `Model::objects[ordinal]` from the original 3MF, preserving every painted volume's `mmu_segmentation_facets` / `supported_facets` / `seam_facets`. Going through the per-object STL strips all of those (STL ⇒ no facet annotations), and the resulting slice prints single-color with no supports, no purge tower, and no seam control even when each object was authored multicolor. Symptom that triggered the patch: 4 painted unicorns plated together yielded `postprocess_remap_tool_commands: 10 rewrites across 1.6M lines` — i.e. effectively no toolchanges. Pre-fix code path (`m.source` for everything) is the trap; the fix sends `(originalSource ?: source, groupOrdinal)` per input.

21b. **`nativeSliceMulti` MUST capture the source `ModelInstance`'s scale + rotation BEFORE `clear_instances()`** and compose them with the user's per-input transform. BBS / Bambu 3MFs encode per-instance scale + rotation in their `<build><item transform=...>` matrix — the knitted-unicorn 3MF authors `transform="1.5697 0 0 0 0 1.5697 0 -1.5697 0 ..."` (a 1.5697× uniform scale plus -90° X rotation that stands a Y-up authored mesh up onto the printer's Z-up bed). Discarding those by replacing the cloned object's instances drops the print to its raw mesh extents — symptom is the unicorn arriving at ~63 % of the desktop slicer's size (27 mm tall instead of the authored 40 mm) and the toolpath looking visually blob-y / squat. Compose: `final_scale = user_scale * src_scale`, `final_rotation = user_rotation + src_rotation` (Eulers — works for the X+Z-only axes the typical UI exposes), `final_offset = user_offset` (replace; the user's plate placement was authored against the scaled extents shown in Prepare). `nativeSlice` (single-model path) escapes this trap by leaving `mo->instances` alone entirely.

22. **`SlicerEngine.PROJECT_OVERRIDE_KEYS` MUST NOT include `layer_height` / `initial_layer_print_height` / `first_layer_height`.** `mergedConfig`'s precedence ladder applies `projectOverrides` (= the 3MF-authored process tunings extracted by `read3mfProjectOverrides`) ABOVE the active profile's config — so if a 3MF authored `layer_height=0.20` and the user then picks `0.12 Fine @Snapmaker U1 (0.4 nozzle)` from the profile picker, the 3MF override silently wins and the slice comes out at 0.20 mm. Symptom: the user reported "estimated time 5 h 07 m vs desktop's 11 h 20 m" on the same model (200 layers vs 332). There's no in-XR way to see the 3MF was overriding the picker, so "I picked 0.12 → I get 0.12" is the only mental model that makes the picker mean anything. Layer-height keys flow exclusively from the user's profile pick + the layer-height-override TextField; other 3MF authored process keys (`sparse_infill_density`, `seam_position`, `support_*`, `wall_loops`, etc.) keep their `read3mfProjectOverrides` flow because those don't have a dedicated picker.

22. **Loading a 3MF fires *two* `previewStl` calls — published preview GLBs cannot be deleted during an active model lifetime.** `LE_2162` fires on the selection change for the new model (call A); inside that bake, the embedded-color sync writes to `filamentEntriesStore`, which propagates to `previewPalette`, which fires the palette `LaunchedEffect` and runs a second bake (call B). There are two asynchronous consumers of the generated file path: JNI may still be writing a newer GLB, and `SpatialGltfModel` may not open an already-published older GLB until after the next bake finishes. Deleting either version during the active model lifetime causes `FileNotFoundException` and can tear down the live XR scene. `sweepOldPreviews` therefore retains every published version while the model exists and only deletes that model's preview files when the model is explicitly removed.

23. **`ModelObject::raw_bounding_box()` already includes the instance's rotation+scale (via `get_matrix_no_offset()`).** Pairing it with `world_bbox_of(b, instance->get_matrix())` re-applies rotation+scale and inflates the result. Symptoms when this happens to the per-object `world_bbox` used to compute the GLB grounding shift: the model floats above the bed (12+ mm of phantom Z), and the over-large derived AABB also propagates into `oz` for downstream `translateZmm`. Always pair `world_bbox_of(...)` with `mo->raw_mesh_bounding_box()` (per-volume transforms only, no instance xform) so the full instance matrix can be applied exactly once. The header for `world_bbox_of` in `slic3r_jni.cpp` carries the same warning — don't backslide.

24. **`previewStl` bakes one PER-OBJECT GLB per `PlacedModel` for multi-object 3MFs (gotcha #21), but `deriveStlFor(bakeSource)` returns the FULL 3MF derived STL.** Using its bbox to set `baseBboxX/Y/Z` on each per-object PlacedModel (`bakeIndex >= 0`) gives every object the *whole-3MF layout footprint* (e.g. 134×108 for a 5-unicorn print), which the selection bbox / gizmo / `footprintMm()` then read as if each unicorn were a 134×108 monster. Skip the `baseBbox` override when `bakeIndex >= 0`; per-object dims set by `nativeRead3mfObjectMetadata` at load time are accurate.

25. **G-code thumbnails are rendered headless via a software rasterizer in `app/src/main/cpp/thumbnail_render.cpp`, NOT via libslic3r's GUI offscreen-GL path.** OrcaXR has no GL context inside the JNI shim and we don't want to set one up just for thumbnails. Instead, `nativeSlice` / `nativeSliceMulti` install a `ThumbnailsGeneratorCallback` that runs an in-process triangle rasterizer over the loaded `Slic3r::Model` and returns RGBA pixels for libslic3r to PNG-compress and embed. Three load-bearing pieces have to all be there for `; thumbnail begin` blocks to actually appear in the gcode: (a) the active machine profile authors `thumbnails` (e.g. Snapmaker U1's `"48x48/PNG, 300x300/PNG"`); (b) `OrcaProfileLoader.SAFE_KEYS` whitelists `thumbnails` and `thumbnails_format` so the key doesn't get silently dropped; (c) `make_thumbnail_callback(model, cfg)` is the third arg to `print.export_gcode(...)` — passing `nullptr` (the pre-A8 default) skips thumbnail emission silently. The rasterizer reads `filament_colour` out of `cfg` so multi-color models render with their per-extruder palette; missing/unparseable entries fall back to neutral gray.

26. **Vendor profile leaves under `app/src/main/assets/profiles/<Vendor>/` come from each vendor's downstream OrcaSlicer fork, NOT upstream OrcaSlicer.** Sources:
- **Snapmaker** (`profiles/Snapmaker/`): https://github.com/Snapmaker/OrcaSlicer pinned to **v2.3.1**.
- **Elegoo** (`profiles/Elegoo/`): https://github.com/ELEGOO-3D/ElegooSlicer pinned to **release/v1.5.0**. The ECC machine bundle (Elegoo Centauri Carbon, four nozzle variants) lives upstream under `resources/profiles/Elegoo/{machine,filament,process}/{ECC,BASE,ELEGOO_02_NOZZLE,Generic,fdm_*}`. `host_type=elegoolink` is a sentinel — libslic3r doesn't recognize the value and silently drops it on deserialize, but the Kotlin-side PrinterRepository can read it directly from the JSON to dispatch a Centauri-aware Moonraker driver when one ships. Two upstream keys (`auto_toolchange_command`, `bed_texture_area`) are kept in the JSON for diff-friendliness with future upstream releases but aren't whitelisted in `OrcaProfileLoader.SAFE_KEYS` because libslic3r doesn't define them. The CC-current-firmware change_filament_gcode uses Elegoo's CCB protocol with `M6211` — **not** a CC2-only macro, current CC firmware also expects it. CC2 (Elegoo Centauri Carbon 2, IDEX) is **not** vendored — adding it requires the closed-source ElegooLink cloud SDK (Agora RTC + Paho MQTT) plus a `M6211` parsing patch in `GCodeProcessor.cpp`; defer until a CC2 device is on hand.

**Snapmaker fork v2.3.1 sync history (A9):** Process and machine leaves were already byte-identical to fork v2.3.1. The filament leaves had drifted in a few load-bearing places that affect the U1 print-time estimate (Phase 1 of A9): `Snapmaker PLA Matte @U1.json` had `filament_max_volumetric_speed=20` (fork: 22), `enable_pressure_advance=1` (fork: 0), `nozzle_temperature=215`/220 (fork: 215), `hot_plate_temp=55` (fork: 65); `fdm_filament_pla.json` had `temperature_vitrification=154` (fork: 65 — orcaxr's value was outright wrong for PLA, whose Tg is ~60°C), `nozzle_temperature=210` (fork: 215), `filament_retraction_length=1.2` (fork: 2). When re-vendoring an additional Snapmaker leaf, diff against `git show v2.3.1:resources/profiles/Snapmaker/<path>` in a Snapmaker/OrcaSlicer checkout, NOT against upstream OrcaSlicer's bundled Snapmaker profiles — those carry Bambu-leaning defaults that produce different slice timing. The instrumented `unicornEstimateMatchesDesktopWithinFivePercent` test pins the SHAPE (332 layers, 385 toolchanges) AND the time estimate (within ±5 % of 11h 20m) against the user's reference Einhorn slice; a regression in either surfaces there. Note that some Snapmaker-fork-only keys (`filament_retract_length_toolchange`, `graphic_effect_plate_temp`, `is_custom_defined`) aren't in upstream PrintConfig and stay unsynced — Phase 2 of A9 (engine-behavior parity) is where those land. **A9 Phase 2 finding (2026-05-02):** the Phase 1 sync target (fork v2.3.1 raw bundled defaults) was wrong for the U1 print-quality test. The user's reference desktop gcode at `~/Downloads/Einhorn Knitted_PLA_11h20m_orca.gcode` was sliced with CUSTOMIZED values that drift from fork raw defaults — `filament_max_volumetric_speed=20` (fork:22), `filament_flow_ratio=0.966` (fork:1), `nozzle_temperature=220` (fork:215). Two of the three Phase 1 changes moved OrcaXR FURTHER from the desktop reference, not closer. **When syncing for the time-estimate test, diff against the user's reference gcode CONFIG_BLOCK** (lines `; CONFIG_BLOCK_START` … `; CONFIG_BLOCK_END` near the file's end), NOT against fork raw defaults. The drift-detector script lives at `/tmp/profile_drift.py` for ad-hoc reuse: it loads the gcode header, walks OrcaXR's profile inheritance chain, and prints every key where the resolved profile value differs from the gcode CONFIG_BLOCK value. The structural fix (extending `SlicerEngine.PROJECT_OVERRIDE_KEYS` from 11 → 56 keys so 3MF-embedded `project_settings.config` overrides can flow through) ships separately — see [`docs/A9_PHASE2_AUDIT.md`](docs/A9_PHASE2_AUDIT.md) §7. **A9 Phase 2 closing finding (2026-05-02):** the residual 22.7 % gap (after enable_support=1 closes the first 10 %) is **upstream's planner refactor between v2.3.1 → v2.3.2 in `GCode/GCodeProcessor.cpp::TimeMachine::calculate_time`** — pass order swapped from forward-then-reverse to the Marlin-canonical reverse-then-forward, `planner_reverse_pass_kernel` rewritten with cascade-on-`next.flags.recalculate`, and `recalculate_trapezoids` mutation switched from copy-back-only-`trapezoid` to in-place `feedrate_profile.exit` propagation. Upstream's planner produces systematically lower (more optimistic) time estimates for the same emitted G-code, especially in late layers where short ramp-dominated blocks are sensitive to pass-order convergence. The §6 audit's claim that `GCodeProcessor.cpp` is "byte-identical" was wrong (file gained 41 KB / 19 % between v2.3.1 and v2.3.2). The right call is to ACCEPT this divergence — Klipper hardware realizes the more aggressive cruise velocities upstream's planner predicts; reverting would intentionally regress the time estimator. `UnicornFineProfileTest.unicornEstimateMatchesDesktopWithinFivePercent` stays `@Ignore`d permanently as a "did the gap widen further?" regression guard; A9 Phase 2 is closed. See [`docs/A9_PHASE2_AUDIT.md`](docs/A9_PHASE2_AUDIT.md) §9 for the source citations.

28. **Embossing / SVG / text-on-object (D4) reuses libslic3r `Emboss` + `NSVGUtils` — do NOT roll a custom glyph-to-mesh path.** D4's natural-looking instinct is to write a FreeType outline walker in the JNI shim and triangulate by hand; libslic3r already ships every step we need (and they're already linked into `liblibslic3r.a`): `Emboss::create_font_file(const char*)` for stb_truetype loading, `Emboss::text2shapes(FontFileWithCache&, const char*, FontProp)` for glyph-soup → ExPolygons (with healing pass), `to_polygons(NSVGimage&, NSVGLineParams)` for SVG path → polygons, `union_ex(Polygons)` for hole resolution, and `Emboss::polygons2model(ExPolygons, IProjection)` + `ProjectScale(make_unique<ProjectZ>(depth/scale), scale)` for the extrude. The shape→mm scale for text is `Emboss::get_text_shape_scale(fp, *font_file)`; for SVG it's the libslic3r global `SCALING_FACTOR`. **Three non-obvious things the implementation has to honor**: (a) `MeshBoolean::mcut::make_boolean(host, emboss, results, "UNION" | "A_NOT_B")` is the right boolean for emboss/engrave, NOT `MeshBoolean::cgal::plus/minus` — gotcha #27 still applies (`triangle_mesh_to_cgal` throws "Mesh not watertight" on the freshly-extruded emboss block, which has open bottom faces along the glyph perimeter where polygons2model joins front+back fans). mcut's tolerant boolean handles the imperfect emboss surface; CGAL doesn't. (b) The text/SVG mesh built by `polygons2model` is in printer-mm coords with Z = 0..depthMm, but its XY origin is wherever `text2shapes`/`to_polygons` happened to lay glyphs out (often shifted relative to the user's mental model of "centered text"). The JNI shim re-translates the mesh post-extrusion so bbox-center sits on (0,0) — without that, `EmbossOp.transformForTopOfBbox` puts the text in the wrong spot on the host. (c) Same paint-state sweep as gotcha #27 applies on `PlacedModel.source` swap: drop `paintFilamentIndex`/`supportFlags`/`seamFlags`/`fuzzySkinFlags`/`brimEars`/`volumes`/`originalSource`/`groupId`/`groupOrdinal` because the boolean re-meshes the host. See `nativeBuildTextMesh` / `nativeBuildSvgMesh` / `nativeApplyEmboss` in `slic3r_jni.cpp`, `EmbossOp.kt`, `EmbossAssets.kt`, and `MainActivity::runEmboss`. Bundled fonts ship in `app/src/main/assets/fonts/` (DejaVu Sans Bold + DejaVu Serif); a sample SVG ships in `app/src/main/assets/svg/heart.svg`.

27. **Mesh repair / "Fix Model" composes already-exported libslic3r symbols — do NOT add a new `MeshBoolean::cgal::repair()` inside the v2.3.2 submodule.** A5's natural-looking instinct is to write a CGAL-PMP-based repair function in `MeshBoolean.cpp` (the upstream-style approach: `repair_polygon_soup` → `orient_polygon_soup` → `corefine_and_compute_union(self, self)`). That triggers a multi-hour libslic3r rebuild on every dev machine for zero functional gain, because libslic3r already exports the moving parts: `MeshBoolean::self_union(TriangleMesh&)` is exactly that pipeline (igl→CGAL `mesh_boolean(union, A, ∅)`), and the ADMesh family (`its_merge_vertices`, `its_remove_degenerate_faces`, `its_compactify_vertices`, `its_num_open_edges`, `MeshBoolean::cgal::does_self_intersect`) handles everything ADMesh-class. Compose them from the JNI shim. **Two non-obvious things the implementation has to honor**: (a) `MeshBoolean::self_union(TriangleMesh)` (igl path) ACCEPTS polygon soup, but `MeshBoolean::cgal::triangle_mesh_to_cgal(mesh, surface_mesh)` (used by `MeshBoolean::cgal::plus/minus/intersect`) throws `Slic3r::RuntimeError("Mesh not watertight")` when `CGAL::is_closed(out)` is false — for repair we want the igl flavor. (b) The Kotlin caller MUST drop `paintFilamentIndex`/`supportFlags`/`seamFlags`/`fuzzySkinFlags`/`brimEars`/`volumes`/`originalSource`/`groupId`/`groupOrdinal` when replacing `PlacedModel.source` with the repaired output — those are per-original-triangle indices and won't survive a CGAL re-mesh (44 tris from the test fixture's 24-tri input means the index space is gone). Skipping that sweep is the trap that produces a repaired mesh with paint bleeding into the wrong faces. See `nativeRepairModel` and `MainActivity::runRepair`.

29. **NDK ≥ 26 / Clang ≥ 17 is mandatory for libslic3r builds — older toolchains miscompile paint segmentation.** `app/build.gradle.kts:46` pins `ndkVersion = "29.0.14206865"` (Clang 19) for the in-tree JNI shim, and `scripts/build_native.sh` now refuses to build libslic3r against an NDK whose `clang --version` is below 17. The pin exists because **u1-slicer-for-android's B62 incident** showed NDK 25 / Clang 14 silently miscompiles SEMM (multi-color paint segmentation) — the generated G-code looks plausible but multi-color boundaries are degraded in printed output. OrcaXR's AI-paint pillar (C9) and the painted-extruder pipeline (gotcha #21) depend on this code path, so a regression here is invisible to slice-time tests but visible on the printer. **Do not** lower `ndkVersion` to satisfy a faster CI build. Verify a shipped `.so` with `llvm-readelf -p .comment app/build/intermediates/cxx/Debug/*/obj/arm64-v8a/libslic3r_jni.so` — the `.comment` section must report `clang version 17` or higher. Roadmap E9 records the rationale; the pin is intentionally redundant (gradle pin + bash assert + this gotcha) so removing any one layer fails loudly.

32. **`scripts/build_native.sh` defaults to "desktop-friendly" scheduling; don't regress this to max-throughput defaults.** Native C++ builds can run for 1–2+ hours and otherwise starve the host. The script now has three load-shedding layers by default: (a) compile jobs default to `ORCAXR_JOBS=max(1,nproc-3)`, (b) build subprocesses run under `nice -n 10` and `ionice -c3` when available (`ORCAXR_BG_BUILD=1`), and (c) users can cap Ninja's load average with `ORCAXR_LOAD_LIMIT=<n>` which forwards `-l <n>` via `cmake --build ... --`. For CI / headless boxes this can be disabled (`ORCAXR_BG_BUILD=0`, higher `ORCAXR_JOBS`), but keep the default conservative for interactive developer machines.

31. **Persisted secrets ride a Keystore-backed AES-256-GCM box; legacy plaintext values migrate on first write.** Audit H3 (2026-05-07) flagged the Anthropic API key as plaintext in DataStore — a stolen device or filesystem dump compromised it instantly. Fix: `dev.orcaxr.app.mcp.SecretBox` (AES/GCM/NoPadding, key alias `orcaxr_secret_v1` in `AndroidKeyStore`, key never extractable). On-disk format is `base64(IV || ciphertext+tag)`. Migration is silent and one-shot: `decrypt(value)` returns `null` for non-format inputs, so legacy plaintext values keep reading correctly until the next `setAnthropicApiKey` rewrites them encrypted. Threat model uplift: an attacker who copies the DataStore file off a rooted device can no longer read the key without also extracting the Keystore-bound AES key (TEE/StrongBox). The MCP bearer token is **not** encrypted — it's generated on-device and is functionally a capability rather than an account credential, so its loss is contained to "regenerate the bearer." If you add another at-rest secret (OAuth refresh token, MoonrakerAlt API key, etc.), route it through the same SecretBox; don't add a second cipher path. Don't log decrypted values — the `anthropicApiKey` Flow is the read seam and must never reach logcat.

30. **Instrumented (`androidTest`) tests run under Android Test Orchestrator, one process per test method.** `app/build.gradle.kts` declares `testInstrumentationRunnerArguments["clearPackageData"] = "true"` and `execution = "ANDROIDX_TEST_ORCHESTRATOR"` plus the `androidTestUtil("androidx.test:orchestrator")` artifact. Without orchestration, libslic3r's `Print` / `Model` / `Layer` C++ allocations leak from one test method into the next (the JNI shim doesn't reset state at method boundaries — it's a per-process lifecycle), and after 3-5 slicing tests the test process OOMs at the typical 256 MB Android cap. Roadmap E10 records the fix. Symptom that pins this: `RepairModelTest` passes alone, then `SliceMultiInstrumentedTest` immediately after dies with `std::bad_alloc` from inside `parallel_for` even though it succeeds in isolation. Don't disable Orchestrator to "speed up CI" — the per-test process model is load-bearing.

1. **Pre-Bundle Requirement:** Before building a bundle for the Play Store, you MUST:
    - Run `./gradlew versionCatalogUpdate` to check for library updates. If any updates are found, notify the user, commit the changes to `gradle/libs.versions.toml`, and advise the user to perform regression testing before final bundle generation.
    - Increment the `versionCode` in `app/build.gradle.kts`. Use the format `YYYYMMDDNN` (e.g., `2026051801` for the first build on May 18, 2026). Verify with the user if they've already uploaded a build for that day to avoid collisions.

2. **Dependency Update Review:** `./gradlew versionCatalogUpdate` updates `gradle/libs.versions.toml`. Always review `git diff gradle/libs.versions.toml` before committing — XR / Compose / Media3 patch bumps occasionally break the build.

## Web → local services: Chrome Local Network Access + CORS

`web/src/printer/` is the single Moonraker boundary: explicit endpoint normalization without scheme/port probing, typed HTTP/WebSocket handshake/state/capabilities, cancellation/timeouts, stale-event rejection, reconnect/heartbeat, and bounded redacted diagnostics. `main.ts` uses it through `ActionRegistry` for live connection tests and read-only filament-slot inspection; sparse physical slot IDs are preserved and never auto-applied to project mappings. Only endpoint/port persist, legacy stored API keys are purged, and credentials stay per-instance memory only. Legacy printer clients are retired. Printer mutation is now live behind an explicit two-button confirmation (`web/src/ui/dom/PrintSubmissionDialog.ts`): `PrintJobSubmission.ts` checks readiness, `PrintToolMapping.ts` compares the artifact's own tool changes with the printer's reported slots (a tool with no loaded filament blocks starting), the filename is sanitized and made unique unless replacement is opted into, and the stored size is verified before any start. Storing a file and starting a print are separate decisions: a busy or not-ready machine still accepts an upload but refuses a start. `PrintJobStatus.ts` then keeps a live snapshot (seeded by one query, updated by `notify_status_update` pushes) that drives the inspector's job panel, and `PrintJobControl.ts` derives pause/resume/cancel/emergency-stop availability from that snapshot — never from what this client last did — re-reads the machine before sending, and refuses when the printer has moved on to a different file. Queue reorder/remove, storage browsing, history, and hardware qualification remain. Web AI keys are likewise tab-memory only; `AiSessionSecrets` purges legacy `orca_gemini_key`/`orca_openai_key` plaintext storage instead of migrating it. External-slicer URLs may persist, but routing activates only after a successful probe backed by explicit opt-in; failed replacement, disable, or clear fail closed to local slicing.

The hosted app is HTTPS (`https://orcaxr.martinez.fyi/slicer/`), while
Moonraker and the optional external slicer commonly expose HTTP on the LAN.
Chrome 142+ can relax mixed-content blocking after the user grants Local
Network Access. `web/src/net/LocalNetworkAccess.ts` is the shared seam: API,
upload, probe, external-slicer polling, and fetched webcam snapshots must use
`fetchLocalNetwork`. IP literals, localhost, IPv6, and `.local` stay under the
browser's complete address-space table; HTTP hostnames outside those syntactic
categories receive an explicit `targetAddressSpace: local`. That declaration
is needed for custom LAN DNS, while avoiding a wrong declaration for literal
addresses that Chrome classifies itself. Older browsers ignore the option and
retain normal mixed-content blocking.

The GitHub Pages cross-origin-isolation shim must not own cross-origin fetches:
`web/public/coi-serviceworker.js` returns without `respondWith` for all of
them so the page origin can obtain/use Local Network Access permission for HTTP
or HTTPS targets. Do not restore a hand-written subnet allowlist; Chrome's
classification includes details that application code should not duplicate.
For same-origin requests it precaches the deploy app shell and bundled XR icons,
uses NetworkFirst at runtime, keeps the large slicer artifacts in a separate
four-entry cache, supplies the offline navigation fallback, and restores COOP/
COEP headers. Update its cache version and offline contract whenever deploy
assets or worker/schema compatibility changes.

LNA does **not** bypass CORS. Moonraker's `cors_domains` must include the
page's exact origin (the hosted app uses `https://orcaxr.martinez.fyi`);
API-key/custom-header requests preflight. The typed boundary requires one
explicit endpoint and never probes alternative schemes or ports. Direct
HTTP exposes status, credentials, webcam frames, and uploaded G-code, so use it
only on trusted LANs. Tailscale Serve or another trusted HTTPS reverse proxy
remains the cross-browser and remote-network fallback.

## External slicer server (`server/`)

Dockerized HTTP endpoint (`POST /slice`, STL or signature-validated project 3MF plus flattened-overrides JSON) the
web app can offload plain slices to. `POST /slice?async=1` returns
`202 {job}` for progress polling (`GET /jobs/:id` →
`{status, percent, message}`, then `GET /jobs/:id/gcode`); without the flag
the original synchronous contract is preserved, and a new client against an
old server degrades gracefully (old server ignores the flag and answers
`200` + G-code, which the client detects by status code). CLI progress
comes from orca-slicer's `--pipe <fifo>` option — newline-delimited JSON
with `total_percent`/`message`; the fifo read end must exist before the CLI
opens the write end (`O_WRONLY|O_NONBLOCK` fails with ENXIO otherwise and
the CLI slices on silently after a few retries). Two engines, chosen by
`SLICER_ENGINE`:

- **`cli` (default)** — Snapmaker OrcaSlicer **built from source** in the
  Dockerfile (stage 1; `ARG ORCA_VERSION=2.3.4` — bump deliberately, never
  track "latest") with `server/patches/` applied: 0001 guards the headless
  null-preset segfault in `expand_plate_extruders` (the released 2.3.3/2.3.4
  AppImages crash on every multi-filament project-3MF `--slice`), 0002 fixes
  the `normalize_fdm` wipe_tower_filament null-deref (see below). Stage-1
  apt needs `libwebkit2gtk-4.1-dev` or wxWidgets configures without webview
  and the slicer link fails. Native 64-bit, real TBB threads, runs under
  `xvfb-run`. Snapmaker Orca ≥ 2.3.3 is FullSpectrum-native, so FS keys
  pass through (the old FS_KEY_RE dropping is gone).
- **`wasm`** — the browser's libslic3r build (now the SAME Snapmaker-fork
  source) in a Node child process; parity/debug fallback.
- **Project 3MF slicing**: `/slice` sniffs the upload's ZIP magic — a 3MF
  slices as a PROJECT (embedded config incl. FullSpectrum mixed-filament
  definitions; no generated preset files), an STL gets the flattened
  profile split into typed preset files as before. This is how web FS
  slices offload: `SlicerClient.sliceProject` posts the original 3MF.

The server defaults to loopback. Any non-loopback `HOST` fails startup unless
`ORCAXR_SERVER_TOKEN` contains at least 32 bytes and
`ORCAXR_ALLOWED_ORIGINS` contains exact HTTP(S) origins; wildcard CORS is
forbidden. Upload/JSON/ZIP/output/rate/queue/job/time limits are configurable,
child process trees are cancelled and reaped, completed jobs expire, and logs
record only bounded error class/code—not engine messages that may contain paths
or secrets. Keep the abuse tests green when adding an endpoint or runner.

CLI invocation gotchas (all found empirically against Snapmaker Orca 2.3.4,
logic verified against `src/OrcaSlicer.cpp` in the submodule):

- `--load-settings` **rejects** `from: project` and a single merged file. It
  wants typed files: machine + process via `--load-settings a.json;b.json`,
  filament via `--load-filaments`. `server.js` splits the client's flat
  config using key sets extracted from `Preset.cpp` into
  `server/preset_key_types.json` (machine = printer + machine-limits +
  extruder options; filament list; everything else → process). Mis-binned
  keys are harmless — the CLI loads with substitution rule `Enable`.
- The compatibility gate compares process/filament `compatible_printers`
  against the machine's **system name**, which for a `from: user` machine is
  its (empty) `inherits` — nothing matches and it exits `-17`. Fix: machine
  is declared `from: system` (its own name becomes the system name) and the
  generated process/filament files list it in `compatible_printers`.
- `wipe_tower_filament` (ANY value) **segfaulted** the 2.3.4 CLI config
  loader — root-caused 2026-07-05: `DynamicPrintConfig::normalize_fdm`
  dereferences `opt("nozzle_diameter")->size()` unguarded whenever
  wipe_tower_filament is present, and the CLI normalizes each settings
  file alone (process key, machine vector absent → null deref). Fixed at
  the source by `server/patches/0002-normalize-fdm-partial-config-null-
  nozzle.patch` (+ same fix in the wasm fork tree); `CLI_CRASH_KEYS` is
  now empty. If a future profile key crashes the CLI, bisect keys with a
  probe loop against the container.
- `--arrange 0 --orient 0` is load-bearing: the client bakes transforms into
  printer coordinates before upload; arranging would move the parts.

## Related docs

- [`docs/parity.md`](docs/parity.md) — canonical implementation and evidence
  plan, including the XRBlocks UI foundation and qualification gates in P10.
- [`DESIGN.md`](DESIGN.md) — XR UX spec and baselines.
- [`patches/README.md`](patches/README.md) — rules for patches against the OrcaSlicer submodule.

## Web UI UX gotchas

- **XR tool rail must stay finite.** The left XR card is a compact spatial
  surface, not a scrollable mirror of the desktop toolbar: render only the
  modal tools plus Drop to bed and Delete (64 px tiles); the complete
  action catalogue stays in the progressive top menu. A previous all-toolbar
  rail overflowed to the floor and made the compositor spend frame time laying
  out off-screen buttons. Hidden cards are not automatically free; avoid
  rebuilding them and use the measured single-owner lifecycle in the XRBlocks
  contract above rather than a manual `UICard.update` loop.

- **Layer events must be projected into `Metadata/custom_gcode_per_layer.xml` or they never reach the slicer.** `state.customGcode` entries with a `layerEvent` are written by `bbsCore.ts` with the engine's own numeric `type` codes (`ColorChange`=0, `PausePrint`=1, `ToolChange`=2, `Template`=3, `Custom`=4) plus the legacy `gcode` attribute pre-2.3 readers key off, and read back on import. Store the event's `top_z`, never a layer index — the engine resolves the height against the layers it produced, and a layer-height change would otherwise silently move the event. Verified behaviour on the U1 profile: pause emits `;PAUSE_PRINT` + `machine_pause_gcode`, custom emits its own body, colour change needs `color_change_gcode` (absent ⇒ an empty `;CUSTOM_GCODE` marker, so the UI only offers kinds whose body the profile declares), and a `ToolChange` event is a MultiAsSingle-mode concept that a multi-extruder project ignores.
- **BBS `project_settings.config` is string-valued, and its filament options are vectors — both are load-bearing.** `ConfigBase::load_from_json` accepts strings and arrays of strings only: one numeric element (we used to write `nozzle_diameter` as numbers) makes the engine drop that option entirely and fall back to its default. Worse, `num_extruders` comes from `filament_diameter.size()`, and `region_config_from_model_volume` clamps every per-object `extruder` above that count back to 1 — so a scalar `filament_diameter` turns a correctly assigned multicolor plate into a silent single-tool print with no error anywhere. `web/src/project/serialization/bbsCore.ts` therefore stringifies every value and expands every key in `FILAMENT_VECTOR_KEYS` (ported from the pinned `Preset::filament_options()`) to one entry per physical filament. Symptom to recognize: the saved 3MF has `extruder=2` on the object, the slice succeeds, and the G-code contains only `T0`.
- **Unnamed tool slots inherit the chosen filament.** `PresetGraph.resolveSelection` fills a slot the request never named from slot 0 unless the printer declares a per-slot `default_filament_profile`. Without that, a four-tool U1 came up as PLA + three Generic ABS, and the first two-colour slice failed on the engine's "large difference of temperature" check before any of the multicolor path ran.
- **The Emscripten build emits the full `CONFIG_BLOCK` again.** The old `#ifdef __EMSCRIPTEN__` skip of `append_full_config` predated `fixup_enum_keys_map()`; with it in place the dump is safe, and without it web artifacts carried no `filament_colour`/`filament_type`, which the send-time mapping and G-code re-import both need. Rebuild path: edit the fork tree, `ninja -C third_party/SnapmakerOrca/build-wasm libslic3r`, `wasm/build_wasm_module_snapmaker.sh`, copy `wasm/dist/*` to `web/public/slicer/`, refresh `wasm/artifact-provenance.json`, then regenerate `wasm/patches/snapmaker-fork-wasm-port.diff` with `git -C third_party/SnapmakerOrca diff`.
- **Multi-extruder filament selectors:** When the selected printer profile has multiple extruders (e.g., Snapmaker U1), the UI generates individual filament dropdowns for each extruder head (H-1, H-2, etc.). The global `sel-filament` dropdown MUST be hidden in this state (`display: 'none'`) to avoid redundancy and user confusion. Do not reintroduce a visible global filament dropdown alongside the per-head dropdowns.
- **The web profile corpus is a verified pinned overlay, not an editable copy.** `npm --prefix web run profiles:verify` requires `third_party/SnapmakerOrca` HEAD `9fd12ffb2b1b80c9fb4c14564754d2ec1573a626`, proves every same-path Snapmaker/Elegoo profile byte-identical to that Git tree, checks the imported inheritance closure, SHA-256-locks OrcaXR-only target adaptations in `web/scripts/profile-overlays.lock.json`, and verifies deterministic `catalog.json` ordering. Use `profiles:sync` deliberately after reviewing source/profile changes; never hand-edit a mirrored leaf or describe the local Elegoo adaptations as upstream-pinned. The calibration catalog is likewise generated from exact pinned Git blobs: use `calibration:verify` in normal gates and `calibration:sync` only after reviewing upstream source/resource or local-binding changes; never hand-edit its generated JSON.
21. **`normalize_fdm()` crashes with a null-deref when traversing the component graph if no options are set.** Patch `0076-normalize-fdm-null-deref.patch` fixes this for the server backend.

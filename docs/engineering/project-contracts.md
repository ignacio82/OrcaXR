# Canonical project and parity contracts

Maintained technical context from [GEMINI.md](../../GEMINI.md). Read this
when changing the corresponding area; update it in the same commit as behavior.
Code paths below are relative to the repository root. Historical measurements
are fixture-specific evidence, not device-independent performance guarantees.

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
  after drift; printer mutations pass the owned session and submission guards. Auto-place wipe tower
  plans Chebyshev clearance across 8 bed candidates and commits `SetPlateWipeTowerCommand`
  to the active plate without undefined properties in canonical JSON. **It reserves the
  tower's printed footprint against the printable rectangle, never its body against a
  bed size.** Two facts make that the whole job: a printable area has an *origin* as well
  as an extent (the U1's is `0.5x1 … 270.5x271`, and `bedSizeFromProfile` returns its far
  corner, which is not a size), and the engine prints well outside `prime_tower_width` —
  `prime_tower_brim_width` on every side, plus, when `wipe_tower_wall_type` is `rib`,
  the diagonals `generate_rib_polygon` unions across the body. Reserving only the body
  against a bed rooted at (0,0) put a 30 mm tower at `wipe_tower_x = 1` and extruded its
  first layer down to x = −8.8 mm, 9.3 mm off the front-left corner.
  `wipeTowerFootprintMarginMm` is an upper bound on that overhang derived from the same
  config keys the engine reads, deliberately not a second copy of `generate_rib_polygon`:
  a bound cannot drift out of step with the engine, and over-reserving only moves the
  tower a few millimetres inboard. `wipe_tower_x/y` still addresses the **body** corner,
  because that is what the engine reads. The ghost draws the tower where the engine will
  actually print it and outlines that footprint — it used to clamp itself onto the bed,
  so an overhanging tower looked seated and the defect only surfaced on the first layer.
  `wipe-tower-outside-build-volume` checks that same footprint: it used to test the
  origin *point*, which is on the bed in exactly the case that goes wrong, so the one
  gate that should have refused the print stayed silent. All three — planner, ghost,
  preflight — read `wipeTowerFootprintMarginMm`, so a placement one accepts is a
  placement the others accept. Mixed recipes use stable physical-head IDs, never virtual rows; live Match uses a bounded worker, while auto-pair generation defaults off and requires count-bound confirmation above four physical filaments. Refined facet selection uses the version-2 subdivided-facet and child-path encoding: source vertices precede float32 shared midpoints, commit applies leaf targets before recursively collapsing homogeneous children, and malformed/deep/shared/duplicate/unordered trees fail closed. Live UI and slicing share exact catalog-backed canonical preflight; ambiguous profile/build/nozzle mappings block, and Three/display defaults are never safety inputs. Preview projections consume rich typed columns and must return explicit unsupported metadata for missing exact filament colors or authoritative layer durations rather than inventing palette/time values. Split-to-objects must capture the exact revision/hash/selection/object scope before confirmation, revalidate it at commit, and leave canonical state untouched on cancel, stale input, unsupported metadata, or topology failure. Calibration requests bind exact definition version/fingerprint plus printer/nozzle/filament/process/firmware prerequisites; vendor automatic execution and any unsafe/stale/unbounded plan fail closed before canonical mutation. G-code inspection derives layer, move, tick, tool, source-window, and focus state from unrenumbered rich record IDs, retains only bounded source text, exposes incomplete prefixes, and never treats headless projection as proof of live controls. Official statistics require a same-export engine sidecar plus an opaque rich-source handle created by streaming SHA-256 over the exact UTF-8 G-code; source/source-asset identities use canonical FNV-1a64, project/config/output/artifact identities use SHA-256, and job/plate/revision/engine bindings also match. Sidecars are exact-key JSON with canonical dense capped arrays and finite bounded arithmetic; `plannerBlockCount` bounds float32 partitions and move subsets, `volumeSampleCount` bounds double material reconciliation, nonempty ordered custom segments cover planner total while a synthetic tail remains conditional, and sparse role-by-tool volumes equal model + support + wipe tower with flush excluded. Rich columns remain observations, missing assumptions propagate unavailable, detected conflicts are non-exhaustive/partial, and all-plate sums group by tool plus profile, expose partial silent coverage, retain a sole known cost unit while affected totals stay unavailable, and never reuse first-plate metadata.
- **The G-code carries a picture of what it prints, and the browser is the only
  thing that can draw it.** `GCode.cpp` writes a thumbnail only when it is handed a
  `ThumbnailsGeneratorCallback`, and that callback is the *GUI* rendering the plate
  offscreen — `libslic3r` has geometry, not a view. The WASM build has no GUI, so the
  callback was null, the branch never ran, and every file reached the machine wearing
  the firmware's stock image. `slicer/GcodeThumbnails.ts` is the engine's own writer
  ported exactly (`THUMBNAIL_BLOCK_START`, `; thumbnail begin WxH <base64 length>`,
  78-character rows, `thumbnail`/`thumbnail_JPG` tags, and the position after
  `HEADER_BLOCK_END`), because a printer parses this by pattern and a near-miss shows
  nothing at all — which is indistinguishable from the bug. `workspace/PlateThumbnailRenderer.ts`
  is the other half: it clones the display meshes into a throwaway scene rather than
  toggling `visible`/`layers` on live ones, so a throw cannot leave the workspace in a
  wrong state, and it turns `renderer.xr.enabled` off around the render because
  `WebGLRenderer.render` otherwise substitutes the XR camera for the one it was given.
  The blocks are attached at `CanonicalSlicerClientRoute`, *before* the coordinator
  hashes the artifact, so download, preview and send all carry the same bytes. Sizes
  come from the printer's own `thumbnails` value (U1 `48x48/PNG, 300x300/PNG`, Centauri
  `144x144`) — never a fixed size, and a format a canvas cannot produce is reported
  rather than emitted under another format's tag. Thumbnailing is best-effort by
  design: a lost WebGL context must not turn a finished slice into a failed one.
  Note the bed is deliberately *not* drawn, unlike upstream's `show_bed: true` — this
  app has two beds, and a thumbnail that depends on which shell you sliced from cannot
  be compared with itself.
- **The app's own deployment is not a secure context, and nothing may assume it is.**
  The all-in-one server publishes the UI over plain HTTP on a LAN address
  (`http://192.168.1.90:3000`); only `localhost` is special-cased into secure-context
  treatment, so every machine *except* the host running the container gets an insecure
  origin. Every secure-context-only web API is therefore absent there, and the two that
  were reached for unguarded both failed on the first real LAN slice:
  `crypto.subtle` (a hard "Web Crypto SHA-256 is unavailable" before the slice began)
  and `crypto.randomUUID` (called while the printer directory loads at startup).
  Both now degrade: `slicing/hash.ts` falls back to the repo's own `sha256Bytes` —
  these are **content identities, not secrets**, and it returns byte-identical digests,
  so an artifact keeps one identity across origins — and `randomPrinterId` builds a v4
  UUID from `getRandomValues`, which carries no such restriction. Before adding any
  `crypto.*`, `navigator.clipboard`, `navigator.serviceWorker`, `mediaDevices`, or
  `SharedArrayBuffer`/`crossOriginIsolated` use, assume the page is **not** secure and
  degrade explicitly; `localhost` testing will never show you the failure.
- **An HTTPS page cannot reach a plain-HTTP machine on the operator's LAN, and the app
  must say so rather than report it as silence.** The published build is served over
  HTTPS (`orcaxr.martinez.fyi`), so `http://192.168.1.228` and `http://192.168.1.90:3000`
  are refused as mixed content *before a request leaves* — and the browser reports that
  as `TypeError: Failed to fetch`, which is exactly what it reports for a printer that
  is switched off. Chrome relaxes this for a LAN address once Local Network Access is
  granted (the prompt is raised by the request; `navigator.permissions.query({name:
  'local-network'})` only *reads* the state), and `targetAddressSpace` is needed only
  for a named host whose address space the browser cannot know before resolving — an IP
  literal is already classified, which is why `localNetworkTargetForRequest` returns
  `null` for one. `net/LocalNetworkAccess.ts` owns the diagnosis and every LAN caller
  reports through it: the status line gets one sentence and a modal gets the three moves
  that actually work. **The best of those is to open the app from the operator's own
  all-in-one server** — it publishes the web UI beside the slicer, so page, slicer and
  printer are all plain HTTP with nothing cross-origin — so when a server is configured
  the diagnosis names it and links to it. Never answer this failure with "check the
  address": the address is fine, and a retry cannot succeed.
- The live G-code viewer renders the bounded rich model plus the preview
  projection: the UI-free session owns mode, bounded record/layer windows, and
  move-class filters; the browser owns its parser worker and cached projections, and `ui/preview/GcodePreviewSurface` draws exactly the
  projected records with the projection's RGBA. Never colour or filter a
  toolpath in the renderer, and never fabricate metadata the projection reports
  as unsupported. Standalone G-code opens read-only and must not touch canonical
  project state. A pinned XY `G2`/`G3` command remains one semantic/source record:
  direction, center, and a dense bounded Float32 interpolation slice are sidecar
  data, and render/inspection consumers expand that slice without renumbering the
  record or distributing semantic metadata. Preserve the upstream Float32
  assignment order—word parsing, P's distinct full-circle length, modal Z/height,
  width, volume, flow, and interpolation floor all have observable boundary
  behavior. Parser record/path/numeric caps publish no partial arc; the lower
  renderer cap fails back to model view with retained narrowing controls. Any
  nonzero arc E stays an extrusion as upstream classifies it, but negative-E
  width uses an explicit finite web fallback instead of propagating upstream NaN.
- Colour painting is canonical end to end: `web/src/project/painting/` owns the
  stable-ID palette projection and a UI-independent `PaintStrokeService`; live
  surfaces stream pointer samples, preview with a derived overlay, and commit one
  labelled undoable command on release. A facet stores the stable physical or
  mixed filament ID, never a palette index or predicted RGB, and the legacy
  display-colour paint panel/brush state is deleted. The `1`-`9` palette keys are
  nine discrete registry actions, matching upstream. The same tool set authors
  support (enforce/block), seam (prefer/avoid), and fuzzy-skin facets - the
  active modal tool owns the channel, so `PAINT_TOOL_CHANNELS` is the only
  channel authority - and the XR rail draws every declared `xr-toolbar` action in
  `XR_RAIL_GROUPS` order, with labels and an overflow group for new actions. Refined state persists as the bounded version-2
  subdivided-facet/child-path tree and uses the pinned uppercase BBS nibble codec for
  `paint_color`, `paint_supports`, `paint_seam`, and `paint_fuzzy_skin` (plus the
  legacy `paint_fuzzy` reader alias). Color projection may use only material
  states `1..64`, even though the wire codec represents `1..255`; an unsupported
  child omits its whole refined source root from the standard projection with a
  warning while the canonical envelope remains lossless. BBS has no brim facet
  attribute, and official-Orca colour round-trip remains unproven.
- Measurement is a read-only port of the pinned `Measure.cpp`, and its plane
  clustering is easy to get wrong: a neighbour facet is *queued* but only
  *claimed* when it is popped and its normal still matches the seed. Claiming at
  push time swallows the whole mesh into one plane (a cube reports 1 instead of
  6). Circle fitting deliberately replaces upstream's default-seeded
  `circle_ransac` with a deterministic algebraic fit — `std::sample` ordering is
  implementation-defined, so exact replication is impossible — while keeping the
  pinned error metric and `0.05` threshold. Circle-to-circle across non-parallel
  planes needs upstream's degree-8 solver and is reported unsupported, never
  approximated. A non-uniformly scaled circle is an ellipse and has no radius to
  report.
- Model import (STL/OBJ/AMF/compressed AMF/ZIP) is signature-first and transactional:
  `web/src/project/import/formats/` decides the container from content, refuses a
  recognised extension that disagrees with the signature, and returns typed
  `requires-project-import`/`requires-native-kernel`/`requires-emboss-workflow`/
  `not-a-model-format` reasons for 3MF/STEP/SVG/G-code instead of re-parsing the
  bytes. `ModelImportParser` stages decoded objects/parts/instances through the
  same `ProjectImportCoordinator` as Open Project, so every add is previewed,
  deduplicated, undoable in one command, and leaves canonical state untouched on
  failure or cancel. Never add a second direct scene-insert import path.
- Smart Paint is a proposal, never a painter. An assistant returns a bounded
  version-1 proposal of normalized-AABB boxes and normal-direction cones;
  `project/painting/aiPaintProposal.ts` projects it against the volume's own
  mesh into exact source triangles (later regions overwrite earlier ones), and
  `AiPaintSession` commits the operator-corrected mask through the same
  `PaintStrokeService` as a manual stroke, as one labelled transaction. Never
  accept a free-form polygon (it would need a camera the proposal never
  declared), never trust a provider-supplied region ID, and never let a
  provider payload reach canonical state without passing the strict parser.
  Consent is checked per payload kind and per provider *before* the request:
  geometry consent sends only a facet count and bounding-box extent, never
  vertices, names, or IDs. Cancel, provider failure, malformed output, and a
  revision/topology change between preview and apply must all leave the project
  byte-identical.
- `ActionRegistry` is constructed once at the composition root and is the only
  invocation/availability gateway for DOM, menus, shortcuts, command palette,
  XR, and contextual Objects selection/rename/reveal. `implemented` requires a real
  handler/evidence mapping; all other states remain visibly and machine-readably honest. A
  handler that completes through a DOM-only dialog must declare an exact XR exclusion reason and
  stay out of the XR surface until an in-headset flow exists; never advertise a spatial control that
  leaves the headset flow stranded. Generate shortcut matching and Help rows from registry
  declarations through the strict conflict-rejecting catalog; do not add a second hand-maintained
  shortcut list.
- **The flat shell is dressed as the official Snapmaker Orca application**, and
  its layout is that application's: a menu strip (File · Edit · View · Add ·
  Tools · Calibration · Help, one dropdown each, plus save/undo/redo), a tab
  strip (⌂ · Prepare · Preview · Device · Project, with `Slice plate` and
  `Print` at the inline end), a **parameter sidebar docked to the inline
  START** (Preview — hidden outside the Preview view and therefore first —
  then Printer / Filament / Color Mixing / Process / Objects / object tools, as
  fold-away cards), and the 3D viewport with the model tools floating over its
  top edge. On a phone the sidebar is a bottom sheet that starts folded and is
  unfolded by `#sidebar-handle`; the shell's grid column is capped at
  `minmax(0, 1fr)` because the tab strip's intrinsic width would otherwise size
  the whole shell past a narrow window. The viewport is a transparent hole so pointer
  input reaches the renderer, and the page — not the renderer — paints the wash
  the plate is seen against (`--oxr-grad-viewport`).
  `ui/tokens.ts` is the only source of colour, radius, shadow, type and motion;
  it emits both the published design-system spelling (`--oxr-surface`,
  `--radius-lg`, `--font-sans`, `--shadow-menu`) and the legacy
  `--oxr-<group>-<key>` form from one table. It now carries **two DOM themes**
  (`domThemes.light` is the default and what the app boots in; `dark` is an
  explicit choice, remembered, never negotiated from the OS) while `tokens.color`
  stays the XR palette — the headset floats over passthrough and keeps the dark,
  amber identity. `injectTokenCss()` emits light on `:root` and only the delta
  under `:root[data-theme='dark']`, so a theme switch is one attribute. Never
  hard-code a hex in the stylesheet or in a panel's inline style, and never add a
  remote font or stylesheet — the CSP and the offline gate both forbid it, so
  type stacks name the design family first and fall back to platform faces.
  Icons are the **same vendored Material SVGs in both shells**: the DOM masks
  them (`applyIcon`, `hydrateIcons`, `[data-icon]` in markup) so a glyph takes
  `currentColor`. `domIcon`'s unicode glyphs are a string-only fallback; an
  element that renders an icon uses the mask.
  `DomShell` renders the menu bar, the quick actions, the floating model
  toolbar, the two print buttons, the sidebar footer's primary bar, and the
  Project page's calibration grid; every one invokes a registry action on a
  declared surface, so `Slice plate` is presentation and never a second slice
  path. `WorkspaceViews` owns the four workspace tabs: Prepare and Preview share
  the sidebar and differ in mode (entering Preview runs the same
  `toggle_preview` action), while Device and Project are **full pages over the
  viewport** that leave the mode alone. A folded card and a hidden page both
  have no layout, so any test or automation that clicks inside one must select
  its view and unfold its card first (`showInspectorTab` in `e2e-smoke.mjs` does
  exactly that). The Project page carries `ProjectSummaryPanel` — plate/model
  counts, the canonical dirty flag, and the recent-projects store — and routes
  Open and Save through the registry, which is why `file_open_project` and
  `file_save_project` are in `INSPECTOR_MIRRORED`. `UiState.mode` follows `workspace.onPreviewStateChanged`,
  because the workspace opens the toolpath preview by itself after a slice;
  without that the tab strip would read "Prepare" over a visible toolpath.
  `PreviewScrubber` is a second view of the *same* `GcodePreviewPanelAdapter`
  the sidebar uses and renders nothing the projection did not supply.
  `main.ts` keeps the camera's `setViewOffset` in step with the viewport rect so
  the plate is centred in the visible area, and clears it whenever an XR session
  is presenting. Three more things are surface-dependent and are all switched in
  one place (`syncViewportChrome`): the camera's field of view (45° in a window,
  the runtime's own in a session — 90° through a monitor leaves the plate the
  size of a stamp), the reticle (an XR aiming cue, hidden behind a mouse), and
  `OrcaWorkspace.setPlateAppearance` — the plate is a grabbable object with
  rings and a bar in the headset, and a plain light bed with a quiet grid in the
  window.
- **The immersive shell is the flat shell, in the same words.** `ui/xr/` draws
  the same menu bar (the seven `MENU_SECTIONS` plus `XR_PANELS_SECTION_ID`,
  which finally has a home), the same four workspace tabs with their live
  sub-lines, the same tool rail, and the same panels — nothing is renamed for
  the headset and nothing is left behind. `XrLayout` is the arrangement, as
  angles from the head; `XrImmersiveShell` owns *what is on* every surface and
  talks to the workspace through one `XrShellHost`, so the whole shell is built,
  pressed and asserted in `__tests__/` with no headset, no canvas and no WebXR
  session. `OrcaWorkspace` keeps only cards, poses and the scene. Four rules
  are load-bearing:
  **`XR_PIXEL_SIZE` is exactly one millimetre**, so a card's metres and its
  layout pixels are the same number — the 58 px hit target *is* the 58 mm
  hand-tracking floor, and the 880 px menu bar *is* 0.88 m of headset.
  **A surface declares `layer` (behaviour) and `presence`/`modes`
  (coexistence) separately**: the geometry tests read the second to decide which
  pairs may not crowd, so a sheet the operator opened may cover the inspector it
  came from while the always-up cockpit may not. **A withheld action states its
  reason in the row**, never behind a hover a headset cannot perform.
  **A recentre moves everything except what the operator pinned** (`XR_PINNABLE`);
  that is the whole contract that makes a grabbable panel safe, and it is why a
  grabbable card is placed as it *arrives* rather than on every redraw — the
  scrubber used to snap out of the operator's hands mid-scrub.
  The shell is reached through exactly one dynamic `import('../ui/xr/immersive')`,
  taken when a session starts (or `?xrui=1`): a phone that never enters XR should
  not fetch and parse a spatial UI, and that one seam is what keeps ~66 KB out of
  the main chunk. Add a runtime XR dependency to `immersive.ts`, never to
  `OrcaWorkspace`'s static imports, or the chunk collapses back into the entry.
- Generated settings schema v2 treats the exact pinned `Tab.cpp` inventory as
  layout authority: 21 tabs, 93 groups, and 424 literal placements are fixed
  counts, and every placement retains its full definition-owner binding set.
  Dynamic placements, custom widgets, and general scope eligibility remain
  explicit fail-closed gaps; imperative dependency predicates and per-control
  reset rules are explicitly unresolved and unenforced, never described as
  blocked. The live generated panel owns only the canonical project/Process override seam (plus the narrow
  source-pinned FullSpectrum project overlay); it must revalidate that scope at
  both draft and commit and never enable Filament, Printer, Object, or Plate-only
  controls merely because their keys exist in `PrintConfig`. Both production
  workers cache the content-hashed schema NetworkFirst after one successful load;
  a schema contract bump requires a static shell-cache bump and an offline smoke.
- CI and clean clones have no `third_party/SnapmakerOrca`, so every gate that
  derives from the pinned engine must degrade honestly instead of crashing:
  `profiles:verify` falls back to byte-exact SHA-256 verification of
  `web/scripts/profile-overlays.lock.json` (mirrors and adaptations both carry
  hashes), and `calibration:verify` falls back to integrity-checking the
  committed inventory's schema, pinned commit, and per-source blob hashes. Both
  print that upstream re-derivation was skipped; `--write`/sync still requires
  the checkout. Never make a gate silently pass when the checkout is missing.
  **The same rule binds tests, not just the generator gates.** Three calibration
  traces once hard-threw on the missing tree and so failed every CI run; the fix
  is not to skip them but to give them a committed artifact to check against.
  The calibration inventory therefore records each workflow's documentation
  target with its blob at the pinned commit (`documentation[]`), and `docs.ts`
  reads that instead of keeping a second hand-maintained table — a Git blob id
  can only have come from resolving the path in that tree, so the link check
  stays real without the clone. Shipped resources are held to upstream the same
  way: the bytes are hashed to a Git blob id and compared to the recorded one.
  Where the clone *is* present, read blobs at the pinned commit
  (`git rev-parse <commit>:<path>`, `git show <commit>:<path>`), never off the
  worktree — a checkout left on another branch must not be able to make a
  provenance check pass. Traces that could not reach upstream say so on the
  result line rather than printing a bare tick.
- Wave-overhang slicing is integrated in `libslic3r` (`src/libslic3r/WaveOverhangs/`)
  supporting pluggable algorithms: Janis A. Andersons wavefront propagation
  (`AndersonsGenerator`) and Kaiser LaSO lateral seed-curve offsetting (`KaiserGenerator`),
  dispatched via `wave_overhang_algorithm`. Wave toolpaths replace cantilever overhangs,
  clip inner perimeters in the overhang zone, carve fill surfaces, and record floor/shadow
  polygons. Floor layers enforce Hilbert-curve solid infill (`wave_overhang_floor_use_hilbert`)
  to minimize thermal warping stress, while speed, fan, nozzle temperature, and end-of-line
  retraction overrides apply during G-code generation with structured debug markers
  (`; WAVE_OVERHANG_BUILD`, `; WAVE_OVERHANG_CONFIG`, `;_WAVE_OVERHANG_FAN_START/END`). Both
  standard and tree support generator stages subtract wave-covered polygons when
  `support_remaining_areas_after_wave_overhangs` is active.
- **Localization has one seam, and canonical code may not touch it (P10.4).** User-facing text
  resolves through `src/l10n/`, and it is attached to the *action registry*
  (`ActionRegistry.useTextSource`), not to a shell: every surface already reads
  labels through `all()`/`get()`, so DOM, XR, the command palette, and context
  menus switch language at the same instant. A shell that localized on its own
  would translate half the app, which reads as a broken translation rather than
  an absent one. With no text source the registry returns its declared objects
  unchanged, so headless tests pay nothing.
  Message ids for actions are **derived** (`action.<id>.{label,hint,reason,xrUnsupported}`) and
  extracted by reading the registry itself — never hand-listed, so an action's
  label cannot escape the catalogue. Everything else uses `t('dotted.id', 'English source')`
  with **both arguments string literals**; `scripts/generate-messages.mjs` walks the
  TypeScript AST and fails on anything computed. Run `l10n:sync` after touching an
  action's text and commit the regenerated `src/l10n/generated/` and `public/l10n/`;
  `l10n:verify` runs in `quality` and degrades honestly without the pinned checkout.
  **Never compile a reference catalogue into the bundle.** The English is already at every
  call site as `t`'s `source` argument, so `public/l10n/en.json` is a *second* copy — it
  ships as a fetched file and only the pseudo-locales pull it. Doing this the other way
  cost 83 KB of main chunk and broke `size:check`; done right the whole feature costs 17 KB.
- **Two gates keep a translated layout honest (P10.4.4), and both are in `quality`.**
  `direction:check` refuses physical direction in CSS — `margin-left`, `text-align: left`,
  `border-right`, a physical `left:`/`right:` inset — in the `index.html` stylesheet and in
  every inline style set from TypeScript. Write the logical property
  (`margin-inline-start`, `text-align: start`, `border-inline-end`, `inset-inline-start`).
  `left: 50%` is allowed and must **stay** physical: fifty percent is the same distance from
  either edge, and converting the `translateX(-50%)` centring idiom to `inset-inline-start`
  actively breaks RTL. A genuinely physical position declares itself with a
  `direction:physical` comment and its reason — a context menu opens at the pointer's
  viewport coordinate in any writing direction.
  `test:pseudo` renders the built app in `en-XA` (40% longer) and `ar-XB` (mirrored) and
  measures 152 critical controls for geometric overflow; it refuses to run against fewer
  than forty, because a green "none clipped" over an empty selector list is worse than no
  gate. **Size chrome to its content, never to the English word in it** — the tool rail was
  a fixed 158 px and truncated eight labels the first time this ran.
  Note that `DomShell.mount` is re-entrant *because* a language change remounts it; it
  appends to the primary bar (the hidden file input lives there) and tracks what it added,
  so anything else that appends to a host it does not own must do the same or a language
  switch will duplicate it.
  Translations are **seeded from upstream's twenty pinned `.po` catalogues** by exact
  English match (plus accelerator/ellipsis normalisation) — never machine-translated, and
  a translation that drops a placeholder is refused rather than shipped, because a
  sentence that lost `{count}` renders "objects will be deleted" with no number in it.
  Plural category comes from `Intl.PluralRules`; never write a `count === 1` rule, which
  is wrong in Russian and Polish in a way an English reviewer cannot see.
  **`src/project/` may not import `src/l10n/`**, and `architecture:check` enforces it as an
  import rule so it cannot be satisfied by re-exporting. Everything in `l10n` is
  locale-dependent by construction and everything under `project/` decides the bytes of a
  saved file; canonical ordering already used `localeCompare` in eleven files once, which
  made a project's bytes depend on the machine that produced them.
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
- Canonical slice preflight refuses every silent engine repair, and it never
  duplicates a canonical validation error — `runCanonicalSlicePreflight` short-
  circuits on those and reports them as `invalid-project-state`, so a new check
  belongs there only when `validateProjectState` cannot already see it. The
  FullSpectrum capability authority is the resolved target's own
  `physicalToolCount`, never the fact that the authoring UI allowed a virtual
  row: `SlicePreflightConstraints.printer` is optional, and an absent
  declaration leaves capability unevaluated instead of assumed. The repairs
  that must stay blocked are the extruder clamp in
  `region_config_from_model_volume`, the `[0.01, 0.99]` gradient clamp and the
  duplicate/out-of-range drops in `decode_gradient_component_ids`,
  `MAXIMUM_FILAMENT_NUMBER` (64), the pinned material compatibility matrix, and
  the `Print::validate()` prime-tower preconditions (relative E required, ooze
  prevention incompatible with single-extruder multi-material, mismatched
  nozzle/filament diameters a warning and not a stop).
- **A consumed 3MF metadata entry must not also be preserved as an opaque blob.**
  On import, `Metadata/model_settings.config` and `Metadata/project_settings.config`
  are parsed into canonical state, so the canonical writer owns them from then
  on. Preserving the originals too puts them back over the generated files on
  save: every canonical edit is silently discarded, and `model_settings.config`
  reinstates object ids the regenerated core no longer has, so the engine
  rejects the whole archive with "can not find object for assemble item". The
  rule is exact — exclude a consumed path from preservation **only when the
  writer regenerates it for that state**; a consumed path the writer does not
  emit is still the only carrier of that data and must stay preserved.
- The pinned `Print::validate()` refuses relative extruder addressing on a
  Marlin flavour unless `before_layer_change_gcode` or `layer_change_gcode`
  resets the extruder, and `use_relative_e_distances` defaults to **true**. A
  project imported without any machine G-code (a Bambu 3MF, whose machine
  settings live in a preset we never receive) therefore fails to slice with a
  raw engine message, so the writer supplies the `G92 E0` the engine itself
  names and warns that it did.
- Canonical work may leave the browser only for an **attested** engine. The
  server's `GET /engine` hashes the artifacts it will actually load and reports
  the pinned commit; the client compares both against
  `slicer/pinnedEngineProvenance.ts`, generated from
  `wasm/artifact-provenance.json`. Both engines can prove themselves, and they
  prove different things: a WASM server must match the exact artifact digests
  the client verified for itself, while the native CLI has no WASM artifacts to
  compare and instead proves its upstream commit plus the exact
  `server/patches/` set by name and digest (`PINNED_ENGINE_PROVENANCE.cliPatches`
  ↔ the image's `engine-provenance.json`). Requiring WASM digests of a native
  binary is what once made the CLI route refuse itself. `server/wasm-dist` is a
  gitignored local publish listed under `optionalPublishedCopies`; the committed
  copies are `wasm/dist` and `web/public/slicer`, and letting any of them drift
  is what makes an external route silently unverifiable.
- **`slice_worker.mjs`'s `resolveWasmDir()` is the sole WASM directory
  authority**, and `GET /engine` must hash what that resolver returns. They were
  once separate — the attestation looked only in `<server>/wasm-dist` while the
  worker loaded `<server>/wasm/dist` or `<repo>/wasm/dist` — so the container
  (whose Dockerfile populated `/app/wasm/dist`) executed a real engine while
  reporting `attested: false`, and the client refused a route that was in fact
  sound. Attesting a directory you do not load is the same defect in the other
  direction, and is worse. An explicit `ORCAXR_WASM_DIR` is authoritative and
  never falls back. Otherwise the resolver prefers `<server>/wasm-artifacts/current`,
  then `<server>/wasm-dist`, `<server>/wasm/dist`, and `<repo>/wasm/dist`.
  A present partial deployment fails instead of selecting another build. Every
  set requires an adjacent manifest; parent manifests are not substitutes.
  Shared `wasm/artifact-set.mjs` checks schema, exact source pin, input identity,
  filenames and hashes. The local/Docker publisher verifies a complete immutable
  version before an atomic `current` symlink rename. Workers resolve that pointer
  once and old versions stay available until readers have stopped. `/engine`
  reports specific mismatch codes from the same verifier. Native attestation
  likewise checks schema, exact source pin, patch identities and executable hash.
  The browser's artifact hash literals must match the canonical manifest; both
  `security:check` and Docker assembly enforce this. A formerly stale browser
  WASM pin made a correct default server reject itself during discovery.
- The Docker build context is the repository root, so `/.dockerignore` is
  load-bearing: without it the daemon receives ~16 GB (`third_party/` is 14 GB)
  before the first instruction. Anything a stage `COPY`s must not be excluded
  there — today `server/` including `server/patches/`, `wasm/dist`, and
  `wasm/artifact-provenance.json`.
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


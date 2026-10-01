# XRBlocks and application surfaces

Maintained technical context from [GEMINI.md](../../GEMINI.md). Read this
when changing the corresponding area; update it in the same commit as behavior.
Code paths below are relative to the repository root. Historical measurements
are fixture-specific evidence, not device-independent performance guarantees.

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
- Product composites must construct `UIPanel`/`UIImage` and mutate their signals through the
  exact-typed `XrUiAdapter`; do not reintroduce `Record<string, unknown>` constructor bags or casts
  in workspace presentation code. Handles invalidate callbacks before their owning card tears down.
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


## Web UI UX gotchas

- **Adopting a printer's filaments must move the bound preset, not just canonical state.** On a catalog-driven profile the *filament preset* bound to each head is what declares the material preflight checks a slice against (`ProfilePreflightConstraints` reads `filament_type` from `target.filamentProfiles[toolId]`), and `applyLiveSlicingConfiguration` rebuilds canonical filaments from the live palette plus those presets. A sync that wrote only canonical `material`/`config.filament_type` therefore produced two contradictory answers — the machine's own PLA came back as "PLA is not supported on tool 1" — and the next profile touch reverted the sync outright. `adoptPrinterFilamentPresets` re-points each reported tool at a compatible preset that declares that material and adopts the reported colour into the palette; a material with no compatible preset for the active printer/process is named in the status rather than silently left mismatched. An imported project is exempt: its embedded filament configuration is its own preflight authority. **Which preset it moves to is decided by vendor, type, and grade together** (`src/slicer/filamentPresetMatch.ts`). The machine reports three separate facts — `filament_vendor`, `filament_type`, `filament_sub_type` — and only the type is a slicer material; matching on the type alone took whichever preset the corpus listed first, which is how four heads of Snapmaker PLA Matte came back as four rows of Generic PLA. The grade is **not** a config key anywhere upstream: it lives only in the preset name, so it is parsed back out of the name *word-wise* — a prefix test reads `Snapmaker PLA-CF`'s grade as `-CF` and would offer carbon fibre as though it were plain PLA. Ranking is vendor, then exact grade (an unreported grade prefers the plain preset over any grade), then shortest name, so corpus order never decides. A preset that contradicts nothing the machine reported is kept: an unreported grade must not drag a deliberate Silk choice back to the plain preset. `filament_vendor` is deliberately **not** in `SAFE_KEYS` — it reaches the matcher as `SlicerProfile.filamentVendor`, so what a slice consumes is unchanged. Adoption stays operator-triggered (Sync Filaments From Printer): connecting must not silently rewrite a deliberately different spool choice, least of all mid-send.

- **The XR tool rail is the toolbar, whole, and every button is labelled.** It
  draws every `xr-toolbar` action in `XR_RAIL_GROUPS` order — three columns of
  58 mm targets in a 0.21 m rail — and anything no group claims is appended
  under "More", so a new toolbar action reaches the rail without an edit and the
  failure mode is an untidy rail rather than a missing tool. Two earlier rails
  were wrong in opposite directions: one mirrored the desktop toolbar and
  overflowed to the floor at 64 px per tile, the other allowed seven ids and
  pushed three of the four `PAINT_TOOL_CHANNELS` two presses further away than
  the fourth. **Icon-only is not an option**: at 0.9 m an unlabelled glyph is
  ~1.5° of arc and "seam paint" and "fuzzy skin" are indistinguishable. The
  active tool's own bounded numbers and the filament palette are drawn on the
  rail beside it, not in a panel three presses away. Hidden cards are not
  automatically free; avoid rebuilding them and use the measured single-owner
  lifecycle in the XRBlocks contract above rather than a manual `UICard.update`
  loop.

- **A layer's height comes from its extrusions, not from the maximum Z in the layer.** `GcodeInspectionModel.buildLayerIndex` used to take the max Z over every record, so a retraction Z-hop on a travel overstated the layer by the hop (a 3.45 mm layer reported 3.85 mm) and anything authored against it landed at a height the printer never prints at. Related: an event marker (`;PAUSE_PRINT`, `;CUSTOM_GCODE`) is emitted *before* the Z move that follows a layer change, so the record's own Z belongs to the previous layer — locate events by `tick.layer` and read that layer's Z, never `tick.zMm`.
- **Layer events must be projected into `Metadata/custom_gcode_per_layer.xml` or they never reach the slicer.** `state.customGcode` entries with a `layerEvent` are written by `bbsCore.ts` with the engine's own numeric `type` codes (`ColorChange`=0, `PausePrint`=1, `ToolChange`=2, `Template`=3, `Custom`=4) plus the legacy `gcode` attribute pre-2.3 readers key off, and read back on import. Store the event's `top_z`, never a layer index — the engine resolves the height against the layers it produced, and a layer-height change would otherwise silently move the event. Verified behaviour on the U1 profile: pause emits `;PAUSE_PRINT` + `machine_pause_gcode`, custom emits its own body, colour change needs `color_change_gcode` (absent ⇒ an empty `;CUSTOM_GCODE` marker, so the UI only offers kinds whose body the profile declares), and a `ToolChange` event is a MultiAsSingle-mode concept that a multi-extruder project ignores.
- **BBS `project_settings.config` is string-valued, and its filament options are vectors — both are load-bearing.** `ConfigBase::load_from_json` accepts strings and arrays of strings only: one numeric element (we used to write `nozzle_diameter` as numbers) makes the engine drop that option entirely and fall back to its default. Worse, `num_extruders` comes from `filament_diameter.size()`, and `region_config_from_model_volume` clamps every per-object `extruder` above that count back to 1 — so a scalar `filament_diameter` turns a correctly assigned multicolor plate into a silent single-tool print with no error anywhere. `web/src/project/serialization/bbsCore.ts` therefore stringifies every value and expands every key in `FILAMENT_VECTOR_KEYS` (ported from the pinned `Preset::filament_options()`) to one entry per physical filament. Symptom to recognize: the saved 3MF has `extruder=2` on the object, the slice succeeds, and the G-code contains only `T0`.
- **Unnamed tool slots inherit the chosen filament.** `PresetGraph.resolveSelection` fills a slot the request never named from slot 0 unless the printer declares a per-slot `default_filament_profile`. Without that, a four-tool U1 came up as PLA + three Generic ABS, and the first two-colour slice failed on the engine's "large difference of temperature" check before any of the multicolor path ran.
- **The Emscripten build emits the full `CONFIG_BLOCK` again.** The old `#ifdef __EMSCRIPTEN__` skip of `append_full_config` predated `fixup_enum_keys_map()`; with it in place the dump is safe, and without it web artifacts carried no `filament_colour`/`filament_type`, which the send-time mapping and G-code re-import both need. Rebuild path: edit the fork tree, `ninja -C third_party/SnapmakerOrca/build-wasm libslic3r`, `wasm/build_wasm_module_snapmaker.sh`, copy `wasm/dist/*` to `web/public/slicer/`, refresh `wasm/artifact-provenance.json`, then regenerate `wasm/patches/snapmaker-fork-wasm-port.diff` with `git -C third_party/SnapmakerOrca diff`.
- **A setting is not editable at every scope, and the scopes do not layer the way the UI nests them.** `tools/settings-schema/generate-scopes.mjs` reads the rules from the pinned engine into `web/src/settings/generated/settingScopes.ts`: a plate may override exactly eight keys, an object 242, a part 123, a height range 124, and a project the whole FFF option universe. `region_config_from_model_volume` applies the object's config, then the part's, then the height range's — so **a height range outranks the part it cuts through**, the opposite of the visual nesting. Use `npm --prefix web run settings:scopes` to regenerate and `settings:verify` (which runs `--check`) in gates; never hand-edit the generated table. Storing a key at a scope the engine does not read it from is not a weaker setting, it is a value with no effect, so authoring refuses it while reading preserves it (a plate's `locked`, an imported object's `extruder`) to keep 3MF round-trips lossless.
- **A viewport click selects an *instance*, and a filament assignment resolves it to the object.** Upstream has no
  per-copy filament — every copy of a `ModelObject` prints from that object's assignment — so
  `getFilamentAssignmentSnapshot` normalises an `instance` ref to its owning object before resolving scope. Without
  that, clicking a model in the 3D view produced "0 assignable scopes" and the whole click-then-pick flow was dead.
  Normalising at the snapshot boundary (not in the command) is what also collapses a multi-copy selection into the one
  scope it really is. A `plate` ref stays unassignable.
- **`SelectionFilamentBar` is a second surface for `objects_assign_filament`, never a second assignment path.** The
  viewport bar and the inspector's `FilamentAssignmentSelector` read the same revision-guarded snapshot and invoke the
  same registry action; the bar simply drops the confirming press, because "make this one blue" is not a deliberation.
  The XR half lives on the Device page's profile rows (`refreshXrSelectionFilaments`) and goes through the same
  action on `xr-inspector`. If a third surface is ever needed, give it the snapshot and the action — do not add a command.
- **Multi-extruder filament selectors:** When the selected printer profile has multiple extruders (e.g., Snapmaker U1), the UI generates individual filament dropdowns for each extruder head (H-1, H-2, etc.). The global `sel-filament` dropdown MUST be hidden in this state (`display: 'none'`) to avoid redundancy and user confusion. Do not reintroduce a visible global filament dropdown alongside the per-head dropdowns.
- **The web profile corpus is a verified pinned overlay, not an editable copy.** `npm --prefix web run profiles:verify` requires `third_party/SnapmakerOrca` HEAD `9fd12ffb2b1b80c9fb4c14564754d2ec1573a626`, proves every same-path Snapmaker/Elegoo profile byte-identical to that Git tree, checks the imported inheritance closure, SHA-256-locks OrcaXR-only target adaptations in `web/scripts/profile-overlays.lock.json`, and verifies deterministic `catalog.json` ordering. Use `profiles:sync` deliberately after reviewing source/profile changes; never hand-edit a mirrored leaf or describe the local Elegoo adaptations as upstream-pinned. The calibration catalog is likewise generated from exact pinned Git blobs: use `calibration:verify` in normal gates and `calibration:sync` only after reviewing upstream source/resource or local-binding changes; never hand-edit its generated JSON. **What ships is the vendor bundle's registered set, not the whole upstream directory:** `resources/profiles/<Vendor>.json`'s `machine_list` / `process_list` / `filament_list` is the authority on which leaves the official slicer actually shows — the tree also holds unregistered ` copy`/`_old`/experiment leaves that must stay out. Every Snapmaker U1 and Elegoo CC leaf that bundle registers is now vendored, so the picker matches the official slicer per nozzle. Preset compatibility is **nozzle-scoped by exact `compatible_printers` lists**: a filament preset named `@U1 0.6 nozzle` reaches only the 0.6 mm machine, so adding a process preset for a nozzle whose filament family is missing leaves that variant listed-but-unsliceable and raises `no-compatible-filament` errors in `ProfileCatalog.diagnostics`. Add the whole nozzle family or none of it; `profile-loader.test.ts` holds the corpus to zero error diagnostics.
21. **`normalize_fdm()` crashes with a null-deref when traversing the component graph if no options are set.** Patch `0076-normalize-fdm-null-deref.patch` fixes this for the server backend.


- Bounded preview windows expose Previous/Next moves in the inspector, viewport
  scrubber and XR scrubber through `preview_configure`. Keep XR narrowing/paging
  controls visible for a retained session even when its current window has no
  drawable moves or lacks mode metadata; otherwise an empty chunk strands the
  viewer. UI mode follows a loading or retained inspection session, independently
  of drawable geometry. Reselecting Preview preserves pending parsing; Prepare
  cancels it through the registry in DOM and XR. Closing a standalone preview
  requires neither a loaded model nor a published slice, while export/send keep
  their exact artifact prerequisites. Closing the session hides the surface;
  canonical invalidation also clears retained, non-drawable slice previews.

# Snapmaker Orca → OrcaXR Web feature-parity plan

Goal: **every menu and button in [Snapmaker Orca](https://github.com/Snapmaker/Orca)
has an equivalent in the OrcaXR web app, in both the DOM (desktop/phone) and XR
shells.** Controls whose underlying feature isn't built yet ship **visible but
grayed out** ("SOON" badge), so the surface is complete and honest. This doc is
the catalogue of every control, its status, and — for each unbuilt one — how to
implement it and the one-line change that enables the button.

## How parity is structured (read this first)

Both shells render from **one** declaration: `web/src/actions/` — the
`ActionRegistry`. An `Action` that mirrors an Orca command OrcaXR hasn't built
carries a `comingSoon: string`. That single field does three things:

- `ActionRegistry.enabled(a, state)` returns `false` for any `comingSoon` action,
  so it is never clickable in **any** UI state;
- the DOM shell (`ui/dom/DomShell.ts`) renders it disabled with a **SOON** badge
  and the reason string as its tooltip; the command palette does the same;
- the XR shell (`ui/xr/XrShell.ts`) renders it dimmed (`surfaceDisabled`,
  opacity 0.45) and inert.

**Enabling a feature is always the same two steps:**

1. Build the capability (a `workspace`/`feature` method + an `ActionContext`
   verb that routes to it).
2. In the action's group file, **delete the `comingSoon` line**, point `run` at
   the new `ActionContext` verb, add an `isEnabled` gate if relevant, and set
   `mcpTool` if a matching Android MCP tool exists (the parity test asserts it's
   real).

The machine-checked contract lives in
`web/src/actions/__tests__/parity.test.ts` — `REQUIRED_ORCA_ACTIONS` lists every
Orca control that must exist, and a test asserts every `comingSoon` action is
disabled. Deleting a parity action fails CI.

## Coverage summary

| Menu / surface | Wired | Coming-soon | Orca source |
|---|---:|---:|---|
| Primary bar (Load / Slice / Preview / Download) | 4 | 0 | top bar |
| Tool rail (Move/Rotate/Scale/Lay-flat/Paint/Auto-orient/Delete) | 7 | 0 | left gizmo bar |
| **File** | 15 | 0 | `MainFrame.cpp` File menu |
| **Edit** | 10 | 0 | Edit menu |
| **View** | 16 | 0 | View menu |
| **Add** | 6 | 0 | top toolbar "add" |
| **Tools** (mesh ops, gizmos, object context menu) | 33 | 0 | left gizmo bar + right-click menu |
| **Calibration** | 9 | 0 | Calibration menu |
| **Help** | 9 | 0 | Help menu |
| **Total** | **109** | **0** | 109 actions |

Regenerate these numbers any time with the dump script pattern in the parity
test, or `npx tsx web/src/actions/__tests__/parity.test.ts` (prints the totals).

**Completeness audit (2026-07-06):** the full Snapmaker Orca menu/toolbar/gizmo
surface was re-extracted from `third_party/SnapmakerOrca/**` and diffed against
the registry. The diff closed the last genuine gaps — **Delete all** (wired),
and placeholders for **Export Toolpaths as OBJ**, **Open G-code Viewer**,
**Export Logs** (File), **Auto Perspective / Show 3D Navigator / Show Selected
Outline / Show G-code Window / Show Printable Box** (View), and **Check for
Update / Show Tip of the Day** (Help). Orca's own `(TODO)`-labelled stubs (Show
Model Mesh/Shadow) and OS-shell items (New Window, Quit) are intentionally
omitted. Every remaining Orca control now maps to a registry action (wired or a
disabled `SOON` placeholder), enforced by `REQUIRED_ORCA_ACTIONS`.

---

## File menu

| Orca command | OrcaXR action | Status |
|---|---|---|
| Import 3MF/STL/STEP/OBJ | `file_import_model` | ✅ wired → `load_model_from_path` |
| Export G-code | `file_export_gcode` | ✅ wired → `save_gcode_to_downloads` |
| Export STLs / one STL | `file_export_stl` | ✅ wired → `exportPlateStl` (binary STL of the merged plate) |
| New Project | `file_new_project` | ✅ wired → `newProject` (clears all plates + slice output) |
| Open Project | `file_open_project` | ✅ wired → `openProject` |
| Import Configs | `file_import_config` | ✅ wired → `importConfig` |
| Import Zip Archive | `file_import_zip` | ✅ wired → `importZipArchive` |
| Save Project / Save As | `file_save_project` / `file_save_project_as` | ✅ wired → `saveProject` |
| Export all plate sliced file | `file_export_all_plates` | ⏳ SOON |
| Export Generic 3MF | `file_export_3mf` | ✅ wired → `exportPlate3mf` (geometry) |
| Export config | `file_export_config` | ✅ wired → `exportActiveConfig` |
| Export Toolpaths as OBJ | `file_export_obj` | ⏳ SOON |
| Open G-code Viewer | `file_open_gcode` | ⏳ SOON |
| Export Logs (ZIP) | `file_export_logs` | ⏳ SOON |

**Implementation notes**

- **Export STL** (`file_export_stl`) — ✅ **done.** `workspace.exportPlateStl()`
  feeds `mergedPrinterGeometry()` (the same mm/Z-up geometry the slicer bakes)
  through three.js `STLExporter` (binary) and downloads it via the new generic
  `onDownloadFile` callback.
- **New Project** (`file_new_project`) — ✅ **done.** `workspace.newProject()`
  disposes every model on every plate, resets to a single empty plate, and
  clears the slice output / preview.
- **Export 3MF** (`file_export_3mf`) — ✅ **done (geometry).**
  `features/Write3mf.ts` (pure, 4 unit tests) zips a valid 3MF package
  (`[Content_Types].xml` + `_rels/.rels` + `3D/3dmodel.model`) from the merged
  plate positions; `exportPlate3mf()` downloads it via `onDownloadFile`. Verified
  round-trip: exported bytes re-parse through the app's own 3MF loader into the
  correct 12-tri cube (1→2 models), no errors.
- **Save Project / Save As** (`file_save_project`) — ✅ **done.**
  `features/Project3mf.ts` (pure, 4 unit tests) writes a valid 3MF with one
  `<object>` per model plus a `Metadata/orcaxr_project.json` sidecar carrying per
  object placement (viewer + display transforms), plate membership, the active
  plate, and the profile triple. `buildProjectBytes()` gathers the whole scene
  (all plates); `saveProject()` downloads it. (Save As = same download; the web
  has no path concept. Paint channels are the next layer.)
- **Open Project** (`file_open_project`) — ✅ **done.** `parseProject3mf()` reads
  the sidecar + per-object geometry; `openProject()` clears the scene, restores
  the profile, recreates the plates (mapping saved ids), and re-adds each model
  to its plate with its saved transform, then selects the saved active plate. A
  plain (non-project) `.3mf` returns null and the picker falls back to a normal
  model import. Verified round-trip: a 2-plate scene (2+1 models, active plate 2,
  arranged transforms) saves to 1564 B and re-opens byte-identical.
- **Import Config / Export Config** — ✅ **done.** `features/ConfigIO.ts` (pure,
  5 unit tests) serialises the active profile's flat `config` map to a
  self-describing JSON bundle and parses it back (also accepting a plain flat
  Orca-style `{key:value}` config, arrays joined with `;`). `exportActiveConfig()`
  downloads it; `importConfig()` merges the bundle over the current profile and
  `setProfile`s it (so a partial bundle still yields a working profile). A `.json`
  picker is wired in `main.ts`. Verified round-trip: exported the 177-key config,
  changed `layer_height` 0.2 → 0.99, re-imported, confirmed applied.
- **Import Zip** — ✅ **done.** `importZipArchive()` unzips in-browser (`fflate`)
  and runs each `.stl` / `.3mf` / `.obj` entry through the shared
  `loadModelFromBuffer()` (skipping `__MACOSX`/junk). A dedicated `.zip` picker
  is wired in `main.ts` and the generic import handler also accepts `.zip`.
  Verified: a zip of two STL cubes + a readme → 2 models (readme ignored).
- **Export all plates** — loop the existing single-plate slice over every plate
  and zip the G-codes.
- *Intentionally omitted (no web meaning):* New Window, Open new window, Quit,
  Open a new PrusaSlicer, Show Configuration Folder (browser sandbox), Download/
  Upload Models (MakerWorld account flow — `add_handy_model` covers the built-in
  library case).

## Edit menu

| Orca command | OrcaXR action | Status |
|---|---|---|
| Delete selected | `edit_delete_selected` | ✅ wired → `delete_models` |
| Delete all | `edit_delete_all` | ✅ wired → `deleteAllModels` |
| Deselect all | `edit_deselect_all` | ✅ wired → `unselectModel` |
| Undo / Redo | `edit_undo` / `edit_redo` | ⏳ SOON |
| Cut / Copy / Paste | `edit_cut` / `edit_copy` / `edit_paste` | ✅ wired → `cutSelected` / `copySelected` / `paste` |
| Clone selected | `edit_duplicate` | ✅ wired → `cloneSelectedModel` |
| Select all | `edit_select_all` | ⏳ SOON |

**Implementation notes**

- **Scene undo/redo** is the load-bearing one. OrcaXR has a *paint* history
  (`features/PaintHistory.ts`) but no scene-level command stack. Introduce a
  `SceneHistory` with a `Command { do(); undo() }` interface and push a command
  for every mutating op (add / delete / transform / boolean). Wire `edit_undo`/
  `edit_redo` and the `Ctrl+Z`/`Ctrl+Y` keys. *Enable:* delete `comingSoon`,
  `run: ctx => ctx.undo()`, `isEnabled: s => s.canUndo`.
- **Cut / Copy / Paste** (`edit_cut` / `edit_copy` / `edit_paste`) — ✅ **done.**
  A single-slot geometry clipboard on the workspace: Copy stores
  `selectedModel.raw.clone()` (paint colours ride along), Cut copies then
  deletes, Paste adds a fresh copy (centred + auto-selected). Paste's
  `isEnabled` reads a new `UiState.hasClipboard` flag the context sets on
  copy/cut. Verified headless: copy→paste 1→2, cut→1, paste→2, enablement flips.
- **Clone selected** (`edit_duplicate`) — ✅ **done.**
  `workspace.cloneSelectedModel()` deep-clones the selected model's geometry
  (carrying its vertex-colour paint) and adds it as a new model. Fixed a
  pre-existing multi-model bug in the same pass: `printerGeometries()` read a
  just-added model's *stale* world matrix and placed it at the bed edge
  (off-bed pre-flight blocked slicing for **any** 2nd model, not just clones);
  it now forces `viewer.updateMatrixWorld` before reading. Cut/copy/paste still
  want a `clipboardModel` buffer (paste = clone at the cursor).
- **Select all** — requires multi-selection. The workspace tracks a single
  `selectedModel`; promote it to a `Set` and update the gizmo/inspector to act on
  the set. This unblocks group transform too.

## View menu

7 wired, 9 ⏳ SOON.

- **Preset camera views** (`view_camera_*`, 7 of them) — ✅ **done.**
  `workspace.setCameraView(view)` copies the OrbitControls target to the live
  plate centre (`plateFocus()`) and places the camera one radius away along the
  named world axis (+Y top, −Y bottom, +Z front, −Z rear, ±X left/right, iso
  default). Verified headless: target stays on the plate centre, each preset
  lands at its expected orthogonal offset.
- **Perspective ↔ Orthographic** (`view_perspective_toggle`) — swap the active
  `PerspectiveCamera` for an `OrthographicCamera` framing the same view; keep
  OrbitControls attached.
- **Show Wireframe** (`view_show_wireframe`) — ✅ **done.** `toggleWireframe()`
  parents a `WireframeGeometry` overlay to each model's display mesh (new models
  inherit the active toggle); verified 0→2 overlays→0 across two models.
- **Show Printable Box** (`view_show_printable_box`) — ✅ **done.**
  `togglePrintableBox()` adds an `EdgesGeometry` wire box sized to the bed
  (X/Y from the profile, 250 mm nominal Z) standing on the plate; verified
  0→1→0.
- **Show Object Labels** (`view_show_labels`) — ✅ **done.** `toggleLabels()`
  parents a camera-facing `Sprite` (CanvasTexture "Model N", raycast disabled so
  it never steals the grab) above each model; new models inherit the toggle.
  Verified 0→2→(+cube)3→0.
- **Show Overhangs** (`view_show_overhang`) — ✅ **done.** `toggleOverhang()`
  adds a red overlay mesh of just the steeply down-facing triangles (raw is
  Z-up → normal.z < −0.5) as a display child, so it inherits the transform and
  leaves `display.geometry` (the slice source) untouched. New models inherit the
  toggle. Verified: cube → 2 overlay tris (bottom face); sphere adds its lower
  hemisphere.
- **Auto Perspective** (`view_auto_perspective`) — hangs off the preset-view
  hook: when a top/bottom/side preset is chosen, switch to orthographic;
  free-orbit switches back to perspective.
- **Show 3D Navigator** (`view_show_navigator`) — a small orientation cube/gizmo
  in a screen corner that reflects and drives the camera.
- **Show Selected Outline** (`view_show_outline`) — a toggle for the selection
  outline (the XR shell already outlines the selection; wire a DOM post-process
  outline pass and gate both on the flag).
- **Show G-code Window** (`view_show_gcode_window`) — a text pane in Preview that
  scrolls the parsed G-code and highlights the hovered layer/line.
- **Show Printable Box** (`view_show_printable_box`) — draw the printable build
  volume as a wire box (reuse the bed extents already known to the workspace).

## Add menu — ✅ complete

Add from library, Cube, Cylinder, Sphere, Calibration tower, Calibration cube —
all wired. Orca's "Add" is a primitive/library drop; OrcaXR matches it.

## Tools menu (mesh ops · gizmos · object context menu)

**Wired:** Repair mesh, Simplify, Boolean Union / Subtract / **Intersect** (the
trio is now complete), Add/Delete plate, Emboss Text, Add Magnet Hole,
Auto-place Wipe Tower, Scan Subnets, View Webcam.

**Coming-soon** (Orca left gizmo bar + top toolbar + right-click menu):

| Action | Orca gizmo/menu | Implementation sketch |
|---|---|---|
| `arrange_all` | top toolbar *Arrange* | ✅ **done** — `arrangePlate()` lays models in a centred grid (cell = largest footprint + 10 mm gap). Verified: 4 stacked cubes → 2×2 grid at ±15 mm, on-bed. A tighter 2D bin-pack can replace the grid later. |
| `duplicate_plate` | File *Duplicate Current Plate* | ✅ **done** — `duplicateCurrentPlate()` snapshots each model (geometry + transform), makes a new plate, and re-adds the copies. Verified: Plate 1·2 → Plate 2·2, 4 meshes total (2 hidden, 2 active). |
| `split_to_objects` | *Split to objects* | ✅ **done** — `features/MeshSplit.ts` (pure, 6 unit tests) welds coincident verts + union-finds triangles into connected components; `splitSelectedToObjects()` re-adds one model per body keeping its original layout. Verified: a 2-cube mesh → 2 models. |
| `split_to_parts` | *Split to parts* | ⏳ **blocked on a parts hierarchy** — the connected-component math is done (`MeshSplit.ts`), but Parts differs from the shipped Split to Objects only by keeping pieces grouped as sub-parts of one object, which OrcaXR's flat model has no container for. Ships identical-to-Objects only once a multi-volume object model exists. |
| `tool_cut` | *Cut* gizmo | ✅ **done** — `features/MeshCut.ts` (pure, 4 unit tests) clips triangles at a plane and caps the section (centroid fan, exact for convex sections); `cutSelectedByPlane()` bisects at mid-height into two capped halves. Verified: cube → halves z[0,10] & z[-10,0]. Paint colours not carried across the cut; arbitrary cut-plane orientation is the follow-up. |
| `tool_support_paint` | *Support painting* | reuse the paint raycast; write a **support** facet channel (enforcer/blocker). |
| `tool_seam_paint` | *Seam painting* | paint channel → `seam_painting` 3MF facets. |
| `tool_fuzzy_skin` | *Fuzzy skin* | paint channel → fuzzy-skin facets. |
| `tool_brim_ears` | *Brim ears* | pick points → per-point brim ear config. |
| `tool_measure` | *Measure* | pick two features, report distance/angle in an overlay. |
| `tool_assembly` | *Assembly view* | explode multi-part objects along their normals. |
| `tool_face_detector` | *Auto face* | detect the largest flat face and lay to it (auto-orient covers the common case). |
| `tool_svg` | *SVG* gizmo | extend the emboss path to import/extrude an SVG. |
| `tool_hollow` | *Hollow* | inward offset shell + drain holes. |
| `add_modifier` | right-click *Add Modifier* | per-region config over a sub-mesh volume. |
| `add_support_enforcer` / `add_support_blocker` | right-click | box/sphere volumes flagged enforce/block. |
| `add_height_range` | right-click *Height range* | per-Z-range config override. |
| `set_negative_part` | right-click *Negative Part* | flag a part as a cut volume (Add Magnet already ships negative-volume pockets — generalise it). |
| `variable_layer_height` | top toolbar *Variable layer height* | paint per-Z heights (adaptive-layers auto mode already exists in the inspector). |
| `send_to_printer` | *Print plate* | one-click Moonraker upload+print (the sidebar Printer panel already uploads today). |

Painting variants (support/seam/fuzzy-skin) are the highest-leverage group:
they all reuse the **existing** paint raycast + BVH machinery
(`features/PaintInput*`, `Paint3mf`) with a different facet channel, and the
3MF writer already emits paint facets — so each is "add a channel + a brush
colour + a 3MF facet tag", not new infrastructure.

## Calibration menu

**Wired:** Temperature Tower, Flow Rate (Pass 1 / Pass 2 / YOLO), Pressure Advance,
Retraction, Max Flowrate, VFA, Tolerance. Each is a fixed-geometry model. Config overrides per-band will be added next.

## Help menu — ✅ all but one wired

A lightweight **modal framework** now backs the informational Help items:
`workspace.onShowModal({title, bodyHtml})` (rendered by `main.ts` as an overlay
card; XR falls back to the status line) plus a dedicated `onShowSetupWizard`
callback for the interactive one. Content lives in `actions/helpContent.ts`.

- **Documentation / Report a Bug** — open the site / issue tracker.
- **Check for Update** (`help_check_updates`) — asks the PWA service worker to
  re-check (`reg.update()`): "Checking for updates…" → "up to date" / "reload".
- **About / Keyboard Shortcuts / Tutorial / Tip of the Day** — ✅ **done.**
  Informational modals from `helpContent.ts` (Tip rotates daily). Verified each
  opens with the right title and closes.
- **Setup Wizard** (`help_setup_wizard`) — ✅ **done.** An interactive modal with
  Printer / Process / Filament dropdowns (process+filament repopulate when the
  printer changes via `choicesForMachine`); **Apply** calls `setProfileByNames`.
  Verified: changing the process (0.20 Standard → 0.12 Fine) applied and closed.
- **Show Configuration Folder** — the one remaining SOON: **no web equivalent**
  (browser sandbox has no config folder); kept only for menu parity.

---

## Parameter settings (print / filament / printer config trees)

Orca's sidebar exposes hundreds of *settings* (not buttons). OrcaXR already
surfaces the load-bearing ones in the inspector (layer height, walls, infill,
supports, wall generator, adaptive layers, wipe tower, multi-material rows,
FullSpectrum virtual filaments) and can slice desktop-authored profiles
verbatim. Full settings-tree parity is tracked separately from this button/menu
plan; the mechanism is the same `ProfileLoader` `SAFE_KEYS` surface.

## XR shell layout

The immersive shell renders the **identical, full action set** from the same
`ActionRegistry`: the tool rail draws the modal gizmos (`byDisclosure('toolbar')`)
and the ActionPanel draws the primary actions plus **every menu section**
(File / Edit / View / Add / Tools / Calibration / Help), grouped and labelled
like the DOM menu bar, with coming-soon placeholders dimmed + inert and tagged
"SOON". So XR ⇄ DOM parity is structural — neither shell can have a button the
other lacks.

The immersive layout was imported from the Claude Design project *"OrcaXR
Slicer"* (via the DesignSync MCP) and is now **applied to the XR shell** — the
card zones in `OrcaWorkspace.recenterInFrontOfUser()` mirror the design:

- **top-centre** — a HUD strip with the OrcaXR wordmark + a Prepare/Paint/Preview
  mode switch (`addTopStrip`);
- **left** — the tool rail (modal gizmos);
- **right column** (near→far, fanning toward the user) — settings inspector
  (presets) · all-actions/menus panel · device/AI panel;
- **bottom-centre** — a primary action bar (Load / Slice / Preview / Download)
  pulled prominent (`addBottomBar`).

Its design-system tokens are the ground truth for `web/src/ui/tokens.ts` (same
deep-charcoal void + orange accent; a `.theme-spatial` mint variant exists for
the native Android XR app). The extrusion **role colors**, `accent2`, and `warn`
are now in `tokens.ts`. Remaining design-driven polish (the wrist-anchored
radial tool menu, category-tabbed inspector, vertical layer slider, live device
telemetry) is tracked as follow-up; the menu/button parity and the top/left/
right/bottom spatial zoning are done in both shells.

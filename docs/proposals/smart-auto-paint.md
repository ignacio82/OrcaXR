# Smart Auto-Paint — design proposal

Status: **M1 + M2 shipped** (geometric strategies + image-projection
core + `auto_paint` MCP tool, physical-only). M4 designed, not started;
M3 (FullSpectrum) gated on green PeggyPalette. Roadmap home: **D20**
(Full-Color & High-Fidelity Painting) + **D21** (auto-paint without an
LLM driver).

## Goal

One action — from the XR UI or over MCP — that paints a whole model with
the user's available filament colors, with two optional inputs:

1. **A target image** the result should resemble ("make it look like
   this photo / concept art / render").
2. **FullSpectrum colors** in addition to the physical filaments, to
   widen the achievable gamut via mixed/dithered virtual filaments.

This is the no-manual-brush counterpart to the existing AI-paint pillar
(C9): instead of the LLM issuing N paint primitives, one tool produces a
full-coverage per-triangle color assignment and commits it as a single
undo step.

## What already exists (reuse, do not rebuild)

The research that preceded this doc established that ~80% of the
machinery is already in the tree and battle-tested:

| Need | Existing component |
|---|---|
| Image → mesh projection | `AiDecalEngine.project` / `paint_decal` — raycast pixel→tri, per-tri majority vote, one-undo `LoadPaintState` |
| Pixel↔triangle math | `AiRenderEngine.projectAndScreen` (forward) + `AiMaskProjection.castRay` (inverse), already mutually consistent; `RenderMode.TriangleId` gives an occlusion-correct pixel→tri map in one raster pass |
| Deterministic triangle bucketing | `AiProceduralPaint.gradient` / `valueNoise` (centroid projection + value noise) |
| Connected-shell segmentation | `MeshBvh.connectedComponent` + `directNeighbors` + `smartFillBfs` |
| Perceptual quantization to filaments **and FS blends** | `GamutMatcher.matchModelColors` (CIEDE2000 over physical + blend gamut, using the production pigment mixer `filament_mixer_model.h`); `applyGamutMatches` materializes virtual `MixedFilamentEntry` rows |
| Recognize a known shape, paint it sensibly | `find_similar_recipe` (geometry fingerprint) + `paint_template` (bundled recipes) |
| LLM region identification | `find_feature_anchors`, `get_mask_for_text`, `generate_mask_from_point` |
| Verify against a reference image | `score_paint_against_reference` + `OkHttpVisionApiClient` + `VisionRateLimiter` |
| Iterate without N rebakes | headless paint sessions (`begin/commit_paint_session`) |
| Multi-color commit, one undo | `WorkspaceAction.LoadPaintState` → `applyPaintMutation` |

## Hard constraints (load-bearing)

1. **No UVs anywhere.** Every import (3MF/OBJ/AMF) is flattened to binary
   STL before Kotlin sees it; STL has no texture coordinates. Mapping a
   2D image to the mesh is **camera projection only** — there is no
   UV/texture shortcut. (UV-to-vertex-color baking is roadmap D20c, out
   of scope here.)
2. **Frame & index space.** Everything operates in `centered_preview_mm`
   (bbox XY-center at origin, Z-min on the bed, +Z up) and the triangle
   index space is the derived-STL binary triangle order. The BVH,
   `AiRenderEngine` cameras, `AiMaskProjection`/`AiDecalEngine`, and
   `paintFilamentIndex` already all agree on this. A new engine must not
   feed raw-STL or printer-frame coords to a camera.
3. **Multi-color commits go through `LoadPaintState`, never
   `PaintTriangleSet`.** `PaintTriangleSet` carries a single `tag`; an
   auto-paint produces many slots. `LoadPaintState` → one
   `applyPaintMutation` → one `paintContentVersion` bump → one
   `PaintHistory` stroke → one `paint_undo`.
4. **Capability gate.** Emitting `LoadPaintState` when the host shell
   isn't wired silently drops the work. Gate on
   `ws.isCapabilityWired(TierBCapability.LoadPaintState)` and return a
   clear error (mirror `commit_paint_session`).
5. **FullSpectrum honesty.** Painted-Local-Z FS emission is complete
   end-to-end (patch 0067) and is *the* working multi-color path — an
   auto-paint produces painted geometry, so it is the ideal FS consumer.
   **But** the `PeggyPaletteFullSpectrumParityTest` +5.4% regression is
   open and is the highest-priority FS issue, and there is a hard
   "never commit on red PeggyPalette" gate for slicer-touching commits.
   Therefore **FS mode is deferred** (see Milestones); physical-only is
   the always-correct path and ships first.

## Architecture

A new pure-Kotlin **`AutoPaintEngine`** (parallels `AiDecalEngine` /
`AiProceduralPaint`) + one MCP tool family + an XR "Smart Paint" panel.
The engine is a pipeline with a pluggable *appearance source* and a
*color-target gamut*:

```
1. APPEARANCE  → perTriangleSlot[triCount]  (0 = not yet assigned)
     strategy ∈ { recipe | geometric | image-projection | semantic-LLM }
2. COVERAGE FILL → every still-0 triangle inherits its nearest assigned
     neighbour via BFS over MeshBvh adjacency (no holes, ever)
3. QUANTIZE    → only when the appearance source produces RGB targets:
     cluster targets in CIELAB (k ≤ palette size / user cap),
     physical-only:  GamutMatcher with blends disabled
     FullSpectrum:   GamutMatcher full gamut → applyGamutMatches()  [deferred]
4. EMIT        → ByteArray(triCount) of 1-based slot tags
                 → LoadPaintState (live, one undo) OR into a paint session
5. VERIFY/LOOP → (target image only) render_view → score_paint_against_
     reference → feed regions[] corrections back to stage 1, bounded,
     monotonic-improvement guarded
```

### Mode A — no image: geometry / semantic auto-paint

"Smart" with no target = partition the model and assign distinct
available colors. Layered, cheapest-first:

- **`recipe`** — `find_similar_recipe` fingerprint; if a bundled recipe
  matches, delegate to `paint_template`. Deterministic, no API. (Wired
  as a delegation pointer in M1; full in-engine delegation is M1.x.)
- **`height_bands`** — slot index ramps with centroid Z across the
  palette. Reuses `AiProceduralPaint.gradient(0,0,1, …)` math; the
  engine wraps it for *full coverage* (the raw primitive skips
  out-of-band triangles; the engine assigns every triangle a band).
- **`components`** — each disconnected shell gets its own slot
  (assemblies, multi-part prints). Iterates `connectedComponent` over
  unvisited seeds; components sorted by descending triangle count for
  stable, meaningful slot assignment.
- **`cavity`** — recessed/concave triangles get a contrast slot; a
  curvature proxy (`dot(triangleNormal, mean-of-neighbour-normals)`,
  the same cavity signal already baked in `nativeWriteColoredGlb`).
- **`semantic`** (M4) — render a multi-view montage → Claude "identify
  the meaningful regions of this object" → masks via the existing
  vision tools → per-region color.

### Mode B — with image: appearance transfer

The realistic user input is *"a photo of a clownfish"* / concept art,
**not** an orthographic render of this exact mesh. Classical pose
estimation is fragile and is deliberately avoided. Two sub-cases:

- **B1 — image roughly aligned to the mesh.** Pick the camera by
  silhouette-IoU search over the 8 existing `AiRenderEngine` named
  presets + a small azimuth/elevation refinement grid (optionally one
  cheap vision call: "which render best matches this orientation?").
  Then project via the `AiDecalEngine` kernel, **accumulate votes
  across ~10–14 views** (the existing decal path is single-view /
  front-face only — multi-view + diffusion fill is the new coverage
  guarantee), quantize, commit. Physical-only. → **M2**.
- **B2 — style/subject reference (the common case).** Skip pose
  entirely. Render the model from N canonical views; send target +
  montage to Claude: "map the reference's color regions onto this
  object." Convert Claude's region calls into triangle sets via
  `get_mask_for_text`/`find_feature_anchors`, color each region from the
  reference, quantize, apply in a paint session, `score_paint_against_
  reference`, bounded corrective loop. Every tool in this chain already
  exists — the feature is the orchestrator. → **M4**.

"Both equally" (the chosen priority): M2 is the shared substrate both
image cases ride on; M4 layers the semantic transfer on top.

### Color clustering / toolchange budget

Cluster target RGBs with k-means in **CIELAB**, `k = min(palette size,
user max-colors, distinct complexity)`. Bounding `k` bounds physical
toolchanges and purge-tower waste — the same reason `GamutMatcher`'s
`blendDeltaEMargin` already biases against marginal blends. The CIELAB +
CIEDE2000 primitives currently live `private` inside `GamutMatcher`; M2
extracts a small public **`ColorScience`** object (sRGB→linear→XYZ→Lab,
CIEDE2000) so both the new engine and the MCP tools (which today use
crude RGB-Euclidean nearest-palette) can share the perceptual metric.
M1 does **not** need `ColorScience` — its geometric strategies assign
slot indices directly, no RGB matching.

### The FullSpectrum drop-in seam

FS is one parameter on one function. `GamutMatcher.matchModelColors`
already enumerates physical + pigment-mixed blend candidates and picks
the CIEDE2000-nearest; `applyGamutMatches` already materializes the
virtual `MixedFilamentEntry` rows and rewrites `virtualSlot`s.
Physical-only quantization is the same call with blends disabled
(`mixStepPercent` large / `blendDeltaEMargin` ∞). When PeggyPalette goes
green and FS Local-Z is hardware-verified, FS mode is: flip the
parameter, add the predicted-mix preview (via the same pigment mixer the
slice uses, `SlicerEngine.blendFilamentColors`), and add an
"experimental" UI gate. No architectural rework — the engine's quantize
stage is written against the `GamutMatcher` seam from M2 onward.

## Tool & UX surface

- **MCP:** `auto_paint` — params `model_id`, `strategy`
  (`height_bands` | `components` | `cavity` | `recipe`; `auto` picks
  `recipe`→fallback), `axis` (for `height_bands`), `max_colors`,
  `session_id`, `dry_run` (returns the per-slot histogram + a render
  without committing). FS params (`use_full_spectrum`) reserved, rejected
  with a clear "deferred until FS is green" message until M3-equivalent.
  Image params (`image_base64`/`image_token`, `camera_descriptor`)
  reserved for M2. Registered with one `builder.tool(...)` line in
  `McpController.registerAllTools`, gated on
  `isCapabilityWired(LoadPaintState)`, session-aware.
- **XR:** a "Smart Paint" card — strategy picker, image picker (reuse
  the `FilesScreen` import flow + `runCatching{}.onFailure{Toast}` per
  the phone-shell crash-visibility rule), max-colors slider, **Preview**
  (render the proposed paint + per-color `GamutMatcher.classify` quality
  badge before commit), Apply / Refine / Undo. Every action mirrors an
  MCP tool per the MCP-foundation mandate.

## Milestones

Each is independently shippable and verified before the next.

- **M1 — Geometric auto-paint (this commit).** `AutoPaintEngine` with
  `height_bands` / `components` / `cavity`; `auto_paint` MCP tool;
  full-coverage guarantee; one-undo `LoadPaintState`; `dry_run`;
  capability gate; session support. No image, no API, fully on the
  green physical path. JVM-tested.
- **M2 — Projection core (shipped).** `RenderMode.TriangleId` per-view
  occlusion-correct pixel→tri (`AutoPaintImageEngine.project`) →
  per-triangle mean-color accumulation → perceptual CIEDE2000
  quantization via the extracted `ColorScience` → `finalizeCoverage`
  (diffuse + majority backfill) so the whole model is covered →
  one-undo `LoadPaintState`. `bestPresetBySilhouette` does
  zoom/translation-invariant silhouette-IoU camera auto-pick when no
  `camera_descriptor` is supplied. Wired into `auto_paint` as the
  image mode (`image_base64`/`image_token` + optional
  `camera_descriptor`/`background_color`). Single image → only the
  camera-facing side carries true color (honest B1); multi-image /
  off-axis-photo semantic transfer is M4. JVM-tested.
- **M4 — Semantic LLM transfer + automated score loop.** Render montage
  + target → Claude region map → existing vision tools → per-region
  color → quantize → paint session → `score_paint_against_reference` →
  bounded corrective loop. The "make it look like this photo" headline.
- **M3 (later, gated) — FullSpectrum gamut.** Unblocked only when
  `PeggyPaletteFullSpectrumParityTest` is green and FS Local-Z is
  hardware-verified. Flip the `GamutMatcher` blend parameter + predicted
  mix preview + experimental UI gate.

## Test plan

- **M1 (JVM, this commit):** `AutoPaintEngineTest` — full coverage
  (every triangle assigned a non-zero slot), determinism (same fixture →
  identical output across runs), slot bounds (`1..min(palette,
  MAX_PAINT_SLOTS)`), `height_bands` monotonic in Z, `components`
  assigns one slot per shell on a two-cube fixture, `cavity` flags a
  concave wedge. `AutoPaintToolTest` — schema shape, `dry_run` does not
  emit, live path emits exactly one `LoadPaintState` with the model's
  support/seam/fuzzy arrays carried through, capability-gate error.
- **M2+:** projection round-trip against a known-camera render; CIEDE2000
  parity with `GamutMatcherTest` after the `ColorScience` extraction.
- **Instrumented (`PeggyPaletteFullSpectrumParityTest`) is a precondition
  for any slicer-touching commit.** M1 does not modify libslic3r,
  slicing, or config — it only writes `paintFilamentIndex` through the
  existing `LoadPaintState` path that `paint_decal` already uses — so
  the green-PeggyPalette gate is satisfied transitively, but the
  instrumented suite requires a device and is not run in a headless
  session; that gap is called out in the commit.
</content>
</invoke>

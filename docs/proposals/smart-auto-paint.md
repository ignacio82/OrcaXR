# Smart Auto-Paint — design proposal

Status: **M1 + M2 + M3 + M4 shipped**, plus **5 ideas borrowed from
`taylormadearmy/u1-slicer-for-android`** (see "Borrowed ideas" below) —
`auto_paint` + `auto_paint_from_reference` + `auto_paint_label` MCP
tools. M3 (FullSpectrum) is **experimental, opt-in**
(`use_full_spectrum=true`): its gate "green PeggyPalette" is now
satisfied (re-gated by `1b4ef8b` onto per-tool MODEL extrusion ±2%,
device-GREEN 2026-05-16); the FS Local-Z engine port is
software-verified (patches 0067 + `MixedFilamentWireFormatTest`) with
only the Snapmaker U1 hardware print pending. Roadmap home: **D20**
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
   The `PeggyPaletteFullSpectrumParityTest` gate is GREEN (the "+5.4%"
   was a stale *total*-filament-mm artifact; `1b4ef8b` re-gated onto the
   real per-tool MODEL ±2% invariant). FS therefore ships as M3 but
   stays **experimental + opt-in** (`use_full_spectrum=true`) —
   physical-only remains the always-correct default, and the Snapmaker
   U1 hardware print is the one remaining FS validation step.

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
     physical-only:  nearest physical PaletteSlot (ColorScience)
     FullSpectrum:   FullSpectrumGamut extended palette → FsPaintSupport
                     materializes virtual rows  [M3, experimental]
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
**Shipped (M3)** exactly as predicted: `FullSpectrumGamut` reuses
`GamutMatcher.enumerateGamut` (physical + pigment-mixer-predicted
blends) to build a wider `PaletteSlot` list; the unchanged engines
quantize against it; `FsPaintSupport` materializes the chosen blends
into virtual `MixedFilamentEntry` rows (same `ensureBlendRow` semantics
+ per-printer store seam as `applyGamutMatches` / "Match to my
filaments", `8e462e0`) and reports the predicted printed colours. No
architectural rework — a wider palette was the entire mechanism.

## Tool & UX surface

- **MCP:** `auto_paint` — params `model_id`, `strategy`
  (`height_bands` | `components` | `cavity` | `recipe`; `auto` picks
  `recipe`→fallback), `axis` (for `height_bands`), `max_colors`,
  `session_id`, `dry_run` (returns the per-slot histogram + a render
  without committing). `use_full_spectrum=true` (M3, experimental) is
  honored on the color-matching modes (image / label / reference) and
  degrades to physical-only with a stated reason elsewhere. Image
  params (`image_base64`/`image_token`, `camera_descriptor`) shipped
  in M2. Registered with one `builder.tool(...)` line in
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
- **M4 — Semantic LLM transfer + automated score loop (shipped).**
  `auto_paint_from_reference`: render the model view → one vision call
  for a paint plan (`base_color` + accent `regions` with polygons) →
  `SemanticPaintPlanner` resolves it (base fills the whole model incl.
  the unseen back; region polygons reverse-project to triangles via
  `AiMaskProjection`, CIEDE2000-quantized through `ColorScience`) →
  render the candidate → grade it against the reference (the same
  two-image {score,comment,regions[]} contract as
  `score_paint_against_reference`) → bounded loop (≤5) that feeds the
  critique back and keeps the highest-scoring attempt (monotonic) →
  one-undo `LoadPaintState`. Injectable `VisionApiClient` (JVM-tested
  with a fake; the planner is pure and tested standalone). The "make
  it look like this" headline. Honest scope: a single reference view
  colors the camera-facing accents; base covers the rest.
- **M3 — FullSpectrum gamut (shipped, experimental).** The gate is met:
  `PeggyPaletteFullSpectrumParityTest` is GREEN (re-gated by `1b4ef8b`
  onto the real per-tool MODEL-extrusion ±2% invariant — the old
  "+5.4% T1" was a *total* filament-mm delta that counted purge and
  flagged OrcaXR's superior flush-minimiser as a regression), and the
  FS Local-Z engine port is software-verified (patches 0067 +
  `MixedFilamentWireFormatTest`); only the Snapmaker U1 hardware print
  remains. `FullSpectrumGamut` (pure) extends the quantizer palette
  with `GamutMatcher`-enumerated, pigment-mixer-predicted blend
  candidates; `FsPaintSupport` materializes the blends the engine
  actually picked into virtual `MixedFilamentEntry` rows via the same
  per-printer store seam "Match to my filaments" (`8e462e0`, in `main`)
  already ships, remaps the painted ids to the real `physicalCount + k`
  virtual ids, and reports predicted colours. Opt-in
  (`use_full_spectrum=true`) on the color-matching modes (`auto_paint`
  image, `auto_paint_label`, `auto_paint_from_reference`); degrades to
  physical-only with a stated reason when there's no active printer; a
  blend that can't fit `MAX_PAINT_SLOTS` falls back to its nearest
  physical slot so the paint is always sliceable. The engines were
  **not** changed — a wider palette is the entire mechanism (the "FS
  drop-in seam" the design predicted).

## Borrowed ideas (from `taylormadearmy/u1-slicer-for-android`)

Their "Smart Paint" is a deterministic segmentation cascade where the
AI is opt-in and decorative — the opposite philosophy to our M4. Five
ideas were worth taking; all shipped, physical-only, JVM-tested:

1. **Metadata-aware prioritized cascade** — `AutoPaintCascade`: respect
   the model's existing per-triangle paint (`paintFilamentIndex`, e.g.
   an MMU/SEMM 3MF) → else shells → else geometry. `auto`/`cascade` is
   now the default `auto_paint` strategy. Exploits structure we already
   have instead of always height-banding; zero API cost.
4. **Confetti / robustness guard** — folded into the cascade's
   components branch: shells below `MIN_COMPONENT_FRACTION` are absorbed
   into the largest shell and distinct shells are capped to the palette
   size, so a decimated / high-fragmentation mesh can't explode into
   hundreds of one-triangle colors (their B113 lesson). PaintState also
   majority-backfills any fully-occluded unpainted island (their B111
   "never ship a partial mesh" lesson). We were already structurally
   safe from B111 proper (paint arrays are sized to the derived-STL tri
   count, committed on the real mesh — we never subsample).
5. **Report segmentation source + alternate** — the cascade result
   carries `source`, `alternate_source`, and `branches_available`,
   surfaced in the `auto_paint` tool body so an agent can reason about
   or override the choice.
2. **No-spatial-grounding AI mode** — `auto_paint_label`: their fix32
   pivot proved vision models are unreliable at returning regions but
   reliable at *naming what they see*. So this tool segments
   deterministically (the cascade), renders a plain + a region-banded
   view (same camera), and asks the model only to NAME each region and
   suggest a colour (text task); colours are CIEDE2000-quantized via
   `ColorScience`. AI is decorative: with no provider/key or on a parse
   failure the deterministic colours are committed anyway
   (`ai_used=false`). Complements M4 (which is right *with* a reference
   image); this is the robust no-target path.
3. **Multi-provider, free-tier-first vision client** —
   `MultiProviderVisionClient` implements the existing `VisionApiClient`
   seam (tools keep building Anthropic-shaped requests; it translates
   to/from the provider wire format) for Claude / Gemini (free, 3-model
   fallback chain) / OpenAI / OpenRouter / Pollinations (free, key
   optional). Lifts the Anthropic-key-only gate; injectable HTTP for
   tests; honors the shared `VisionRateLimiter`.

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

# OrcaXR Design Notes

Living document. UX spec, architectural decisions with rationale, and
measurements from real hardware. Grows as we build.

---

## Phase 1 final blocker + fix (2026-04-25): SpatialPanel needs Full Space

End of Phase 1: app installed and launching cleanly on the Galaxy XR
but the SpatialPanel rendered as a **solid black rectangle with system
chrome (window/min/close icons) at the top** — Compose composed,
activity stayed alive, no exceptions, `openXrFirstFrameSubmitted=false`
in WindowManager logs.

Root cause turned out to be a Jetpack XR API contract that is
under-documented at v1.0.0-alpha12: **a `Subspace { SpatialPanel { … } }`
hierarchy does not render its 2D content surface while the activity
is still in Home Space mode.** The panel frame appears, system chrome
is drawn, but content is empty until the activity transitions to Full
Space.

Fix is two lines:

```kotlin
LaunchedEffect(session) {
    runCatching { session.scene.requestFullSpaceMode() }
}
```

Plus a `MovableComponent.createSystemMovable(session, true)` on the
root `GroupEntity` so the panel doesn't spawn off to the side of the
user's gaze (activity-space origin is wherever the system was facing
when Full Space was created).

A common pattern to sidestep this is to render regular 2D Compose in Home Space and only spin up the Subspace + SpatialPanel when transitioning into Full Space. We don't need the dual-mode flexibility yet, so we request Full Space at startup.

Documented in `GEMINI.md` "Jetpack XR rendering gotchas" so the next session doesn't re-derive it.

## UX constraints

These are load-bearing for every screen we design.

1. **Dense parameter UIs do not survive a VR port.** OrcaSlicer's desktop
   settings tree (hundreds of fields) cannot be reproduced on a SpatialPanel.
   Design around presets and direct manipulation, not forms.
2. **Sub-mm precision from hand tracking is not available** on Galaxy XR /
   Quest 3 in 2026 (~1cm jitter at arm's length). Precision comes from
   software — snap grids, angle constraints, numeric entry via an alternate
   input path.
3. **Numeric entry on Galaxy XR is fine.** Galaxy XR's system keyboard uses gaze + pinch (same model as Vision Pro) and Compose `TextField` Just Works. Trade-offs that remain are scale-of-typing concerns (200-field forms are tedious at any speed), not fundamental input blockers. Design rule: profiles-first so users rarely type; standard Compose forms when they do.
4. **Panels cost attention budget.** A standard panel is approximately 1792×1008 dp at ~1.75 m, 5° below eye level, with interactive content in the central 41° FOV.
5. **Empty `SpatialPanel` entities still block raycasts.** Remove from
   composition rather than just hiding.

---

## Architectural decisions (with rationale)

Empty until Phase 0 produces decisions. Each entry: what, why, date,
revisit-if.

---

## Dependency build matrix (OrcaSlicer v2.3.2)

Ground truth: `third_party/OrcaSlicer/src/libslic3r/CMakeLists.txt` lines
576–606 (`target_link_libraries(libslic3r …)`). OrcaSlicer's own
`deps/` bootstrap builds most of these for desktop — we try that first with
an NDK toolchain before vendoring anything ourselves.

### Required for libslic3r core (must cross-compile)

| Category | Libs |
|---|---|
| Header-only (trivial) | admesh, libigl, libnest2d, cereal, Eigen, qoi, semver |
| Pure C (trivial) | miniz, glu-libtess, JPEG, PNG, ZLIB, OpenSSL::Crypto, EXPAT, FREETYPE |
| C++ / CMake (usually fine) | Boost (filesystem/thread/locale/iostreams/regex), Clipper/Clipper2, Draco, TBB, qhull, mcut, libnoise, OpenCV (world), libslic3r's bundled `clipper` + `libnest2d` |
| Painful on Android | **CGAL** (via GMP/MPFR), **OCCT** (27 TK* libs — STEP import + CAD booleans), **OpenVDB** (conditional — skip for Phase 0) |

### Skippable (GUI / network / OpenGL only, not linked by libslic3r)

wxWidgets, GLEW, GLFW, OpenCSG, WebView2, CURL (with flag). Explicitly
**drop these from `deps/` when building for Android** to cut compile time
and avoid their transitive pain.

### Phase 0 compile flag starting point

To be passed through to OrcaSlicer's top-level CMake (some will be
bounced-through to `deps/`, some apply to `libslic3r` itself — verify as
errors surface):

```
-DSLIC3R_GUI=OFF
-DSLIC3R_STATIC=ON
-DSLIC3R_BUILD_SANDBOXES=OFF
-DSLIC3R_BUILD_TESTS=OFF
-DBUILD_TESTING=OFF
-DCMAKE_TOOLCHAIN_FILE=$ANDROID_HOME/ndk/29.0.14206865/build/cmake/android.toolchain.cmake
-DANDROID_ABI=arm64-v8a
-DANDROID_PLATFORM=android-31
```

---

## Measured baselines

Populated from Phase 0 onward. On-device numbers only — emulator numbers
clearly labeled as such. Always record: device, build type, date.

| Metric | Value | Device | Build | Date |
|---|---|---|---|---|
| 20mm cube slice p50 | 807 ms | Samsung Galaxy XR (SM-I610), arm64-v8a, API 34 | debug, NDK 29.0.14206865 | 2026-04-26 |
| 20mm cube slice p95 | 862 ms | "" | "" | "" |
| 20mm cube slice max | 862 ms | "" | "" | "" |
| 20mm cube peak RSS | 262 MB | "" | "" | "" |
| 10× slice thermal delta | 1.1 °C | "" | "" | "" |
| 10× slice failures | 0 / 10 | "" | "" | "" |

Methodology: `BaselineBenchTest.cubeSliceTenRunsBaseline` —
sequential `SlicerEngine.slice` calls of `cube_20mm.stl` against
`minValidConfig` (libslic3r `full_print_config()` defaults plus
`before_layer_change_gcode = "G92 E0\n"` to satisfy
`Print::validate()` under forced relative-E). RSS read from
`/proc/self/statm` after each slice. Thermal delta = max per-zone
change across all readable `/sys/class/thermal/thermal_zone*/temp`
between run 1 and run 10. The 20 mm cube is tiny — these numbers
are a regression-detection floor, not a representative slicing
workload. Repeat with a Benchy / colored dragon for production
performance characterization.

---

## Open UX explorations (not decisions — sketches)

- **Layer scrubbing as a 3D spatial slider** — user's hand grabs a handle
  on the toolpath preview, moves up/down through layers. Natural mapping:
  spatial height ↔ layer height. Potential issue: fatigue for models with
  hundreds of layers.
- **Profile cards instead of a settings dialog** — filament × printer ×
  quality as a visual grid of cards, not a dropdown-heavy form.
- **Constraint-based placement** — model snaps to bed origin / center /
  edges; free placement is opt-in, not default.
- **FullSpectrum mixed-color as the showcase visualization** — the
  alternating-layer color banding is genuinely more interesting to *see*
  in 3D than to describe in text. Lean into it in marketing/demo reels.

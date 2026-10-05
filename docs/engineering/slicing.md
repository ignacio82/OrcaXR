# Current engine constraints

Maintained technical context from [GEMINI.md](../../GEMINI.md).
The production source is Snapmaker v2.3.4; retired Android implementation
notes live in [the historical archive](../historical/android-slicer-notes.md).
Code paths below are relative to the repository root.

## Upstream slicer strategy

- **Parity/production base:** Snapmaker OrcaSlicer v2.3.4, exact commit
  `9fd12ffb2b1b80c9fb4c14564754d2ec1573a626`. Browser WASM, Node/WASM,
  native server CLI, parity extraction, and oracles must name this same revision.
- `third_party/SnapmakerOrca` is a developer source checkout. Truth tooling reads
  exact Git blobs at the pinned commit and never trusts its dirty worktree.
  The wave-overhang settings test reconstructs `PrintConfig.cpp` from that blob
  plus the tracked WASM port patch in a temporary directory. It does not skip on
  clean clones or use an unrelated local wave-port version as its authority.
- `wasm/artifact-provenance.json` records the engine revision, aggregate build-
  input hash, output hashes, and the only tracked published copies:
  `wasm/dist` and `web/public/slicer`. `npm --prefix wasm run verify:artifacts`
  fails on source/patch or copy drift. A hash match proves provenance consistency,
  not a clean source rebuild; the manual container source-build gate remains.
- Build the engine with **Emscripten 6.0.2** exactly: the published `slic3r.mjs`
  glue is byte-identical to its output, so a rebuild that leaves the glue unchanged
  used the right toolchain. Commit engine edits in the fork and regenerate
  `wasm/patches/snapmaker-fork-wasm-port.diff` commit-to-commit, never from the
  worktree. A republished engine updates the canonical manifest, its adjacent
  copies in `wasm/dist` and `web/public/slicer`, and the hash literal in
  `web/src/slicer/pinnedEngineProvenance.ts` together (`security:check` fails on
  a stale pin). Full recipe: `wasm/patches/README-snapmaker.md`.
- The old upstream-v2.3.2 Android submodule/patch history in the linked archive is retained only
  for the retired native-Android implementation. It is not the web parity source
  and must not drive new browser/server behavior.


## Native Android dependency feasibility

The current-engine dependency harness is `tools/native-engine/`. It starts from
exact commit `9fd12ffb2b1b80c9fb4c14564754d2ec1573a626` in a fresh detached
worktree, applies the tracked Android dependency patch with index checks, and
compares the resulting diff with that patch before reuse. The developer checkout
is read only. A clean runner can fetch the same commit into an owned bare cache.
Recipe fingerprints include the build script, patch and probe sources; different
recipes get separate source/build directories. The shared archive cache validates
SHA-256 before use, refuses corrupt entries, and bounds new downloads. A file lock
serializes builds and protects readers from incomplete packages.

**This harness currently builds TBB and dependency probes only.** It does not
compile libslic3r, implement a native slicing adapter, revive the retired Android
engine, or change browser/server engine provenance. Do not run
`scripts/build_native.sh` for this target: that script resets and patches the
retired upstream-v2.3.2 checkout. The new engine must preserve the current
configuration, project and output identities through its eventual adapter.

The selected source recipe uses oneTBB **2021.5.0**, archive SHA-256
`83ea786c964a384dd72534f9854b419716f412f9d43c0be88d41874763e7bb47`.
NDK **29.0.14206865** actually reports **Clang 21.0.0** in this installation;
older historical notes calling that NDK Clang 19 are not current toolchain
identity. Both targets use API 31 and `c++_shared`. The local clean builds used
CMake 4.2.3 and Ninja 1.13.2; the probe project requires CMake 3.22 or newer.

The clean build established these required port changes:

- The dependency superbuild unconditionally requires desktop OpenGL/GLEW before
  configuration can complete. Its Android branch omits desktop OpenGL/GLFW/
  OpenCSG/wxWidgets targets, while retaining the geometry dependency graph.
- Every nested CMake build receives the chosen ABI, API level and STL. Otherwise
  the NDK toolchain can choose its default ABI/API independently of the parent.
  The target install prefix is added to `CMAKE_FIND_ROOT_PATH`; host library
  lookup is not enabled with `BOTH`. Nested CMake compiler jobs have an explicit
  cap independent of upstream recipes overwriting `NPROC`.
- TBB's legacy NDK libc++ copy path no longer exists. The patch uses the pinned
  toolchain's sysroot and `CMAKE_LIBRARY_ARCHITECTURE` instead.
- oneTBB explicitly warns that its static runtime is unsupported. This candidate
  builds shared `libtbb.so` and `libtbbmalloc.so`. It leaves the real allocator and
  parallel algorithms intact; no libc allocator wrapper or serial TBB shim is
  installed.
- NDK linking rejects absent exact private-symbol entries in TBB's allocator
  version script. Those optional private names become local wildcard patterns;
  the public exports and the linker's undefined-symbol/version checks remain
  enforced. The glibc-specific malloc-interposition proxy is excluded on Android;
  libslic3r's dependency contract links the allocator explicitly.

The engine's other dependencies are **not qualified by this patch**. In
particular, GMP/MPFR still need an audited Android autotools compiler/host setup,
Boost/CGAL/OpenVDB/OpenCV/OCCT need actual cross-build and runtime evidence, and
the old OpenSSL/curl recipes need a deliberate dependency/support review before
packaging. The current libslic3r sources include OpenSSL MD5 support; network I/O
belongs in platform adapters, so do not blindly bring the old desktop curl/TLS
stack into the native engine. Do not invoke the entire upstream `deps` target and
assume these unported recipes honor the CMake job cap: some use independent
unbounded `make -j` commands. The new harness explicitly builds `dep_TBB`.

Run with `ANDROID_HOME` set:

```sh
python3 tools/native-engine/build-dependency-probes.py
python3 tools/native-engine/build-dependency-probes.py --verify-only
python3 tools/native-engine/test-dependency-package.py
python3 tools/native-engine/emulator-probe.py
```

The default build is sequential across arm64-v8a and x86_64, with one compiler
job and `nice -n 10`. `--abi` selects an initial ABI; `--jobs` allows an explicit
1–4 compiler cap. Each package contains the probe executable, both TBB shared
libraries, the pinned NDK libc++ shared library and a manifest. Verification
checks source/recipe/compiler identities, every file hash and length, ELF machine
and 16 KB load alignment, absence of build-directory runtime paths, and closure
of all non-platform `DT_NEEDED` dependencies. Packages remain ignored build
artifacts. They are not APKs or release distributions.

The native probe uses the actual TBB C API and C++ task runtime. Each process
runs 16 rounds of 512 allocations/reallocations with byte-pattern checks, frees
those blocks on separate native threads, checks 20 aligned allocations across
64/4,096/16,384/65,536-byte alignments, and exercises nested task-group/parallel-for
and parallel-reduce work on 1,000,003 items. Its four-thread cap belongs only to
this synthetic probe; it must not become a libslic3r scheduling policy. The
historical engine task graphs could deadlock under inappropriate thread caps.

The emulator runner refuses an occupied port, owns a fresh API 34 x86_64 emulator
on port 5586, verifies hashes of all four files after copying them to a unique
test directory, and executes the probe three times. It records the exact
package-manifest identity and runner hash, then terminates only its own emulator.
No physical device is used. A verified ELF alignment does not prove loading on
a 16 KB device, and x86_64 runtime success does not prove the historical arm64
allocator or painted-segmentation problems are absent.

Local evidence on 2026-10-05:

- Clean builds and package verification pass for both ABIs: eight ELF files in
  total, including the two executables. Reuse verification also passes.
- Seven tests mutate real packages and reject wrong ABI, 4 KB ELF alignment,
  byte drift, missing/extra libraries, incorrect metadata/recipe and a deliberately
  changed `DT_NEEDED` library even when its new file hash agrees with the manifest.
- Three native emulator processes report TBB interface **12050**, **4,096-byte**
  pages and all allocator/task checks passing. Their observed elapsed durations
  were 575.87 ms, 1351.15 ms, 788.90 ms. These are diagnostic runs, not device performance budgets.
- Recipe identity: `2297578ae071ee09c7f8b88947d439cd506c00e03db1e3040147f58445ab3837`.
  Executed package-manifest SHA-256: `0a6be9ff8dc242d34aff9d8012b2e037ffea23525572f06564c64afadd8787da`.

A repeat recipe build initially waited on a duplicate GitHub download. That
build eventually completed; the waiting runner rejected the package after the
build script changed its recipe identity. The revised shared-cache build and
runtime run passed from fresh source/build directories. No running build was
mistaken for a completed one, and source hashes or test requirements were not
relaxed to work around the fetch delay.

The native CI workflow now includes these dependency builds, package mutation
tests and emulator checks as a separate job, with manifests/reports retained as
artifacts. Local results do not claim a completed hosted CI run. Complete native
engine compilation, the JNI/process adapter, canonical fixture slices, output
comparison, arm64 execution, 16 KB device loading and supervised XR/printer
qualification remain open. None of Phase 2's engine checklist or exit is closed
by a dependency probe.


8. **3MF loader dispatch is BBS-leaning and breaks on Prusa / MakerWorld files.** Use `Model::read_from_archive` which sniffs Prusa-vs-BBS. In browser imports, official BBS multi-plate membership lives in `Metadata/model_settings.config` as `(object_id, instance_id)` pairs; core `<build>` transforms use the global 1.2×-bed plate grid, so resolve exact membership and `printable_area` or fail closed, then subtract the source origin. Canonical transforms stay plate-local; only standard BBS export re-adds that virtual origin. Never guess from thumbnails or spatial clusters. Production-extension `p:path` IDs are model-part-local: key references by normalized package path plus ID, permit external paths only from the root model, recursively compose same-part child components including repeats, and reject missing/conflicting paths or IDs, traversal, cycles, depth over 64, and expansion over 16,384 nodes. Do not preserve original split `.model` members: the generated flattened core absorbs them, so keeping them stores the geometry twice and leaves a stale copy behind (see the large-model section). Remove `p:path` from that generated core, and let the relationship projection drop the now-dangling targets. A read-only `MarbleRunTube_V7.3mf` smoke resolved 26 external parts into 5 plates/28 objects/29 volumes/28 instances and passed in-memory canonical save/reopen; this is headless evidence, not official GUI qualification. Do not add a blanket affine-shear rejection: that real Orca archive contains such build matrices, while arbitrary shear remains an explicit residual of the canonical TRS projection.

19. **PrintConfig collection delimiters are type-dependent.** Every `coStrings`
    option uses `;`; every other vector option uses `,`. A comma-joined color
    list parses as one color and can silently shrink the engine's filament
    count—the trigger for patch 0075 (see 19d). Web's shared
    `web/src/settings/configSerialization.ts` classifier is used by ConfigIO
    and ProfileLoader; its 26 unique `coStrings` keys are checked against all
    174 generated PrintConfig vector definitions; direct overrides follow it too.

19b. **`coord_t` is `int64_t` but `size_t` is 32-bit on wasm32 — `some_vector.size() - 1` assigned to a `coord_t` underflows to `+4294967295`, not `-1`.** This is the WASM slicer's #1 crash class: `SkeletalTrapezoidation::interpolate` (Arachne) did `for (coord_t next_inset_idx = left.toolpath_locations.size() - 1; next_inset_idx >= 0; …)`. When `left` is an empty beading (thin feature → `bead_count 0` → `compute()` returns empty vectors), `0u - 1` is a 32-bit `0xFFFFFFFF` that **zero-extends** into the signed 64-bit `coord_t` as `+4294967295`, so the loop runs and indexes `toolpath_locations[4294967295]` → `RuntimeError: memory access out of bounds` inside `propagateBeadingsDownward`. On 64-bit builds `size_t` is 64-bit so `0-1` → `-1` and the loop is skipped — which is why native Android/desktop never hit it while the WASM slicer crashed on essentially **every** model with a thin region (3DBenchy, logos). Fix: `coord_t(v.size()) - 1` (cast to signed before subtracting). Shipped as `patches/0074-arachne-32bit-size-underflow-oob.patch`. **When auditing the WASM port for crashes, grep for `.size() - 1` / `.size()-1` feeding a signed `coord_t`/`int` index and any other 32-bit-vs-64-bit width assumptions.** **ENGINE SWITCH (2026-07-05): the WASM slicer now builds from the Snapmaker fork** — `third_party/SnapmakerOrca` (gitignored clone of Snapmaker/OrcaSlicer v2.3.4, FullSpectrum-native since 2.3.3), the SAME source the external slicer container's CLI builds, so web and CLI G-code match at the source level. After editing a libslic3r `.cpp`: `ninja -C third_party/SnapmakerOrca/build-wasm libslic3r`, then relink via `wasm/build_wasm_module_snapmaker.sh`, publish only `wasm/dist/{slic3r.mjs,slic3r.wasm}` and `web/public/slicer/`, and run `npm --prefix wasm run verify:artifacts`; the server image copies `wasm/dist` and `web/dist/slicer` is generated by the web build. Full from-clean rebuild recipe + working-tree snapshot: `wasm/patches/README-snapmaker.md` + `snapmaker-fork-wasm-port.diff` (Emscripten gates, Arachne 0074 fix, `init_filament_option_keys()` ctor fix, `normalize_fdm` null-guard, `append_full_config` gate — the fork shares those bugs with upstream; the 0075 BBS multi-extruder OOB family does NOT exist in the fork's older ToolOrdering). The old upstream-v2.3.2 port (patches 0001-0075 + `wasm/build_wasm_module.sh`) is the retired Android implementation, not the current native baseline; its wasm build assets were reclaimed by `build_native.sh`'s clean (`wasm/patches/wasm-port-tracked-changes.diff` snapshots it if ever needed again). **FullSpectrum project slicing is LIVE in the web engine**: `startSliceProject` + `SlicerClient.sliceProject` slice a loaded FS 3MF as-authored (embedded mixed_filament_definitions, per-part virtual extruders) — PeggyPalette produces 294 layers / 296 tool changes / T0-T3 in ~43 s (Node) and in-browser. `OrcaWorkspace.sliceNow` now captures the live canonical state, serializes the active plate to BBS 3MF through `CanonicalWorkspaceSlicer`, and publishes only a revision/project-hash/asset-hash guarded browser-WASM result. Scene-baked STL and immutable raw-source fallbacks were deleted; configured external slicing requires independently verified engine-provenance attestation on the captured connection generation.

19c. **Do NOT precache the slicer WASM in the PWA service worker — serve `/slicer/` NetworkFirst.** `web/vite.config.ts`'s VitePWA once raised `maximumFileSizeToCacheInBytes` to 20 MB specifically to precache the ~16 MB `slic3r.wasm` cache-first. That pins a stale engine: after a libslic3r fix rebuilds the wasm, the browser's SW keeps serving the OLD binary, so a slice **hangs forever with no progress and no error** on the outdated module (verified 2026-07-03 — node + a headless-browser slice of the fresh wasm both completed in ~13–17 s while the user's SW-controlled session hung). Fix in place: `workbox.globIgnores: ['**/slicer/**']` + a `NetworkFirst` `runtimeCaching` route for `/slicer/` (fresh when online, cached fallback for offline XR). **Gotcha within the gotcha:** in dev (`npm run dev`) VitePWA registers no SW, and dev serves the wasm with `Cache-Control: no-cache`, so dev itself is always fresh — BUT a SW registered by a *prior* `vite preview`/prod visit on the **same localhost origin** keeps controlling the page and serving stale cache, and the dev server won't replace it. If a web slice hangs at 0 % with a fixed wasm on disk, suspect a stale SW first: DevTools → Application → Service Workers → Unregister + Clear storage, then reload (on Galaxy XR Chrome: clear site data / `chrome://serviceworker-internals`). Validate SW behaviour against `vite preview` (which serves `sw.js`), not dev.

19e. **Instantiating the WASM engine costs ~256 MB and ten Web Workers, so nothing may instantiate it speculatively.** The build fixes `-sINITIAL_MEMORY=268435456` and `-sPTHREAD_POOL_SIZE=10`, and the emitted glue preallocates the whole pool inside `addOnPreRun` — so `factory()` does not resolve until a 256 MB **shared** heap is committed and ten Web Workers have loaded the module. Measured cold in Node (no renderer, no scene, no worker realms): **43 MB RSS → 244 MB in 149 ms.** In a browser, add the ten worker realms, and add a *second* full instance whenever a FullSpectrum project slices, because `sliceWorker.ts` builds its own — ~512 MB and ~22 workers in one renderer. `OrcaWorkspace.warmSlicerAfterFirstModel` used to call `slicer.load()` 1.2 s after **every** model import, which put that spike in the renderer already holding the freshly imported model, for an instance the primary (worker) slice route never even uses. Symptom: *"sometimes when I load a model the tab reloads and the model does not load"* — a renderer OOM-kill, which Chrome for Android answers by reloading the tab, discarding the unsaved model. The fix is `SlicerClient.prefetchEngine()`: the ~15 MB download is what actually made a first Slice feel slow, and it warms for free (stream the body, drain it a chunk at a time to commit it to cache, retain nothing, commit no heap). **Never warm an Emscripten module by instantiating it** — warm its bytes. Pinned by `src/slicer/__tests__/engine-prefetch.test.ts`. Note `INITIAL_MEMORY` cannot be lowered from JS: the wasm's imported-memory declaration carries `min=4096 pages`, so a smaller `WebAssembly.Memory` fails to link — changing it means a relink (which needs `third_party/SnapmakerOrca/build-wasm/libslic3r/libslic3r.a`, reclaimed by the last clean). Do NOT shrink `PTHREAD_POOL_SIZE` without device testing either: `sliceProjectSync` blocks the worker thread for the whole slice, so a pool too small to cover every thread libslic3r wants cannot grow and **deadlocks** rather than degrading.

package dev.orcaxr.app

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.Executors

/**
 * Outcome of a single [SlicerEngine.slice] call.
 *
 * libslic3r distinguishes a handful of failure modes via the JNI return
 * code; surface them as a sealed type so callers can react meaningfully
 * (retry, surface the message, fall back to a different preset, etc.)
 * without having to remember the magic numbers.
 */
sealed interface SliceResult {
    /** G-code was produced. [sizeBytes] is the on-disk size at [outputPath]. */
    data class Success(val outputPath: String, val sizeBytes: Long) : SliceResult

    /** libslic3r reported a known failure mode. [code] is the raw JNI rc. */
    data class NativeError(val code: Int, val message: String) : SliceResult
}

/**
 * Receives progress ticks from libslic3r during [SlicerEngine.slice].
 *
 * Invoked from a libslic3r worker thread (the JNI shim attaches to the
 * JVM behind the scenes) — implementations must be thread-safe and
 * cheap. Update UI state via a `MutableState` / channel; don't block
 * the callback. Native side throttles consecutive duplicates of
 * (percent, message) so this fires only on real change.
 *
 * [percent] is 0..100 or -1 if libslic3r doesn't have a number to
 * report yet. [message] is libslic3r's UTF-8 status string (often
 * empty for early ticks).
 */
fun interface SlicerProgressListener {
    fun onProgress(percent: Int, message: String)
}

/**
 * Kotlin bridge to libslic3r over JNI.
 *
 * libslic3r is not safe to invoke concurrently from the same process —
 * each call mutates a `Slic3r::Print` instance whose internal state
 * crosses TBB workers, and several of its global config / preset caches
 * are not lock-protected. All external entry points serialize through a
 * single background thread (native calls serialized on a single dispatcher).
 *
 * Do not call from the UI thread; do not call from arbitrary threads
 * (use the [slice] suspend function — it dispatches for you).
 */
object SlicerEngine {
    init {
        System.loadLibrary("slic3r_jni")
    }

    /**
     * Metadata for a single object within a 3MF archive.
     */
    data class ObjectMeta(
        val name: String,
        val facetCount: Int,
        val bboxX: Float,
        val bboxY: Float,
        val bboxZ: Float,
        val defaultExtruder: Int,
        val instanceCount: Int,
        val offsetX: Float,
        val offsetY: Float,
        val offsetZ: Float,
        /** 1-based plate index from the BBS 3MF metadata. Standard
         *  (non-BBS) 3MFs and 3MFs without plate metadata return 1
         *  for every object — caller treats that as "single plate". */
        val plateIndex: Int,
    )

    private val dispatcher: CoroutineDispatcher =
        Executors.newSingleThreadExecutor { r -> Thread(r, "OrcaXR-libslic3r") }
            .asCoroutineDispatcher()

    /**
     * Slice [stl] into [outGcode], applying [config] key/value pairs on
     * top of libslic3r's `full_print_config()` defaults. Both files
     * must be real on-disk paths (not content:// URIs — libslic3r
     * reads via fopen). Unknown / malformed config keys are skipped
     * with a log line, not fatal.
     *
     * If [onProgress] is supplied it will be invoked from libslic3r's
     * status callback (a TBB worker thread) with `percent` (0..100, or
     * -1 if unknown) and the libslic3r status message. The callback
     * fires on a background thread — dispatch to the UI thread inside
     * the lambda if you're updating Compose state.
     *
     * Returns [SliceResult.Success] with the produced file's size on
     * the happy path, or [SliceResult.NativeError] on failure.
     *
     * Suspends on the libslic3r dispatcher; safe to call from any
     * coroutine context.
     */
    suspend fun slice(
        stl: File,
        outGcode: File,
        config: Map<String, String> = emptyMap(),
        /**
         * FullSpectrum virtual-filament remap. Length matches the
         * project's filament slot count. Entry i = 0 for "no remap" or
         * K>0 for "remap project filament (i+1) onto virtual mixed
         * filament K (= num_physical + K)". Default null = no remap.
         * Placed before [onProgress] so callers using the trailing-
         * lambda syntax for progress callbacks keep working without
         * named arguments.
         */
        virtualRemap: IntArray? = null,
        /**
         * Phase J in-XR painting. Per-triangle filament-slot index for
         * the source mesh's first volume. Length = source mesh triangle
         * count. Entry i = 0 means "unpainted, use default", i = 1..32
         * means "tag triangle i with that filament slot in
         * `mmu_segmentation_facets`." Default null = no paint authored;
         * embedded 3MF facets are preserved. Authored facets OVERWRITE
         * embedded ones at slice time — the user's in-XR paint is the
         * source of truth. See `docs/PHASE_J_PAINTING_PLAN.md` §4.6.
         */
        paintFilamentIndex: ByteArray? = null,
        /**
         * Phase XR_OBJ_4 — user-authored extra volumes attached to the
         * loaded model's first ModelObject. These are the volumes the
         * Compose UI's "Add Part / Add Modifier / Add Negative Volume
         * / Add Support Enforcer-Blocker" flow appended to the
         * selected [PlacedModel.volumes]. Each contributes its own
         * mesh + ModelVolumeType + per-volume transform. Default empty
         * = no extras (existing single-mesh behavior).
         *
         * Source meshes use libslic3r's mesh-container loader, so STL
         * / 3MF / AMF / OBJ / STEP all work. For 3MF / AMF, only the
         * first object's first volume's mesh is taken.
         */
        extraVolumes: List<PlacedVolume> = emptyList(),
        /**
         * Phase XR_OBJ_8 — per-triangle support paint state. Sized to
         * the source mesh's first volume's triangle count. Entry i is:
         *   0 = unpainted (auto-support pipeline decides)
         *   1 = ENFORCER (force a support pillar)
         *   2 = BLOCKER (forbid supports)
         * Authored onto `mv->supported_facets` BEFORE Print::apply.
         * Default null = no authored support paint; embedded 3MF
         * facets pass through unchanged.
         */
        supportFlags: ByteArray? = null,
        /**
         * Phase XR_OBJ_8 — per-triangle seam paint state. Same shape
         * as [supportFlags] but flows into `mv->seam_facets`:
         *   0 = unpainted, 1 = ENFORCER (force seam here),
         *   2 = BLOCKER (forbid seam here).
         */
        seamFlags: ByteArray? = null,
        /**
         * Paint full-feature-parity — per-triangle fuzzy-skin paint.
         * Sized to the source mesh's first volume's triangle count.
         * Entry i is:
         *   0 = unpainted (smooth surface)
         *   1 = FUZZY_SKIN (roughened texture in this region)
         * Authored onto `mv->fuzzy_skin_facets` BEFORE Print::apply.
         * Default null = no authored fuzzy-skin paint; embedded 3MF
         * facets pass through unchanged.
         */
        fuzzySkinFlags: ByteArray? = null,
        /**
         * Paint full-feature-parity (Brim Ears) — flat float[4N] of
         * (x, y, z, head_radius) quads in mesh-local mm. Each quad is
         * one user-placed brim ear anchor. Null / empty = no authored
         * ears (the global brim_type still applies).
         */
        brimEars: FloatArray? = null,
        /**
         * Phase XR_OBJ_4 (final) — per-object config overrides. Sparse
         * SAFE_KEYS subset applied onto `model.objects.front()->config()`
         * before Print::apply. Mirrors OrcaSlicer's "Object Settings"
         * panel: per-object layer height, wall count, sparse infill
         * density, etc. Default empty = no overrides; the global
         * profile / [config] map decides everything.
         */
        objectConfigOverrides: Map<String, String> = emptyMap(),
        onProgress: ((percent: Int, message: String) -> Unit)? = null,
    ): SliceResult = withContext(dispatcher) {
        require(stl.exists()) { "STL not found: ${stl.absolutePath}" }
        require(stl.canRead()) { "STL not readable: ${stl.absolutePath}" }
        extraVolumes.forEach {
            require(it.source.exists()) { "extra volume not found: ${it.source.absolutePath}" }
            require(it.source.canRead()) { "extra volume not readable: ${it.source.absolutePath}" }
        }
        outGcode.parentFile?.mkdirs()
        outGcode.delete()

        val (keys, values) = if (config.isEmpty()) {
            emptyArray<String>() to emptyArray<String>()
        } else {
            config.keys.toTypedArray() to config.values.toTypedArray()
        }

        val listener: SlicerProgressListener? = onProgress?.let { cb ->
            SlicerProgressListener { p, m -> cb(p, m) }
        }

        // Phase XR_OBJ_4 — flatten extra volumes into parallel arrays
        // matching the JNI's expected shape. 12 floats per volume:
        // tx, ty, tz, rxDeg, ryDeg, rzDeg, sxPct, syPct, szPct,
        // mirrorXSign, mirrorYSign, mirrorZSign. Empty list → null
        // arrays so the JNI short-circuits the extras-attachment loop.
        val extraPaths: Array<String>? = if (extraVolumes.isEmpty()) null
            else extraVolumes.map { it.source.absolutePath }.toTypedArray()
        val extraTypes: IntArray? = if (extraVolumes.isEmpty()) null
            else IntArray(extraVolumes.size) { extraVolumes[it].type.nativeOrdinal }
        val extraTransforms: FloatArray? = if (extraVolumes.isEmpty()) null
            else FloatArray(extraVolumes.size * 12) { idx ->
                val v = extraVolumes[idx / 12]
                when (idx % 12) {
                    0 -> v.translateXmm
                    1 -> v.translateYmm
                    2 -> v.translateZmm
                    3 -> v.rotXDeg
                    4 -> v.rotYDeg
                    5 -> v.rotZDeg
                    6 -> v.scaleXPct
                    7 -> v.scaleYPct
                    8 -> v.scaleZPct
                    9 -> if (v.mirrorX) -1f else 1f
                    10 -> if (v.mirrorY) -1f else 1f
                    11 -> if (v.mirrorZ) -1f else 1f
                    else -> 0f
                }
            }

        // Phase XR_OBJ_4 (final) — flatten per-object overrides into
        // parallel arrays. Empty map → null arrays so the JNI side
        // skips the per-object apply loop entirely.
        val (objKeys, objValues) = if (objectConfigOverrides.isEmpty()) {
            null to null
        } else {
            objectConfigOverrides.keys.toTypedArray() to objectConfigOverrides.values.toTypedArray()
        }

        val rc = nativeSlice(
            stl.absolutePath,
            outGcode.absolutePath,
            keys,
            values,
            listener,
            virtualRemap,
            paintFilamentIndex,
            extraPaths,
            extraTypes,
            extraTransforms,
            supportFlags,
            seamFlags,
            fuzzySkinFlags,
            brimEars,
            objKeys,
            objValues,
        )
        if (rc != 0) {
            return@withContext SliceResult.NativeError(
                code = rc,
                message = when (rc) {
                    -1 -> "STL read failed or empty mesh"
                    -2 -> "Print::validate() rejected the input"
                    -3 -> "C++ exception during process / export_gcode"
                    -4 -> "unknown C++ exception"
                    else -> "unknown libslic3r error code $rc"
                },
            )
        }
        SliceResult.Success(outGcode.absolutePath, outGcode.length())
    }

    /** Returns a human-readable "libslic3r <version> [print config keys: N]" string. */
    suspend fun versionString(): String = withContext(dispatcher) {
        nativeVersionString()
    }

    /**
     * Per-input transform for [sliceMulti]. All offsets are in mm
     * relative to the bed center after the group auto-arrange.
     *
     * Phase XR_OBJ_2 widened this from 4 fields (XY translate + Z
     * rotation + uniform scale) to 12. Defaults preserve back-compat:
     * Z translate 0, X/Y rotation 0, per-axis scale = uniform `scalePct`,
     * mirror flags off. The C++ side accepts both 4-floats-per-input
     * (legacy) and 12-floats-per-input (new) shapes; this data class
     * only exposes the wider surface, so call sites that don't touch
     * the new fields produce a 12-floats-per-input array of mostly
     * defaults — the cost is 8 extra floats per model on a slice
     * (negligible against the GB of mesh data).
     */
    data class ModelPlacement(
        val translateXmm: Float = 0f,
        val translateYmm: Float = 0f,
        val translateZmm: Float = 0f,
        val rotXdeg: Float = 0f,
        val rotYdeg: Float = 0f,
        val rotZdeg: Float = 0f,
        val scalePct: Float = 100f,
        val scaleXPct: Float = scalePct,
        val scaleYPct: Float = scalePct,
        val scaleZPct: Float = scalePct,
        val mirrorX: Boolean = false,
        val mirrorY: Boolean = false,
        val mirrorZ: Boolean = false,
    )

    /**
     * Slice a list of [models] (each paired with a placement transform)
     * into one G-code at [outGcode]. Each input contributes one
     * ModelObject to a shared libslic3r Model; the group's bbox auto-
     * centers on the bed.
     *
     * Behaves the same as [slice] in every other respect — same
     * config map shape, same SliceResult contract, same dispatcher,
     * same throttled progress callback.
     *
     * Use this when the user has plated 2+ models. For exactly one
     * model, [slice] is more direct.
     */
    suspend fun sliceMulti(
        models: List<Pair<File, ModelPlacement>>,
        outGcode: File,
        config: Map<String, String> = emptyMap(),
        /**
         * Phase J in-XR paint state, parallel to [models]. Length must
         * match `models.size` when non-null; entry i = null means "no
         * paint for input i" (embedded 3MF facets pass through). The
         * authored byte array's length must equal the source mesh's
         * triangle count for that input. Default null = no paint at
         * all, which short-circuits the per-input paint walk on the
         * C++ side.
         */
        paintFilamentIndices: List<ByteArray?>? = null,
        /**
         * Optional 0-based `Model::objects` ordinal per input, parallel
         * to [models]. Length must equal `models.size` when non-null.
         * Used to re-route decomposed multi-object 3MFs (gotcha #21)
         * back to their original 3MF source: the input path points at
         * the original .3mf and this ordinal picks the matching
         * ModelObject so its painted volumes (`mmu_segmentation_facets`
         * / `supported_facets` / `seam_facets`) survive into the slice.
         * Pass -1 (or null entirely) for inputs whose source already
         * has the right object at index 0 (STLs, single-object 3MFs).
         */
        objectOrdinals: IntArray? = null,
        onProgress: ((percent: Int, message: String) -> Unit)? = null,
    ): SliceResult = withContext(dispatcher) {
        require(models.isNotEmpty()) { "sliceMulti requires at least one model" }
        models.forEach { (f, _) ->
            require(f.exists()) { "input not found: ${f.absolutePath}" }
            require(f.canRead()) { "input not readable: ${f.absolutePath}" }
        }
        require(paintFilamentIndices == null || paintFilamentIndices.size == models.size) {
            "paintFilamentIndices size ${paintFilamentIndices?.size} != models size ${models.size}"
        }
        require(objectOrdinals == null || objectOrdinals.size == models.size) {
            "objectOrdinals size ${objectOrdinals?.size} != models size ${models.size}"
        }
        outGcode.parentFile?.mkdirs()
        outGcode.delete()

        val paths = models.map { it.first.absolutePath }.toTypedArray()
        // Phase XR_OBJ_2: 12 floats per input. Order matches the C++
        // decode in slic3r_jni.cpp (tx,ty,tz,rx,ry,rz,sx,sy,sz, then
        // three mirror sign-bits as ±1f). When the user hasn't touched
        // the new TransformPanel knobs, the new fields default to
        // identity so the slicer behaves exactly as it did pre-Phase-2.
        val transforms = FloatArray(models.size * 12) { idx ->
            val placement = models[idx / 12].second
            when (idx % 12) {
                0 -> placement.translateXmm
                1 -> placement.translateYmm
                2 -> placement.translateZmm
                3 -> placement.rotXdeg
                4 -> placement.rotYdeg
                5 -> placement.rotZdeg
                6 -> placement.scaleXPct
                7 -> placement.scaleYPct
                8 -> placement.scaleZPct
                9 -> if (placement.mirrorX) -1f else 1f
                10 -> if (placement.mirrorY) -1f else 1f
                11 -> if (placement.mirrorZ) -1f else 1f
                else -> 0f
            }
        }
        val (keys, values) = if (config.isEmpty()) {
            emptyArray<String>() to emptyArray<String>()
        } else {
            config.keys.toTypedArray() to config.values.toTypedArray()
        }
        val listener: SlicerProgressListener? = onProgress?.let { cb ->
            SlicerProgressListener { p, m -> cb(p, m) }
        }

        // JNI signature takes a jobjectArray of jbyteArray (one per
        // model). null entries skip paint authoring for that input.
        // We always pass an array (sized to models.size) so the C++
        // index walk works the same whether or not paint exists; null
        // entries inside the array are the "no paint" signal.
        val paintsForJni: Array<ByteArray?>? =
            if (paintFilamentIndices == null) null
            else Array(models.size) { paintFilamentIndices[it] }
        val rc = nativeSliceMulti(
            paths,
            transforms,
            outGcode.absolutePath,
            keys,
            values,
            listener,
            paintsForJni,
            objectOrdinals,
        )
        if (rc != 0) {
            return@withContext SliceResult.NativeError(
                code = rc,
                message = when (rc) {
                    -1 -> "input read failed or empty mesh"
                    -2 -> "Print::validate() rejected the input"
                    -3 -> "C++ exception during process / export_gcode"
                    -4 -> "unknown C++ exception"
                    else -> "unknown libslic3r error code $rc"
                },
            )
        }
        SliceResult.Success(outGcode.absolutePath, outGcode.length())
    }

    /**
     * Read [input] (STL / 3MF / AMF / OBJ / STEP — anything libslic3r's
     * `Model::read_from_file` supports) and write a merged binary STL
     * to [outStl]. Used by the in-XR preview path so the existing
     * STL-only [StlReader] keeps working when the user opens a 3MF.
     * Slicing itself doesn't need this — [slice] reads the original
     * container directly via the same dispatcher.
     *
     * Returns true on success, false on any read/merge/write failure
     * (logged on the C++ side; JNI rc < 0).
     */
    suspend fun convertToStl(input: File, outStl: File): Boolean = withContext(dispatcher) {
        require(input.exists()) { "input not found: ${input.absolutePath}" }
        require(input.canRead()) { "input not readable: ${input.absolutePath}" }
        outStl.parentFile?.mkdirs()
        outStl.delete()
        nativeConvertToStl(input.absolutePath, outStl.absolutePath) == 0
    }

    /**
     * Phase XR_OBJ_3 — auto-orient a model via libslic3r's
     * `orientation::orient(ModelObject*)`. Returns the recommended
     * rotation as `[rotXDeg, rotYDeg, rotZDeg]` Euler angles, or null
     * when the JNI side errored (read fail / empty model / orient
     * threw).
     *
     * Pure analysis — no file written, no slice run. The caller writes
     * the result to `PlacedModel.rotXDeg/rotYDeg/rotZDeg` and the
     * existing re-preview LE picks up the change on the next compose
     * tick.
     *
     * Single-object orient is serial inside libslic3r (the parallel_for
     * site only fires for ≥2 inputs). Safe on Android arm64 without
     * extending patch 0014's TBB serial shim.
     */
    suspend fun autoOrient(input: File): FloatArray? = withContext(dispatcher) {
        require(input.exists()) { "input not found: ${input.absolutePath}" }
        require(input.canRead()) { "input not readable: ${input.absolutePath}" }
        nativeAutoOrient(input.absolutePath)
    }

    /**
     * Phase XR_OBJ_7 — pack [inputs] onto a [bedWmm]×[bedHmm] mm bed
     * via libslic3r's `arrange()` algorithm. Replaces the naive
     * left-to-right row layout in `PlacedModel.autoArrangeModels` for
     * non-trivial counts (8+ small parts pack tightly instead of
     * marching off-bed).
     *
     * [priorTransforms] is a parallel float[N*9] of (txMm, tyMm,
     * rotZdeg, sxPct, syPct, szPct, mirrorXSign, mirrorYSign,
     * mirrorZSign) that pre-positions each model. The sign bits feed
     * into the per-axis scale at apply time so mirrored objects
     * arrange against their visible silhouette (not the un-mirrored
     * one). v1 always re-packs from scratch — pinning is left for a
     * future pass.
     *
     * Returns float[N*3] of (txMm, tyMm, rotZdeg) per input, or null
     * on any failure (read fail / empty model / arrange threw). The
     * caller falls back to [PlacedModel.autoArrangeModels] on null.
     */
    /**
     * Phase XR_OBJ_5 — cut [input] along a horizontal plane at
     * [planeZmm] and write the resulting pieces as a multi-object 3MF
     * at [output]. [attrMask] selects which pieces to keep / flip /
     * place-on-cut. Returns true on success.
     *
     * Mirrors `libslic3r::Cut::perform_with_plane()`. The output 3MF
     * can be re-loaded via [SlicerEngine.slice] / the LOAD_3MF flow
     * and slices like any other 3MF — each piece is a separate
     * ModelObject the caller can plate independently.
     */
    suspend fun cutObject(
        input: File,
        output: File,
        planeZmm: Float,
        attrMask: Int,
    ): Boolean = withContext(dispatcher) {
        require(input.exists()) { "input not found: ${input.absolutePath}" }
        require(input.canRead()) { "input not readable: ${input.absolutePath}" }
        output.parentFile?.mkdirs()
        output.delete()
        nativeCutObject(input.absolutePath, output.absolutePath, planeZmm, attrMask) == 0
    }

    /** Phase XR_OBJ_5 cut attribute bitmask. Combine with `or`. */
    object CutAttr {
        const val KEEP_UPPER = 0x01
        const val KEEP_LOWER = 0x02
        const val FLIP_UPPER = 0x04
        const val FLIP_LOWER = 0x08
        const val PLACE_ON_CUT_UPPER = 0x10
        const val PLACE_ON_CUT_LOWER = 0x20
    }

    /**
     * Phase XR_OBJ_6 — boolean op between two meshes via libslic3r's
     * mcut backend. Output is a single-object 3MF whose lone volume
     * is the result. [op]: 0=Union, 1=Difference, 2=Intersection.
     * Returns true on success.
     *
     * Source instance poses are baked into the meshes before the
     * boolean — without this, two cubes loaded from the same STL
     * coincide at origin and Difference produces empty output.
     */
    suspend fun meshBoolean(
        a: File,
        b: File,
        op: Int,
        output: File,
    ): Boolean = withContext(dispatcher) {
        require(a.exists() && a.canRead()) { "A not readable: ${a.absolutePath}" }
        require(b.exists() && b.canRead()) { "B not readable: ${b.absolutePath}" }
        require(op in 0..2) { "op must be 0=Union, 1=Difference, 2=Intersection" }
        output.parentFile?.mkdirs()
        output.delete()
        nativeMeshBoolean(a.absolutePath, b.absolutePath, op, output.absolutePath) == 0
    }

    object BoolOp {
        const val UNION = 0
        const val DIFFERENCE = 1
        const val INTERSECTION = 2
    }

    /**
     * Phase XR_OBJ_6 — split a multi-component mesh into one 3MF per
     * disconnected component. The caller plates each output as its
     * own PlacedModel. A single-component input still produces one
     * output 3MF (split is idempotent).
     *
     * Returns the list of output 3MF absolute paths, or null on
     * failure.
     */
    suspend fun splitObject(
        input: File,
        outDir: File,
    ): List<String>? = withContext(dispatcher) {
        require(input.exists() && input.canRead()) {
            "input not readable: ${input.absolutePath}"
        }
        outDir.mkdirs()
        nativeSplitObject(input.absolutePath, outDir.absolutePath)?.toList()
    }

    suspend fun arrangeModels(
        inputs: List<File>,
        priorTransforms: FloatArray,
        bedWmm: Float,
        bedHmm: Float,
        gapMm: Float = 5f,
    ): FloatArray? = withContext(dispatcher) {
        require(inputs.isNotEmpty()) { "arrangeModels needs at least one input" }
        require(priorTransforms.size == inputs.size * 9) {
            "priorTransforms.size=${priorTransforms.size} != ${inputs.size}*9"
        }
        inputs.forEach {
            require(it.exists()) { "input not found: ${it.absolutePath}" }
            require(it.canRead()) { "input not readable: ${it.absolutePath}" }
        }
        val paths = inputs.map { it.absolutePath }.toTypedArray()
        nativeArrange(paths, priorTransforms, bedWmm, bedHmm, gapMm)
    }

    /**
     * Read [input] (3MF / AMF) and emit a per-vertex-colored GLB at
     * [outGlb] using [paletteRgb] for the per-extruder colors. Each
     * triangle painted with extruder N is emitted with `palette[N-1]`;
     * un-painted triangles use the volume's default extruder color.
     *
     * Used by the in-XR preview path so a multi-color 3MF (e.g. a
     * Bambu painted dragon) renders with its actual color regions
     * instead of as a flat single-color mesh.
     *
     * [paletteRgb] is a flat list of RGB triples in 0..1: `[r0, g0,
     * b0, r1, g1, b1, ...]`. Up to 16 slots are honored
     * (matches `EnforcerBlockerType::ExtruderMax` on the C++ side).
     * Slots not provided default to white.
     *
     * Returns true on success.
     */
    suspend fun writeColoredGlb(
        input: File,
        outGlb: File,
        paletteRgb: FloatArray,
        /**
         * Phase J §G in-XR paint preview. Per-triangle filament-slot
         * byte array; authored facets overwrite embedded 3MF paint
         * before the colored mesh is walked. Null = preview the input
         * as authored (existing 3MF / single-color STL behavior).
         */
        paintFilamentIndex: ByteArray? = null,
        objectIndex: Int = -1,
    ): Boolean = withContext(dispatcher) {
        require(input.exists()) { "input not found: ${input.absolutePath}" }
        require(input.canRead()) { "input not readable: ${input.absolutePath}" }
        outGlb.parentFile?.mkdirs()
        outGlb.delete()
        nativeWriteColoredGlb(input.absolutePath, outGlb.absolutePath, paletteRgb, paintFilamentIndex, objectIndex) == 0
    }

    /**
     * Save [input] (any supported mesh format) plus the active
     * [config] as a single 3MF at [outPath]. The 3MF embeds the
     * model + the merged DynamicPrintConfig — re-opening it in
     * OrcaXR or desktop OrcaSlicer brings back the same slice
     * settings.
     *
     * Returns true on success.
     */
    suspend fun saveAs3mf(
        input: File,
        outPath: File,
        config: Map<String, String> = emptyMap(),
        /**
         * Paint full-feature-parity (3MF round-trip) — per-triangle
         * paint state arrays sized to the source mesh's first volume's
         * triangle count. Each authored onto the corresponding facet
         * annotation BEFORE store_3mf so the saved 3MF can be opened
         * in desktop OrcaSlicer with paint intact. Null = the source's
         * existing facet state passes through unchanged.
         */
        paintFilamentIndex: ByteArray? = null,
        supportFlags: ByteArray? = null,
        seamFlags: ByteArray? = null,
        fuzzySkinFlags: ByteArray? = null,
        /**
         * Paint full-feature-parity (Brim Ears) — flat float[4N] of
         * (x, y, z, head_radius) quads. Null / empty = no ears.
         */
        brimEars: FloatArray? = null,
    ): Boolean = withContext(dispatcher) {
        require(input.exists()) { "input not found: ${input.absolutePath}" }
        require(input.canRead()) { "input not readable: ${input.absolutePath}" }
        outPath.parentFile?.mkdirs()
        outPath.delete()
        val (keys, values) = if (config.isEmpty()) {
            emptyArray<String>() to emptyArray<String>()
        } else {
            config.keys.toTypedArray() to config.values.toTypedArray()
        }
        // Filter out empty-paint arrays so the JNI side short-circuits
        // the application loop on "all zero" as well as "null".
        val effPaint = if (paintFilamentIndex == null || !paintFilamentIndex.any { it != 0.toByte() }) null else paintFilamentIndex
        val effSupport = if (supportFlags == null || !supportFlags.any { it != 0.toByte() }) null else supportFlags
        val effSeam = if (seamFlags == null || !seamFlags.any { it != 0.toByte() }) null else seamFlags
        val effFuzzy = if (fuzzySkinFlags == null || !fuzzySkinFlags.any { it != 0.toByte() }) null else fuzzySkinFlags
        val effBrim = if (brimEars == null || brimEars.isEmpty()) null else brimEars
        nativeSaveAs3mf(
            input.absolutePath, outPath.absolutePath, keys, values,
            effPaint, effSupport, effSeam, effFuzzy, effBrim,
        ) == 0
    }

    /**
     * Read the embedded `filament_colour` array out of a .3mf's
     * `Metadata/project_settings.config` and return each entry as a
     * "#RRGGBB" string. Returns an empty list when:
     *   - the file isn't a .3mf
     *   - the archive doesn't contain a project_settings.config
     *   - the config has no `filament_colour` field
     *   - the field is empty
     *
     * Trims any "#RRGGBBAA" alpha suffix to "#RRGGBB" since the rest
     * of the app uses the 6-char form.
     */
    suspend fun read3mfFilamentColours(input: File): List<String> = withContext(dispatcher) {
        if (!input.exists() || !input.canRead()) return@withContext emptyList()
        val raw = nativeRead3mfFilamentColours(input.absolutePath) ?: return@withContext emptyList()
        raw.mapNotNull { s ->
            val cleaned = s.trim().removePrefix("#").uppercase()
            if (cleaned.length < 6) null else "#" + cleaned.take(6)
        }
    }

    /**
     * Project-level wipe-tower / flush settings extracted from a 3MF's
     * `Metadata/project_settings.config`. All fields are comma-joined
     * CSVs (the wire format `set_deserialize_nothrow` accepts); empty
     * means "the key was absent" (or explicitly empty) — the caller
     * falls back to a synthesized default or the bundled profile's
     * value rather than feeding an empty vector to libslic3r.
     *
     *   matrix              — n_filaments² × nozzle_count mm³ values,
     *                         row-major. libslic3r indexes as
     *                         `[from][to]` in
     *                         `WipeTowerIntegration::plan_toolchange`
     *                         (Print.cpp:3240). Size mismatch is a
     *                         load-bearing OOB hazard.
     *   multiplier          — nozzle_count scalars. Per-toolchange
     *                         purge = `matrix[from][to] *
     *                         multiplier[nozzle_id]` (Print.cpp:3270).
     *                         FullSpectrum tunes to 0.9 (vs libslic3r
     *                         0.3 default).
     *   primeVolume         — coFloat scalar mm³ per prime pad. Default
     *                         45; tuned 3MFs ~38 — the delta multiplied
     *                         by layer count is ~5 g on a 300-layer
     *                         4-color print.
     *   primeTowerWidth     — coFloat mm. Tower X/Y dimension. Default
     *                         35 (U1 ships 30); tuned 3MFs may use 28.
     *   primeTowerBrimWidth — coFloat mm. Skirt around the tower base.
     *
     * Returned by [read3mfFlushSettings]. Consumed by `mergedConfig`
     * in MainActivity.
     */
    data class FlushSettings(
        val matrix: String,
        val multiplier: String,
        val primeVolume: String = "",
        val primeTowerWidth: String = "",
        val primeTowerBrimWidth: String = "",
    )

    /**
     * Read the embedded wipe-tower / flush settings out of a .3mf's
     * `Metadata/project_settings.config` in one zip-open round trip.
     * Returns null when the file isn't a .3mf or the project config
     * is missing entirely; otherwise a [FlushSettings] with empty
     * strings for any individual field whose key was absent.
     *
     * Tuned 3MFs (FullSpectrum, OrcaSlicer with calibration data)
     * typically override this whole group together — matrix +
     * multiplier + prime volume + tower geometry are co-tuned in the
     * desktop authoring flow. Honoring all five closes the per-print
     * efficiency gap vs desktop slicers (~10% on a multi-color print).
     */
    suspend fun read3mfFlushSettings(input: File): FlushSettings? = withContext(dispatcher) {
        if (!input.exists() || !input.canRead()) return@withContext null
        val raw = nativeRead3mfFlushSettings(input.absolutePath) ?: return@withContext null
        FlushSettings(
            matrix = raw.getOrNull(0).orEmpty(),
            multiplier = raw.getOrNull(1).orEmpty(),
            primeVolume = raw.getOrNull(2).orEmpty(),
            primeTowerWidth = raw.getOrNull(3).orEmpty(),
            primeTowerBrimWidth = raw.getOrNull(4).orEmpty(),
        )
    }

    /**
     * The set of `Metadata/project_settings.config` keys [read3mfProjectOverrides]
     * pulls into the merge layer. Mirrors what desktop OrcaSlicer puts
     * in the gcode footer's `; different_settings_to_system =` line —
     * the per-print tuning the user authored away from their preset
     * defaults. Honoring these on load closes a substantial efficiency
     * gap on multicolor 3MF imports (sparse_infill_density / pattern /
     * seam_position / wall_loops are typically tuned per-design).
     *
     * Layer-height keys are DELIBERATELY EXCLUDED. They flow exclusively
     * from the user's slicer-profile pick + the optional layer-height
     * override TextField in the UI. Pre-fix the user picked
     * "0.12 Fine @Snapmaker U1" expecting a 0.12 mm slice, but the
     * 3MF's authored `layer_height=0.20` lived in projectOverrides
     * (which sits ABOVE the profile in `mergedConfig`'s precedence
     * ladder, by design — so the import flow could "replace the
     * preset's values"), and the slice came out at 0.20. The
     * surfacing UX bug: there's no in-XR way to see that the 3MF
     * was overriding the picker, and "I picked 0.12 → I get 0.12"
     * is the only mental model that makes the picker mean anything.
     * If a user really wants the 3MF's authored layer height, they
     * type it into the layer-height-override TextField (or pick a
     * matching profile).
     *
     * Excluded from this list (handled separately, not pass-through):
     *   - layer_height / initial_layer_print_height / first_layer_height
     *     — see above; profile + UI-textfield govern.
     *   - flush_volumes_matrix / flush_multiplier / prime_volume /
     *     prime_tower_width / prime_tower_brim_width — special sizing
     *     validation in mergedConfig (read3mfFlushSettings).
     *   - mixed_filament_definitions — separate FullSpectrum panel
     *     (read3mfMixedFilamentDefinitions).
     *   - filament_colour — separate slot palette flow
     *     (read3mfFilamentColours).
     */
    val PROJECT_OVERRIDE_KEYS: List<String> = listOf(
        "sparse_infill_density",
        "sparse_infill_pattern",
        "seam_position",
        "slowdown_for_curled_perimeters",
        "wall_loops",
        "top_shell_layers",
        "bottom_shell_layers",
        "top_surface_pattern",
        "support_type",
        "enable_support",
        "support_threshold_angle",
    )

    /**
     * Pull every key in [PROJECT_OVERRIDE_KEYS] from a .3mf's
     * `Metadata/project_settings.config` in one zip-open round trip.
     * Returns:
     *   - empty map when the file isn't a 3MF or no key was authored.
     *   - a sparse Map<String, String> with one entry per authored key.
     *     Keys absent in the 3MF are omitted (NOT mapped to "") so
     *     `mergedConfig` can treat the map as a layer-on-top overlay
     *     without false-clobbering profile defaults.
     *
     * Forwarded by [mergedConfig] as a higher-priority overlay than
     * the bundled profile but lower than user UI overrides
     * (`extraOverrides`) — desktop authoring wins over the profile,
     * the user's runtime knob still wins over both.
     */
    suspend fun read3mfProjectOverrides(input: File): Map<String, String> = withContext(dispatcher) {
        if (!input.exists() || !input.canRead()) return@withContext emptyMap()
        val keys = PROJECT_OVERRIDE_KEYS.toTypedArray()
        val raw = nativeRead3mfProjectOverrides(input.absolutePath, keys)
            ?: return@withContext emptyMap()
        buildMap {
            for (i in keys.indices) {
                val v = raw.getOrNull(i).orEmpty()
                if (v.isNotBlank()) put(keys[i], v)
            }
        }
    }

    /**
     * Read the embedded `mixed_filament_definitions` string out of a
     * .3mf's `Metadata/project_settings.config` and return it verbatim.
     * Returns null when:
     *   - the file isn't a .3mf
     *   - the archive doesn't contain a project_settings.config
     *   - the config has no `mixed_filament_definitions` field
     *   - the field is empty
     *
     * The format is FullSpectrum's compact serialization (rows separated
     * by `;`, fields by `,`, see MixedFilamentManager::serialize_custom_
     * entries on the C++ side). Callers pipe it directly into
     * `MixedFilamentStore.loadFromSerialized` — no Kotlin-side parse
     * needed; libslic3r owns both ends of the format.
     */
    suspend fun read3mfMixedFilamentDefinitions(input: File): String? = withContext(dispatcher) {
        if (!input.exists() || !input.canRead()) return@withContext null
        val raw = nativeRead3mfMixedFilamentDefinitions(input.absolutePath)
        if (raw.isNullOrEmpty()) null else raw
    }

    private external fun nativeVersionString(): String
    private external fun nativeSlice(
        stlPath: String,
        outGcodePath: String,
        configKeys: Array<String>,
        configValues: Array<String>,
        progressListener: SlicerProgressListener?,
        /**
         * Optional FullSpectrum virtual-filament remap. Length is the
         * number of project filament slots; entry i is 0 for "no
         * virtual remap, project filament (i+1) keeps its painted face
         * state" or K (1-based) for "rewrite painted face state (i+1) to
         * (num_physical + K) before slicing, so the painted region
         * carries a virtual mixed-filament ID and ToolOrdering's
         * resolve_mixed_1based picks component A or B per layer". Pass
         * null or an empty array when the user has no virtual remaps —
         * the JNI side then skips the rewrite pass entirely.
         */
        virtualRemap: IntArray?,
        /**
         * Phase J in-XR paint state. Per-triangle filament-slot byte
         * array sized to the source mesh's triangle count. Entry i is
         * 0 (unpainted) or 1..32 (filament slot tag). Authored facets
         * are written to the first volume's `mmu_segmentation_facets`
         * BEFORE Print::apply, overwriting any embedded 3MF paint.
         * Pass null or an empty array when the user hasn't painted —
         * embedded 3MF facets pass through untouched.
         */
        paintFilamentIndex: ByteArray?,
        /**
         * Phase XR_OBJ_4 user-authored extra volume paths, parallel to
         * [extraVolumeTypes] and [extraVolumeTransforms]. Each entry is
         * a STL/3MF/AMF/OBJ/STEP container; the JNI loads it via
         * `load_mesh_container` and attaches its first volume's mesh as
         * a new ModelVolume on the loaded model's first ModelObject.
         * Null = no extras (existing single-mesh behavior).
         */
        extraVolumePaths: Array<String>?,
        /**
         * Phase XR_OBJ_4 ModelVolumeType ordinals for the extras. Each
         * entry maps to libslic3r's `Slic3r::ModelVolumeType`:
         *   0 = MODEL_PART, 1 = PARAMETER_MODIFIER, 2 = SUPPORT_ENFORCER,
         *   3 = SUPPORT_BLOCKER, 5 = NEGATIVE_VOLUME.
         * Out-of-range values fall back to MODEL_PART on the C++ side.
         */
        extraVolumeTypes: IntArray?,
        /**
         * Phase XR_OBJ_4 — 12 floats per extra volume:
         *   tx, ty, tz (mm), rxDeg, ryDeg, rzDeg, sxPct, syPct, szPct,
         *   mirrorXSign, mirrorYSign, mirrorZSign (-1f / +1f).
         * Applied to the volume's `m_transformation` (per-volume,
         * relative to the parent ModelObject's instance pose). Null
         * leaves volumes at identity.
         */
        extraVolumeTransforms: FloatArray?,
        /**
         * Phase XR_OBJ_8 — per-triangle support paint state. 0 =
         * unpainted, 1 = ENFORCER, 2 = BLOCKER. See [slice]'s
         * `supportFlags` doc.
         */
        supportFlags: ByteArray?,
        /**
         * Phase XR_OBJ_8 — per-triangle seam paint state. Same
         * encoding as [supportFlags] but flows into `mv->seam_facets`.
         */
        seamFlags: ByteArray?,
        /**
         * Paint full-feature-parity — per-triangle fuzzy-skin paint.
         * Flows into `mv->fuzzy_skin_facets`. State 1 = FUZZY_SKIN.
         * Null = no authored paint.
         */
        fuzzySkinFlags: ByteArray?,
        /**
         * Paint full-feature-parity (Brim Ears) — flat float[4N] of
         * (x, y, z, head_radius) quads. Authored onto
         * `mo->brim_points`. Null = no ears.
         */
        brimEars: FloatArray?,
        /**
         * Phase XR_OBJ_4 (final) — per-object config overrides. Same
         * shape as [configKeys] / [configValues] but applied onto
         * `model.objects.front()->config()` instead of the global
         * Print config. Null = no overrides.
         */
        objectConfigKeys: Array<String>?,
        objectConfigValues: Array<String>?,
    ): Int
    private external fun nativeConvertToStl(
        inputPath: String,
        outStlPath: String,
    ): Int

    suspend fun read3mfObjectMetadata(file: File): Array<ObjectMeta>? = withContext(dispatcher) {
        nativeRead3mfObjectMetadata(file.absolutePath)
    }

    /** Returns plate names from a BBS 3MF, indexed by plate_index-1
     *  (so [0] is "Plate 1"). Empty string when the 3MF doesn't carry
     *  a name for that plate. Returns null for non-BBS / standard 3MFs
     *  (which only have one implicit plate). */
    suspend fun read3mfPlateLabels(file: File): Array<String>? = withContext(dispatcher) {
        nativeRead3mfPlateLabels(file.absolutePath)
    }

    suspend fun extractObjectAsStl(archive: File, objectIndex: Int, outStl: File): Boolean = withContext(dispatcher) {
        nativeExtractObjectAsStl(archive.absolutePath, objectIndex, outStl.absolutePath) == 0
    }

    private external fun nativeRead3mfObjectMetadata(path: String): Array<ObjectMeta>?

    private external fun nativeRead3mfPlateLabels(path: String): Array<String>?

    private external fun nativeExtractObjectAsStl(
        archivePath: String,
        objectIndex: Int,
        outStlPath: String,
    ): Int
    private external fun nativeWriteColoredGlb(
        inputPath: String,
        outGlbPath: String,
        paletteRgb: FloatArray,
        /**
         * Phase J §G in-XR paint state. Per-triangle filament-slot
         * byte array authored onto the first volume's
         * `mmu_segmentation_facets` BEFORE the per-triangle color
         * walk. Null = embedded 3MF paint passes through.
         */
        paintFilamentIndex: ByteArray?,
        objectIndex: Int,
    ): Int
    private external fun nativeRead3mfFilamentColours(inputPath: String): Array<String>?
    private external fun nativeRead3mfMixedFilamentDefinitions(inputPath: String): String?
    /**
     * Two-element envelope: `[flush_volumes_matrix_csv, flush_multiplier_csv]`.
     * Either entry may be the empty string when the corresponding key
     * is absent in the 3MF; null return means the file isn't a 3MF or
     * `Metadata/project_settings.config` is missing entirely.
     */
    private external fun nativeRead3mfFlushSettings(inputPath: String): Array<String>?

    /**
     * Generic project-config reader. Caller supplies the keys to pull;
     * returns a parallel String[] with comma-joined CSVs (empty string
     * for keys not authored). null = not a 3MF / no project config.
     */
    private external fun nativeRead3mfProjectOverrides(
        inputPath: String,
        keys: Array<String>,
    ): Array<String>?
    private external fun nativeAutoOrient(inputPath: String): FloatArray?
    private external fun nativeCutObject(
        inputPath: String,
        outputPath: String,
        planeZmm: Float,
        attrMask: Int,
    ): Int
    private external fun nativeMeshBoolean(
        pathA: String,
        pathB: String,
        op: Int,
        outputPath: String,
    ): Int
    private external fun nativeSplitObject(
        inputPath: String,
        outDir: String,
    ): Array<String>?
    private external fun nativeArrange(
        inputPaths: Array<String>,
        priorTransforms: FloatArray,
        bedWmm: Float,
        bedHmm: Float,
        gapMm: Float,
    ): FloatArray?
    private external fun nativeSaveAs3mf(
        inputPath: String,
        outPath: String,
        configKeys: Array<String>,
        configValues: Array<String>,
        /**
         * Paint full-feature-parity (3MF round-trip) — optional per-
         * triangle paint state arrays applied to the first volume of
         * the first object before store_3mf. Null = pass-through.
         */
        paintFilamentIndex: ByteArray?,
        supportFlags: ByteArray?,
        seamFlags: ByteArray?,
        fuzzySkinFlags: ByteArray?,
        /**
         * Paint full-feature-parity (Brim Ears) — flat float[4N] of
         * (x, y, z, head_radius) quads, authored onto
         * `mo->brim_points`. Null = no ears.
         */
        brimEars: FloatArray?,
    ): Int
    private external fun nativeSliceMulti(
        inputPaths: Array<String>,
        transforms: FloatArray,
        outGcodePath: String,
        configKeys: Array<String>,
        configValues: Array<String>,
        progressListener: SlicerProgressListener?,
        /**
         * Phase J per-input paint state. ByteArray of size == models
         * count; entries are nullable. Null entry → "no paint for
         * this input" (embedded 3MF facets pass through). Whole array
         * null → "no paint anywhere"; the C++ side then short-
         * circuits the per-input paint walk entirely.
         */
        paintFilamentIndices: Array<ByteArray?>?,
        /**
         * Optional 0-based ordinal into the source's `Model::objects`
         * vector per input (parallel to [inputPaths]). -1 (or null
         * array) → legacy `objects.front()` behavior. See the public
         * [sliceMulti] doc for why this exists.
         */
        objectOrdinals: IntArray?,
    ): Int
}

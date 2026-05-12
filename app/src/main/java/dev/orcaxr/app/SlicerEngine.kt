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

    /**
     * Roadmap E8 — slice was canceled mid-flight via [SlicerEngine.abort]
     * (typically from the foreground-service notification's Cancel
     * action or from MCP's `cancel_slice` tool). The output path may or
     * may not exist; callers should treat it as missing.
     */
    object Cancelled : SliceResult
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
        /** Open-edge count remaining after libslic3r's import-time
         *  ADMesh repair. Non-zero means the mesh is non-manifold and
         *  the per-row Fix Model wrench should be exposed; zero means
         *  the mesh is manifold and the wrench can be hidden. Summed
         *  across all model-part volumes of the object. */
        val openEdgeCount: Int,
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
        /**
         * A10 — variable / adaptive layer-height profile applied to
         * the loaded model's first ModelObject before Print::apply.
         * Flat float[] of (z, h) pairs (size must be even, >= 4 to
         * take effect). Pass the result of [computeAdaptiveLayerHeights]
         * verbatim, or hand-build for manual edits. Default null = no
         * override; the slicer uses the global layer_height for every
         * layer.
         */
        layerHeightProfile: FloatArray? = null,
        /**
         * A11 — custom G-code ticks for the active plate (sorted by
         * print_z; libslic3r re-sorts internally so any order is
         * accepted). Default empty = no ticks; the slicer emits
         * vanilla G-code with no per-Z hooks fired. The caller filters
         * for the active plate before calling — multi-plate workflows
         * keep one tick list per plate.
         */
        customGcodeTicks: List<CustomGcodeTick> = emptyList(),
        /**
         * A12 — per-Z-band config overrides authored onto the loaded
         * model's first ModelObject `layer_config_ranges`. Each entry
         * is a `[zMin, zMax)` band + sparse `Map<String, String>` of
         * libslic3r config keys → values. Empty list = no per-band
         * overrides (legacy behavior). Bands with `zMin >= zMax` are
         * skipped server-side with a log line.
         */
        heightRanges: List<HeightRange> = emptyList(),
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

        // D16 — flatten per-volume config overrides into three parallel
        // arrays. Sparse so a volume with no overrides costs nothing.
        // Walk the volumes in declaration order and emit one (idx, k, v)
        // triple per entry in `configOverrides`.
        val (volIdxArr, volKeyArr, volValArr) = run {
            val idxs = ArrayList<Int>()
            val keysL = ArrayList<String>()
            val valsL = ArrayList<String>()
            extraVolumes.forEachIndexed { idx, v ->
                v.configOverrides.forEach { (k, vv) ->
                    idxs += idx; keysL += k; valsL += vv
                }
            }
            if (idxs.isEmpty()) Triple<IntArray?, Array<String>?, Array<String>?>(null, null, null)
            else Triple(idxs.toIntArray(), keysL.toTypedArray(), valsL.toTypedArray())
        }

        // A11 — flatten custom-gcode ticks into 5 parallel arrays.
        val (cgZ, cgT, cgE, cgC, cgX) = flattenCustomGcodeTicks(customGcodeTicks)
        // A12 — flatten height ranges into 5 sparse parallel arrays.
        val (lrZmin, lrZmax, lrIdx, lrK, lrV) = flattenHeightRanges(heightRanges)
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
            volIdxArr,
            volKeyArr,
            volValArr,
            layerHeightProfile,
            cgZ, cgT, cgE, cgC, cgX,
            lrZmin, lrZmax, lrIdx, lrK, lrV,
        )
        if (rc == -5) {
            // Roadmap E8 — nativeAbort() flipped CancelStatus and the
            // pipeline unwound cleanly. Surface as Cancelled so UI /
            // MCP can distinguish "user canceled" from "slicer error".
            return@withContext SliceResult.Cancelled
        }
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
        /**
         * A10 — per-input variable/adaptive layer-height profile,
         * parallel to [models]. Each entry is a flat float[] of (z, h)
         * pairs (must be even-length and >= 4 to take effect) authored
         * onto the cloned ModelObject's `layer_height_profile` BEFORE
         * Print::apply. Null entries skip the override; whole list null
         * = no per-input profiles.
         */
        layerHeightProfilesPerInput: List<FloatArray?>? = null,
        /**
         * A11 — custom G-code ticks for the active plate. Single list
         * applied to `Model::plates_custom_gcodes[curr_plate_index]`;
         * ticks are not per-input (they fire at print Z regardless of
         * which object reaches that height — matches upstream
         * semantics). Default empty = no ticks.
         */
        customGcodeTicks: List<CustomGcodeTick> = emptyList(),
        /**
         * A12 — per-input height-range bands, parallel to [models].
         * Each entry is a list of `[zMin, zMax)` bands + sparse
         * override map authored onto the cloned ModelObject's
         * `layer_config_ranges` BEFORE Print::apply. Null whole-list
         * = no per-input ranges (all inputs use legacy behavior).
         * Inner list size MAY differ per input; an empty inner list
         * skips the apply for that input.
         */
        heightRangesPerInput: List<List<HeightRange>>? = null,
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
        require(layerHeightProfilesPerInput == null || layerHeightProfilesPerInput.size == models.size) {
            "layerHeightProfilesPerInput size ${layerHeightProfilesPerInput?.size} != models size ${models.size}"
        }
        require(heightRangesPerInput == null || heightRangesPerInput.size == models.size) {
            "heightRangesPerInput size ${heightRangesPerInput?.size} != models size ${models.size}"
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
        // A10 — flatten per-input layer-height profiles; null whole-list
        // → null array so the JNI side short-circuits the per-input
        // profile walk entirely.
        val lhpsForJni: Array<FloatArray?>? =
            if (layerHeightProfilesPerInput == null ||
                layerHeightProfilesPerInput.all { it == null }) null
            else Array(models.size) { layerHeightProfilesPerInput[it] }
        // A11 — flatten ticks for the active plate.
        val (cgZ, cgT, cgE, cgC, cgX) = flattenCustomGcodeTicks(customGcodeTicks)
        // A12 — flatten per-input height ranges into 5 Object[]s. Whole-
        // list null (or list of empty lists) → 5 nulls so the JNI
        // short-circuits the per-input range walk entirely.
        val anyRanges = heightRangesPerInput != null &&
            heightRangesPerInput.any { it.isNotEmpty() }
        val lrZminPerInput: Array<FloatArray?>? = if (!anyRanges) null
            else Array(models.size) { idx ->
                heightRangesPerInput!![idx].let { rs ->
                    if (rs.isEmpty()) null else FloatArray(rs.size) { rs[it].zMinMm }
                }
            }
        val lrZmaxPerInput: Array<FloatArray?>? = if (!anyRanges) null
            else Array(models.size) { idx ->
                heightRangesPerInput!![idx].let { rs ->
                    if (rs.isEmpty()) null else FloatArray(rs.size) { rs[it].zMaxMm }
                }
            }
        val lrIdxPerInput: Array<IntArray?>? = if (!anyRanges) null
            else Array(models.size) { idx ->
                val rs = heightRangesPerInput!![idx]
                if (rs.isEmpty()) null
                else {
                    val acc = ArrayList<Int>()
                    rs.forEachIndexed { i, r -> repeat(r.overrides.size) { acc += i } }
                    if (acc.isEmpty()) null else acc.toIntArray()
                }
            }
        val lrKeyPerInput: Array<Array<String>?>? = if (!anyRanges) null
            else Array(models.size) { idx ->
                val rs = heightRangesPerInput!![idx]
                if (rs.isEmpty()) null
                else {
                    val acc = ArrayList<String>()
                    rs.forEach { r -> r.overrides.forEach { (k, _) -> acc += k } }
                    if (acc.isEmpty()) null else acc.toTypedArray()
                }
            }
        val lrValPerInput: Array<Array<String>?>? = if (!anyRanges) null
            else Array(models.size) { idx ->
                val rs = heightRangesPerInput!![idx]
                if (rs.isEmpty()) null
                else {
                    val acc = ArrayList<String>()
                    rs.forEach { r -> r.overrides.forEach { (_, v) -> acc += v } }
                    if (acc.isEmpty()) null else acc.toTypedArray()
                }
            }
        val rc = nativeSliceMulti(
            paths,
            transforms,
            outGcode.absolutePath,
            keys,
            values,
            listener,
            paintsForJni,
            objectOrdinals,
            lhpsForJni,
            cgZ, cgT, cgE, cgC, cgX,
            lrZminPerInput, lrZmaxPerInput,
            lrIdxPerInput, lrKeyPerInput, lrValPerInput,
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

    /**
     * Phase A5 ("Fix Model") result — what the repair pass did.
     *
     * [success] mirrors the JNI flag: 1=fully repaired, 2=partial
     * (CGAL pass bailed out, ADMesh-only result returned). 0/-1 cases
     * surface as `null` from [repairModel] instead.
     *
     * [trianglesIn] / [trianglesOut] etc. let the UI surface a "fixed
     * N triangles" toast without the caller having to re-parse the
     * output mesh.
     */
    data class RepairResult(
        val output: File,
        val trianglesIn: Int,
        val trianglesOut: Int,
        val verticesIn: Int,
        val verticesOut: Int,
        val openEdgesIn: Int,
        val openEdgesOut: Int,
        /** 1=fully repaired, 2=partial (CGAL self-union failed). */
        val successFlag: Int,
        /** 0=skipped (already manifold), 1=ran, 2=ran-and-failed. */
        val usedCgal: Int,
    ) {
        val partial: Boolean get() = successFlag == 2
        val trianglesDelta: Int get() = trianglesOut - trianglesIn
    }

    /**
     * Phase A5 ("Fix Model") — cross-platform mesh repair on [input].
     *
     * Pipeline (cheapest pass first; only escalates to CGAL if needed):
     * 1. Load via libslic3r's mesh container reader (STL imports go
     *    through ADMesh's repair pass on the way in).
     * 2. ADMesh-style cleanup: merge bit-equal vertices, drop
     *    degenerate (zero-area) triangles, compactify orphan vertices.
     * 3. Probe `does_self_intersect` and `its_num_open_edges` — if the
     *    mesh is already manifold and non-self-intersecting, skip step
     *    4 entirely (the heavy CGAL pass is the OOM risk).
     * 4. CGAL-via-igl `MeshBoolean::self_union(mesh)` — resolves self-
     *    intersections and reconstructs a manifold result. Wrapped on
     *    the native side with `bad_alloc` catch so a 1M-triangle mesh
     *    that would OOM the 256 MB Android process cap surfaces as
     *    [RepairResult.partial] (keep the ADMesh-only result) instead
     *    of crashing the JNI dispatcher.
     *
     * Output is a single-object 3MF at [output] containing the
     * repaired mesh. The caller replaces `PlacedModel.source` with this
     * path, clears any per-triangle paint state (topology changed →
     * paint indices would misalign), and bumps `previewVersion` to
     * trigger a re-bake of the colored GLB.
     *
     * Returns null if repair was not even attempted (read failed, mesh
     * empty, native OOM in the outer try). Caller should surface this
     * as a Toast.
     */
    suspend fun repairModel(
        input: File,
        output: File,
    ): RepairResult? = withContext(dispatcher) {
        require(input.exists() && input.canRead()) {
            "input not readable: ${input.absolutePath}"
        }
        output.parentFile?.mkdirs()
        output.delete()
        val stats = nativeRepairModel(input.absolutePath, output.absolutePath)
            ?: return@withContext null
        require(stats.size == 8) {
            "nativeRepairModel returned ${stats.size} ints, expected 8"
        }
        if (stats[0] == 0) return@withContext null
        if (!output.exists() || output.length() == 0L) return@withContext null
        RepairResult(
            output = output,
            successFlag = stats[0],
            trianglesIn = stats[1],
            trianglesOut = stats[2],
            verticesIn = stats[3],
            verticesOut = stats[4],
            openEdgesIn = stats[5],
            openEdgesOut = stats[6],
            usedCgal = stats[7],
        )
    }

    // ====================================================================
    // A11 — Custom G-code per print Z (pause / color change / template).
    //
    // Mirrors libslic3r's `Slic3r::CustomGCode::Item`. Stored on
    // `Model::plates_custom_gcodes[plate_index]`; libslic3r's
    // `ToolOrdering::assign_custom_gcodes` reads the active plate's
    // ticks at slice time and the GCode generator emits the matching
    // PrintConfig hooks (`pause_print_gcode`, `M600`, T-commands, or
    // raw user template).
    //
    // The Kotlin caller authors a `List<CustomGcodeTick>` filtered for
    // the active plate and passes it through [slice] / [sliceMulti] /
    // [saveAs3mf]; this layer flattens to the JNI's parallel arrays.
    // ====================================================================

    enum class CustomGcodeKind(val nativeOrdinal: Int) {
        ColorChange(0), PausePrint(1), ToolChange(2), Template(3), Custom(4);
        companion object {
            fun fromOrdinal(o: Int): CustomGcodeKind = when (o) {
                0 -> ColorChange
                1 -> PausePrint
                2 -> ToolChange
                3 -> Template
                4 -> Custom
                else -> Custom
            }
        }
    }

    /**
     * One custom-gcode tick. Triggers libslic3r's matching hook at
     * `printZmm` during gcode export.
     *
     * - [kind] picks the libslic3r action.
     * - [extruder] is 1-based filament/extruder index. 0 = "any" /
     *   informative-only for non-tool-change kinds.
     * - [color] carries either the new filament hex (`#RRGGBB`) for
     *   ColorChange or a short pause-print message for PausePrint
     *   (libslic3r overloads the slot — see CustomGCode.hpp:42).
     * - [extra] carries the raw G-code snippet for Template / Custom,
     *   or the long-form pause message for PausePrint, or "" for
     *   ColorChange / ToolChange.
     */
    data class CustomGcodeTick(
        val printZmm: Float,
        val kind: CustomGcodeKind,
        val extruder: Int = 0,
        val color: String = "",
        val extra: String = "",
    )

    /**
     * D9 — per-volume config overrides extracted from a 3MF.
     * Volumes are returned in declaration order (matches `mo->volumes`).
     */
    data class Read3mfVolumeConfig(
        val name: String,
        val type: ModelVolumeType,
        val overrides: Map<String, String>,
    )

    /** D9 / A12 — per-object config + volume configs + height ranges
     *  extracted from a 3MF. */
    data class Read3mfObjectConfig(
        val objectOverrides: Map<String, String>,
        val volumes: List<Read3mfVolumeConfig>,
        val heightRanges: List<HeightRange> = emptyList(),
    )

    /**
     * Differential diagnostics: load [input] via the same
     * `load_mesh_container` dispatcher production uses (BBS-vs-Prusa 3MF
     * routing, `Model::read_from_file` for STL/OBJ/etc.) and return a
     * deterministic JSON snapshot of the resulting `Slic3r::Model`.
     *
     * The dump is designed to catch upstream-pick regressions in the
     * libslic3r parsers at parser time, before they amplify into a
     * bad slice. Schema and stability rules live in `slic3r_jni.cpp`'s
     * comment above `nativeDumpModelJson`. Float fields use `%.6f`
     * formatting after rounding so goldens compare byte-for-byte
     * across NDK / libc versions.
     *
     * Returns null on read failure or empty model. Goldens live under
     * `app/src/androidTest/assets/diagnostics_goldens/<name>/` paired
     * with their input fixture.
     */
    suspend fun dumpModelJson(input: File): String? = withContext(dispatcher) {
        if (!input.exists() || !input.canRead()) return@withContext null
        nativeDumpModelJson(input.absolutePath)
    }

    /**
     * D9 — extract per-object + per-volume `config` overrides from a
     * 3MF. Returns one [Read3mfObjectConfig] per object in declaration
     * order, or empty list if the file isn't a 3MF / has no overrides
     * authored.
     *
     * Used by the load path to populate
     * [PlacedModel.configOverrides] and [PlacedVolume.configOverrides]
     * so an "open + close + reopen" round-trip on a 3MF authored in
     * desktop OrcaSlicer (or via `set_volume_overrides` in OrcaXR)
     * preserves per-object and per-volume settings.
     */
    suspend fun read3mfObjectConfigs(input: File): List<Read3mfObjectConfig> = withContext(dispatcher) {
        if (!input.exists() || !input.canRead()) return@withContext emptyList()
        val raw = nativeRead3mfObjectConfigs(input.absolutePath) ?: return@withContext emptyList()
        runCatching {
            val arr = org.json.JSONArray(raw)
            val out = ArrayList<Read3mfObjectConfig>(arr.length())
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                val objOver = LinkedHashMap<String, String>()
                obj.optJSONObject("object_overrides")?.also { ov ->
                    val keys = ov.keys()
                    while (keys.hasNext()) {
                        val k = keys.next()
                        objOver[k] = ov.optString(k, "")
                    }
                }
                val volsArr = obj.optJSONArray("volumes")
                val vols = ArrayList<Read3mfVolumeConfig>(volsArr?.length() ?: 0)
                if (volsArr != null) {
                    for (vi in 0 until volsArr.length()) {
                        val v = volsArr.getJSONObject(vi)
                        val name = v.optString("name", "")
                        val typeRaw = v.optString("type", "MODEL_PART")
                        val type = runCatching { ModelVolumeType.valueOf(typeRaw) }
                            .getOrDefault(ModelVolumeType.MODEL_PART)
                        val overObj = v.optJSONObject("overrides")
                        val ov = LinkedHashMap<String, String>()
                        if (overObj != null) {
                            val ks = overObj.keys()
                            while (ks.hasNext()) {
                                val k = ks.next()
                                ov[k] = overObj.optString(k, "")
                            }
                        }
                        vols += Read3mfVolumeConfig(name, type, ov)
                    }
                }
                // A12 — extract height-range bands. Older C++ builds
                // that pre-date the height_ranges field still produce
                // valid JSON without the key; .optJSONArray returns null
                // and the list stays empty.
                val rangesArr = obj.optJSONArray("height_ranges")
                val ranges = ArrayList<HeightRange>(rangesArr?.length() ?: 0)
                if (rangesArr != null) {
                    for (ri in 0 until rangesArr.length()) {
                        val r = rangesArr.getJSONObject(ri)
                        val zMin = r.optDouble("z_min", Double.NaN).toFloat()
                        val zMax = r.optDouble("z_max", Double.NaN).toFloat()
                        if (!zMin.isFinite() || !zMax.isFinite() || zMin >= zMax) continue
                        val overObj = r.optJSONObject("overrides")
                        val ov = LinkedHashMap<String, String>()
                        if (overObj != null) {
                            val ks = overObj.keys()
                            while (ks.hasNext()) {
                                val k = ks.next()
                                ov[k] = overObj.optString(k, "")
                            }
                        }
                        ranges += HeightRange(zMin, zMax, ov)
                    }
                }
                out += Read3mfObjectConfig(objOver, vols, ranges)
            }
            out
        }.getOrElse {
            android.util.Log.e("OrcaXR", "read3mfObjectConfigs parse failed", it)
            emptyList()
        }
    }

    /**
     * A11 — extract custom-gcode-per-print-Z ticks for a single plate
     * from a 3MF. Returns an empty list if the file isn't a 3MF, the
     * plate doesn't exist, or no ticks were authored.
     *
     * `plateIndex` is 0-based; pass 0 for the default / single-plate
     * case. The caller decides which plate to query — typically the
     * active plate at load time.
     */
    suspend fun read3mfCustomGcodes(
        input: File,
        plateIndex: Int = 0,
    ): List<CustomGcodeTick> = withContext(dispatcher) {
        if (!input.exists() || !input.canRead()) return@withContext emptyList()
        val raw = nativeRead3mfCustomGcodes(input.absolutePath, plateIndex)
            ?: return@withContext emptyList()
        runCatching {
            val arr = org.json.JSONArray(raw)
            val out = ArrayList<CustomGcodeTick>(arr.length())
            for (i in 0 until arr.length()) {
                val t = arr.getJSONObject(i)
                val kind = when (t.optString("type", "")) {
                    "ColorChange" -> CustomGcodeKind.ColorChange
                    "PausePrint" -> CustomGcodeKind.PausePrint
                    "ToolChange" -> CustomGcodeKind.ToolChange
                    "Template" -> CustomGcodeKind.Template
                    "Custom" -> CustomGcodeKind.Custom
                    else -> continue
                }
                out += CustomGcodeTick(
                    printZmm = t.optDouble("z_mm", 0.0).toFloat(),
                    kind = kind,
                    extruder = t.optInt("extruder", 0),
                    color = t.optString("color", ""),
                    extra = t.optString("extra", ""),
                )
            }
            out
        }.getOrElse {
            android.util.Log.e("OrcaXR", "read3mfCustomGcodes parse failed", it)
            emptyList()
        }
    }

    // ====================================================================
    // A10 — Variable / adaptive layer height per object.
    //
    // Wraps libslic3r's `layer_height_profile_adaptive` + optional
    // `smooth_height_profile` from `Slicing.cpp`. Returns the per-Z
    // step profile callers can hand back to [slice] / [sliceMulti] via
    // the `layerHeightProfile` parameter to override the global layer
    // height during slice.
    //
    // The profile is a flat float[] of `(z_mm, h_mm)` pairs:
    //   profile[2k]   = print Z in mm
    //   profile[2k+1] = layer thickness in mm at that Z
    // matching libslic3r's `LayerHeightProfile::m_data` layout. Even
    // length, >= 4 entries (the algorithm always emits at least the
    // first object layer + one cap entry).
    //
    // Both A10's "Adaptive layer height" auto-compute and the manual
    // "Variable layer height" tool flow through the same data path —
    // [computeAdaptiveLayerHeights] is the auto path; the manual path
    // hand-builds an array (Z-bar gizmo edits) and writes it onto
    // PlacedModel.layerHeightProfile directly.
    // ====================================================================

    /**
     * A10 — compute an adaptive layer-height profile for a single
     * model.
     *
     * [input] is any libslic3r-loadable container (STL/3MF/AMF/OBJ/STEP).
     * Multi-object containers use the FIRST object only — match the
     * convention every other JNI mesh entry point uses.
     *
     * [config] should at minimum carry `layer_height` /
     * `min_layer_height` / `max_layer_height` / `nozzle_diameter` so
     * libslic3r's `SlicingParameters` produces meaningful min/max
     * bounds for the auto-profile. Empty = use FullPrintConfig
     * defaults (200x200 bed, 0.4 mm nozzle, 0.2 mm layer).
     *
     * [quality] = 0..1 (libslic3r clamps internally). Higher = finer
     * over curved surfaces, coarser over vertical walls. 0.5 is a
     * sane default.
     *
     * [smoothingRadius] = 0..10. 0 disables smoothing entirely. ≥1
     * applies a Gaussian blur with that radius.
     *
     * [smoothingKeepMin] preserves spikes of MIN layer thickness (don't
     * blur them into the surrounding average) — matches upstream's
     * "Keep min" checkbox.
     *
     * Returns the profile or null on read failure / empty mesh / native
     * exception.
     */
    suspend fun computeAdaptiveLayerHeights(
        input: File,
        config: Map<String, String> = emptyMap(),
        quality: Float = 0.5f,
        smoothingRadius: Int = 0,
        smoothingKeepMin: Boolean = false,
    ): FloatArray? = withContext(dispatcher) {
        require(input.exists() && input.canRead()) {
            "input not readable: ${input.absolutePath}"
        }
        require(quality in 0f..1f) { "quality must be in [0, 1], got $quality" }
        require(smoothingRadius in 0..10) {
            "smoothingRadius must be in [0, 10], got $smoothingRadius"
        }
        val (keys, values) = if (config.isEmpty()) {
            emptyArray<String>() to emptyArray<String>()
        } else {
            config.keys.toTypedArray() to config.values.toTypedArray()
        }
        nativeAdaptiveLayerHeights(
            input.absolutePath,
            keys,
            values,
            quality,
            smoothingRadius,
            smoothingKeepMin,
        )
    }

    // ====================================================================
    // D17 — Mesh simplify (quadric edge collapse).
    //
    // Wraps libslic3r's `its_quadric_edge_collapse` (Garland-Heckbert
    // quadric metric, in-place edge collapse). Input is loaded through
    // the same mesh-container reader repair / cut / boolean use; output
    // is a single-object 3MF with the simplified surface.
    //
    // Like repair, simplify mutates topology — the caller MUST sweep
    // paint / supports / seam / fuzzy / brim ears / per-volume metadata
    // when replacing PlacedModel.source. Reusing those byte arrays
    // would bleed paint into the wrong faces.
    // ====================================================================

    /**
     * D17 — simplification result. `triangles_out` reflects the actual
     * post-collapse count; libslic3r usually overshoots the target by a
     * few triangles because edge collapse stops once no further
     * candidates are below `max_error`.
     */
    data class SimplifyResult(
        val output: File,
        val trianglesIn: Int,
        val trianglesOut: Int,
        val verticesIn: Int,
        val verticesOut: Int,
    ) {
        val trianglesDelta: Int get() = trianglesOut - trianglesIn
        val reductionPct: Float get() =
            if (trianglesIn > 0) 100f * (trianglesIn - trianglesOut).toFloat() / trianglesIn else 0f
    }

    /**
     * D17 — simplify [input] to ≈[targetTriangleCount] triangles via
     * quadric edge collapse. [maxError] caps the per-collapse Garland-
     * Heckbert error; pass a small value (≤ 0.01) to preserve sharp
     * features, a large value (≥ 1.0) to let the algorithm collapse
     * aggressively. Pass 0f / negative to disable the cap (uses
     * std::numeric_limits<float>::max() native-side).
     *
     * Output is a single-object 3MF at [output] containing the
     * simplified mesh. The caller replaces `PlacedModel.source` with
     * this path, clears any per-triangle paint state, and bumps
     * `previewVersion` to trigger a re-bake.
     *
     * Returns null when simplification couldn't run (read failed,
     * mesh empty, or target out of range).
     */
    suspend fun simplifyMesh(
        input: File,
        output: File,
        targetTriangleCount: Int,
        maxError: Float = 0f,
    ): SimplifyResult? = withContext(dispatcher) {
        require(input.exists() && input.canRead()) {
            "input not readable: ${input.absolutePath}"
        }
        require(targetTriangleCount > 4) {
            "targetTriangleCount must be > 4 (got $targetTriangleCount)"
        }
        output.parentFile?.mkdirs()
        output.delete()
        val stats = nativeSimplifyMesh(
            input.absolutePath,
            output.absolutePath,
            targetTriangleCount,
            maxError,
        ) ?: return@withContext null
        require(stats.size == 5) {
            "nativeSimplifyMesh returned ${stats.size} ints, expected 5"
        }
        if (stats[0] == 0) return@withContext null
        if (!output.exists() || output.length() == 0L) return@withContext null
        SimplifyResult(
            output = output,
            trianglesIn = stats[1],
            trianglesOut = stats[2],
            verticesIn = stats[3],
            verticesOut = stats[4],
        )
    }

    // ====================================================================
    // D4 — Embossing / SVG inset / text-on-object.
    //
    // Three-step API mirroring upstream OrcaSlicer's GLGizmoEmboss but
    // re-shaped for OrcaXR's stateless JNI surface:
    //
    //   1. [buildTextMesh] — TTF font + text → extruded 3MF (mesh-local
    //      coords, XY centered on origin, Z = 0..depthMm).
    //   2. [buildSvgMesh]  — .svg fills → extruded 3MF (same coord
    //      contract + optional rescale-to-target-size).
    //   3. [applyEmboss]   — host model + emboss mesh + 4×4 transform +
    //      ADD/SUB mode → output 3MF with the boolean applied.
    //
    // The split is deliberate: the build step is fast (~50–200ms for a
    // word) and produces a preview-able mesh; only [applyEmboss] runs
    // the heavy mcut boolean. This lets the UI live-preview the emboss
    // mesh while the user fine-tunes parameters and only commits to the
    // boolean on Apply.
    // ====================================================================

    /**
     * D4 — build a 3D extruded mesh from TTF font glyph outlines.
     *
     * [fontFile] must be a real on-disk .ttf or .otf file (the Kotlin
     * caller stages bundled fonts from `assets/fonts/` to `cacheDir`
     * via [stageBundledFont]). [text] is UTF-8; embedded `\n` produces
     * a multi-line layout.
     *
     * [sizeMm] is the line height in millimeters; glyph width follows
     * from the font's advance metrics. [depthMm] is the Z-extrusion
     * depth.
     *
     * Output is a single-object 3MF at [output] containing the
     * extruded mesh, centered on (0, 0) in XY with Z = 0..depthMm.
     * Caller is responsible for any subsequent transform (surface
     * placement, scaling, etc.) — the file holds raw glyph geometry.
     *
     * Returns the [output] file on success, null on:
     * - font load failure (corrupt or non-TTF/OTF file)
     * - empty result (text contained only unrenderable glyphs)
     * - extrusion failure
     * - write failure
     */
    suspend fun buildTextMesh(
        fontFile: File,
        text: String,
        sizeMm: Float,
        depthMm: Float,
        output: File,
    ): File? = withContext(dispatcher) {
        require(fontFile.exists() && fontFile.canRead()) {
            "font not readable: ${fontFile.absolutePath}"
        }
        require(sizeMm > 0f) { "sizeMm must be positive, got $sizeMm" }
        require(depthMm > 0f) { "depthMm must be positive, got $depthMm" }
        require(text.isNotEmpty()) { "text must not be empty" }
        output.parentFile?.mkdirs()
        output.delete()
        val rc = nativeBuildTextMesh(
            fontFile.absolutePath, text, sizeMm, depthMm, output.absolutePath,
        )
        if (rc != 0 || !output.exists() || output.length() == 0L) {
            android.util.Log.e("OrcaXR", "buildTextMesh rc=$rc, output=${output.absolutePath}")
            return@withContext null
        }
        output
    }

    /**
     * D4 — build a 3D extruded mesh from an SVG file.
     *
     * [svgFile] must be a real on-disk .svg file. Only filled paths
     * are extruded — pure-stroke icons return null. SVG sub-paths
     * inside a single `<path>` element are unioned via Clipper's
     * Even-Odd rule (matches Inkscape's default fill-rule for
     * shapes-with-holes like the inside of an "O").
     *
     * [targetSizeMm] is the desired max XY dimension of the result in
     * millimeters; the native side computes the current XY bbox and
     * rescales uniformly so `max(bboxX, bboxY) == targetSizeMm`.
     * Pass 0 to skip the rescale and use the SVG's own (mm-parsed)
     * units. [depthMm] is the Z-extrusion depth.
     *
     * Output is a single-object 3MF at [output] centered on (0, 0)
     * in XY with Z = 0..depthMm.
     *
     * Returns the [output] file on success, null on:
     * - SVG parse failure (malformed file)
     * - no fillable paths (pure-stroke / empty SVG)
     * - extrusion failure
     * - write failure
     */
    suspend fun buildSvgMesh(
        svgFile: File,
        targetSizeMm: Float,
        depthMm: Float,
        output: File,
    ): File? = withContext(dispatcher) {
        require(svgFile.exists() && svgFile.canRead()) {
            "svg not readable: ${svgFile.absolutePath}"
        }
        require(targetSizeMm >= 0f) { "targetSizeMm must be non-negative, got $targetSizeMm" }
        require(depthMm > 0f) { "depthMm must be positive, got $depthMm" }
        output.parentFile?.mkdirs()
        output.delete()
        val rc = nativeBuildSvgMesh(
            svgFile.absolutePath, targetSizeMm, depthMm, output.absolutePath,
        )
        if (rc != 0 || !output.exists() || output.length() == 0L) {
            android.util.Log.e("OrcaXR", "buildSvgMesh rc=$rc, output=${output.absolutePath}")
            return@withContext null
        }
        output
    }

    /**
     * D4 — apply a previously-built emboss/engrave mesh to a [host]
     * model via mcut::make_boolean.
     *
     * [host] is a 3MF / STL containing the target model. [emboss] is
     * the result of [buildTextMesh] / [buildSvgMesh] (already in
     * mesh-local printer-mm space, XY-centered).
     *
     * [mode] selects the operation:
     * - [EmbossMode.ADD] (UNION) — emboss-out: raised letters / icon
     *   on top of the host's surface.
     * - [EmbossMode.SUB] (A_NOT_B) — engrave-in: cut the emboss
     *   geometry out of the host (recessed letters / inset icon).
     *
     * [transform4x4] is a row-major 16-float 4×4 matrix that
     * positions the emboss mesh relative to the host's printer-mm
     * coordinate system before the boolean. Build with the helpers
     * in [EmbossOp] (e.g. [EmbossOp.transformForTopOfBbox]).
     *
     * Output is a single-object 3MF at [output] with the boolean
     * result. The caller replaces `PlacedModel.source` with [output]
     * and clears any per-triangle paint state — the topology has
     * changed, so paint indices are no longer valid.
     *
     * Returns true on success, false on host/emboss read failure,
     * empty boolean result, or write failure (see logs).
     */
    suspend fun applyEmboss(
        host: File,
        emboss: File,
        mode: EmbossMode,
        transform4x4: FloatArray,
        output: File,
    ): Boolean = withContext(dispatcher) {
        require(host.exists() && host.canRead()) {
            "host not readable: ${host.absolutePath}"
        }
        require(emboss.exists() && emboss.canRead()) {
            "emboss not readable: ${emboss.absolutePath}"
        }
        require(transform4x4.size == 16) {
            "transform4x4 must have 16 floats (4×4 row-major), got ${transform4x4.size}"
        }
        output.parentFile?.mkdirs()
        output.delete()
        val rc = nativeApplyEmboss(
            host.absolutePath, emboss.absolutePath,
            mode.nativeOrdinal, transform4x4, output.absolutePath,
        )
        if (rc != 0) {
            android.util.Log.e("OrcaXR", "applyEmboss rc=$rc, mode=$mode")
            return@withContext false
        }
        output.exists() && output.length() > 0L
    }

    /**
     * D12 — build a stock primitive mesh (cube / cylinder / sphere /
     * cone / torus / disc / slab) using libslic3r's `its_make_*`
     * helpers and write it to a binary STL at [output].
     *
     * [params] is parallel to [PrimitiveKind.paramNames] — caller can
     * use [PrimitiveKind.defaults] verbatim or splice overrides via
     * [PrimitiveKind.paramsFromMap]. The native code clamps each
     * parameter to a sane minimum (>= 0.001 mm for lengths, >= 0.5°
     * for facet angle) so a malformed param won't crash the slicer.
     *
     * The result is centered on the XY origin with Z-min == 0, ready
     * to drop straight onto the bed.
     *
     * Returns the [output] file on success, null on:
     * - param-count mismatch
     * - native build failure (e.g. degenerate dims)
     * - write failure
     */
    suspend fun buildPrimitiveStl(
        kind: PrimitiveKind,
        params: FloatArray,
        output: File,
    ): File? = withContext(dispatcher) {
        require(params.size >= kind.defaults.size) {
            "params for $kind expects ${kind.defaults.size} entries, got ${params.size}"
        }
        output.parentFile?.mkdirs()
        output.delete()
        val rc = nativeBuildPrimitiveStl(kind.nativeOrdinal, params, output.absolutePath)
        if (rc != 0 || !output.exists() || output.length() == 0L) {
            android.util.Log.e("OrcaXR", "buildPrimitiveStl rc=$rc kind=$kind")
            return@withContext null
        }
        output
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
        /**
         * D9 — per-object config overrides written onto
         * `mo->config` before store_3mf so libslic3r serializes them
         * into `Metadata/model_settings.config`. Default empty = no
         * overrides.
         */
        objectConfigOverrides: Map<String, String> = emptyMap(),
        /**
         * D9 — per-volume config overrides keyed by 0-based volume
         * index in `mo->volumes`. Volume index 0 is the primary mesh
         * (typical use); 1+ are user-added extras. Empty map for a
         * volume = no overrides for that volume.
         */
        volumeConfigOverrides: Map<Int, Map<String, String>> = emptyMap(),
        /**
         * A11 — custom G-code ticks for the active plate.
         */
        customGcodeTicks: List<CustomGcodeTick> = emptyList(),
        /**
         * A12 — per-Z-band config overrides written onto
         * `mo->layer_config_ranges` BEFORE store_3mf so libslic3r's
         * bbs_3mf writer serializes them into
         * `Metadata/layer_config_ranges.xml`. Empty list = no
         * per-band overrides (legacy behavior). Bands with
         * `zMin >= zMax` are skipped server-side.
         */
        heightRanges: List<HeightRange> = emptyList(),
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

        val (objKeys, objValues) = if (objectConfigOverrides.isEmpty()) null to null
        else objectConfigOverrides.keys.toTypedArray() to objectConfigOverrides.values.toTypedArray()

        val (volIdxArr, volKeyArr, volValArr) = run {
            val idxs = ArrayList<Int>()
            val ks = ArrayList<String>()
            val vs = ArrayList<String>()
            for ((volIdx, map) in volumeConfigOverrides) {
                for ((k, v) in map) { idxs += volIdx; ks += k; vs += v }
            }
            if (idxs.isEmpty()) Triple<IntArray?, Array<String>?, Array<String>?>(null, null, null)
            else Triple(idxs.toIntArray(), ks.toTypedArray(), vs.toTypedArray())
        }

        val (cgZ, cgT, cgE, cgC, cgX) = flattenCustomGcodeTicks(customGcodeTicks)
        val (lrZmin, lrZmax, lrIdx, lrK, lrV) = flattenHeightRanges(heightRanges)

        nativeSaveAs3mf(
            input.absolutePath, outPath.absolutePath, keys, values,
            effPaint, effSupport, effSeam, effFuzzy, effBrim,
            objKeys, objValues,
            volIdxArr, volKeyArr, volValArr,
            cgZ, cgT, cgE, cgC, cgX,
            lrZmin, lrZmax, lrIdx, lrK, lrV,
        ) == 0
    }

    /**
     * A11 — flatten a tick list into the 5 parallel arrays the JNI
     * expects. Returns all-null on an empty list so the JNI side
     * short-circuits the apply loop entirely.
     */
    private data class CustomGcodeJniArrays(
        val z: FloatArray?,
        val type: IntArray?,
        val extruder: IntArray?,
        val color: Array<String>?,
        val extra: Array<String>?,
    )

    private fun flattenCustomGcodeTicks(ticks: List<CustomGcodeTick>): CustomGcodeJniArrays {
        if (ticks.isEmpty()) return CustomGcodeJniArrays(null, null, null, null, null)
        val n = ticks.size
        val z = FloatArray(n) { ticks[it].printZmm }
        val t = IntArray(n) { ticks[it].kind.nativeOrdinal }
        val ex = IntArray(n) { ticks[it].extruder }
        val cs = Array(n) { ticks[it].color }
        val xs = Array(n) { ticks[it].extra }
        return CustomGcodeJniArrays(z, t, ex, cs, xs)
    }

    /**
     * A12 — packed shape of the parallel arrays the JNI walks for
     * `mo->layer_config_ranges`. See [nativeSlice]'s `layerRangeZmin`…
     * docs. All five fields are null when the input list is empty so
     * the C++ side short-circuits the apply loop entirely.
     */
    private data class HeightRangeJniArrays(
        val zMin: FloatArray?,
        val zMax: FloatArray?,
        val rangeIdx: IntArray?,
        val keys: Array<String>?,
        val values: Array<String>?,
    )

    /**
     * A12 — flatten a [HeightRange] list into the 5 parallel arrays
     * the JNI consumes. Bands without overrides still produce a band
     * entry (so an empty band can serve as a "no override here, but
     * fix the layer height boundary" affordance — matches upstream).
     */
    private fun flattenHeightRanges(ranges: List<HeightRange>): HeightRangeJniArrays {
        if (ranges.isEmpty())
            return HeightRangeJniArrays(null, null, null, null, null)
        val n = ranges.size
        val zMin = FloatArray(n) { ranges[it].zMinMm }
        val zMax = FloatArray(n) { ranges[it].zMaxMm }
        val idxs = ArrayList<Int>()
        val ks = ArrayList<String>()
        val vs = ArrayList<String>()
        ranges.forEachIndexed { i, r ->
            r.overrides.forEach { (k, v) ->
                idxs += i; ks += k; vs += v
            }
        }
        val rangeIdx = if (idxs.isEmpty()) null else idxs.toIntArray()
        val keys = if (ks.isEmpty()) null else ks.toTypedArray()
        val values = if (vs.isEmpty()) null else vs.toTypedArray()
        return HeightRangeJniArrays(zMin, zMax, rangeIdx, keys, values)
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
        // Per-feature speed/accel/jerk + filament tuning. Added 2026-05-02
        // for A9 Phase 2 — the user's reference Snapmaker-desktop slice
        // emits values in its CONFIG_BLOCK that came from per-print
        // customizations (filament_max_volumetric_speed=20 not 22,
        // filament_flow_ratio=0.966 not 1, nozzle_temperature=220 not 215)
        // that were never reaching OrcaXR because none of these keys
        // were in PROJECT_OVERRIDE_KEYS. None of these have a dedicated
        // OrcaXR UI picker (unlike layer_height), so 3MF-authored values
        // winning over the profile is the right behavior — desktop's
        // "save with current settings" expects to round-trip.
        "filament_max_volumetric_speed",
        "filament_flow_ratio",
        "nozzle_temperature",
        "nozzle_temperature_initial_layer",
        "pressure_advance",
        "enable_pressure_advance",
        "slow_down_layer_time",
        "slow_down_min_speed",
        "fan_cooling_layer_time",
        "fan_min_speed",
        "fan_max_speed",
        "overhang_fan_speed",
        "overhang_fan_threshold",
        "outer_wall_speed",
        "inner_wall_speed",
        "sparse_infill_speed",
        "internal_solid_infill_speed",
        "top_surface_speed",
        "travel_speed",
        "initial_layer_speed",
        "initial_layer_infill_speed",
        "gap_infill_speed",
        "support_speed",
        "support_interface_speed",
        "bridge_speed",
        "internal_bridge_speed",
        "overhang_1_4_speed",
        "overhang_2_4_speed",
        "overhang_3_4_speed",
        "overhang_4_4_speed",
        "small_perimeter_speed",
        "small_perimeter_threshold",
        "outer_wall_acceleration",
        "inner_wall_acceleration",
        "sparse_infill_acceleration",
        "travel_acceleration",
        "initial_layer_acceleration",
        "top_surface_acceleration",
        "bridge_acceleration",
        "default_acceleration",
        "outer_wall_jerk",
        "inner_wall_jerk",
        "infill_jerk",
        "travel_jerk",
        "top_surface_jerk",
        "initial_layer_jerk",
        "default_jerk",
        // ---- FullSpectrum overrides ----
        // 3MF projects may carry mixed-filament + dithering settings
        // that the user authored in OrcaXR or another FS-aware fork.
        // Without these in PROJECT_OVERRIDE_KEYS the 3MF's authored
        // virtual rows + dithering knobs would lose to the active
        // profile defaults on reload, breaking round-trip. Excluded
        // ON PURPOSE: layer_height keys (gotcha #22 mandates the user's
        // profile pick wins those).
        "mixed_filament_definitions",
        "mixed_filament_gradient_mode",
        "mixed_filament_height_lower_bound",
        "mixed_filament_height_upper_bound",
        "mixed_filament_advanced_dithering",
        "mixed_filament_pointillism_pixel_size",
        "mixed_filament_pointillism_line_gap",
        "mixed_filament_component_bias_enabled",
        "mixed_filament_surface_indentation",
        "mixed_filament_region_collapse",
        "mixed_color_layer_height_a",
        "mixed_color_layer_height_b",
        "dithering_z_step_size",
        "dithering_local_z_mode",
        "dithering_local_z_whole_objects",
        "dithering_local_z_direct_multicolor",
        "dithering_step_painted_zones_only",
        "local_z_wipe_tower_purge_lines",
        "enable_infill_filament_override",
        "infill_filament_use_base_first_layers",
        "infill_filament_use_base_last_layers",
        // ---- Wall + perimeter strategy ----
        // The 3MF's `different_settings_to_system` field for the desktop
        // FullSpectrum reference (PeggyPalette38+Mini+BRYW.3mf) lists
        // these as user-customized: wall_generator=arachne (vs profile's
        // classic), wall_sequence=outer/inner (vs inner/outer),
        // precise_outer_wall=1 (vs 0). Without these in the override
        // list, OrcaXR slices with profile defaults and emits a totally
        // different wall toolpath (classic walls + inner-first), which
        // shifts the per-slot filament usage to a degree that swamps
        // any mixed-filament resolution comparison.
        "wall_generator",
        "wall_sequence",
        "wall_distribution_count",
        "wall_direction",
        "precise_outer_wall",
        // ---- Skirt / brim / bottom shell ----
        // 3MF says skirt_loops=0 + brim_width=5; profile default is
        // skirt_loops=1 + brim_width=0. Different perimeter geometry
        // → different first-layer extrusion amounts.
        "skirt_loops",
        "skirt_distance",
        "skirt_height",
        "skirt_speed",
        "skirt_start_angle",
        "skirt_type",
        "brim_width",
        "brim_type",
        "brim_object_gap",
        "bottom_shell_thickness",
        "top_shell_thickness",
        "ensure_vertical_shell_thickness",
        "bottom_solid_infill_flow_ratio",
        "top_solid_infill_flow_ratio",
        "top_surface_line_width",
        // ---- Prime / wipe tower ----
        "prime_tower_width",
        "prime_tower_brim_width",
        "prime_volume",
        "wipe_tower_wall_type",
        "wipe_tower_cone_angle",
        "wipe_tower_extra_flow",
        "wipe_tower_extra_spacing",
        "wipe_tower_extra_rib_length",
        "wipe_tower_rib_width",
        "wipe_tower_fillet_wall",
        "wipe_tower_bridging",
        "wipe_tower_max_purge_speed",
        "enable_prime_tower",
        // ---- Other commonly authored print-time keys ----
        "elefant_foot_compensation",
        "elefant_foot_compensation_layers",
        "scarf_joint_speed",
        "scarf_joint_flow_ratio",
        "scarf_angle_threshold",
        "scarf_overhang_threshold",
        "seam_slope_type",
        "seam_slope_min_length",
        "seam_slope_steps",
        "seam_gap",
        "fill_multiline",
        "internal_solid_infill_pattern",
        "bottom_surface_pattern",
        "infill_direction",
        "infill_wall_overlap",
        "top_bottom_infill_wall_overlap",
        "support_multi_bed_types",
        "detect_overhang_wall",
        "detect_thin_wall",
        "detect_narrow_internal_solid_infill",
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
     * Audit H12 (2026-05-07) — return the `layer_height` value that the
     * 3MF authored, if any. Layer-height keys are deliberately
     * EXCLUDED from [PROJECT_OVERRIDE_KEYS] so the user's profile pick
     * + textfield always wins over what the 3MF authored (otherwise
     * a freshly-loaded 3MF silently overrode "0.12 Fine" → "0.20"
     * with no in-XR cue, see the comment block above). But the user
     * still wants to know what the 3MF wanted. Returns the parsed
     * float in mm, or null when:
     *   - the file isn't a 3MF / can't be read
     *   - the project_settings.config doesn't carry layer_height
     *   - the value isn't parseable
     *
     * Surfaced as an info chip in [LeftProjectPanel]'s QualityTab —
     * one tap to apply if the user actually wants the 3MF's value.
     */
    suspend fun read3mfLayerHeight(input: File): Float? = withContext(dispatcher) {
        if (!input.exists() || !input.canRead()) return@withContext null
        val raw = nativeRead3mfProjectOverrides(input.absolutePath, arrayOf("layer_height"))
            ?: return@withContext null
        raw.firstOrNull()?.trim()?.toFloatOrNull()?.takeIf { it in 0.05f..0.50f }
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
    /**
     * A10 — compute an adaptive variable layer-height profile for a
     * single-object model via libslic3r's
     * `layer_height_profile_adaptive` + optional `smooth_height_profile`.
     *
     * [stlPath] is any libslic3r-loadable container (STL/3MF/AMF/OBJ/
     * STEP). Multi-object inputs use the FIRST object only — match the
     * convention every other JNI mesh entry point follows.
     *
     * [configKeys] / [configValues] are the same parallel-array config
     * shape `nativeSlice` accepts — at minimum the caller should pass
     * `layer_height` / `min_layer_height` / `max_layer_height` /
     * `nozzle_diameter` so the slicer's auto-profile produces sensible
     * min/max bounds. Empty / null = `FullPrintConfig::defaults()`.
     *
     * [quality] = 0..1 (libslic3r clamps internally). 0.5 is a sane
     * default. Higher = finer over curved surfaces, coarser over
     * vertical walls.
     *
     * [smoothingRadius] = 0..10. 0 disables smoothing entirely.
     *
     * Returns a flat `FloatArray` of (z, h) pairs (`[z0, h0, z1, h1, ...]`)
     * suitable for [setLayerHeightProfile]. Null on read failure / empty
     * mesh / native exception.
     */
    private external fun nativeAdaptiveLayerHeights(
        stlPath: String,
        configKeys: Array<String>,
        configValues: Array<String>,
        quality: Float,
        smoothingRadius: Int,
        smoothingKeepMin: Boolean,
    ): FloatArray?
    /**
     * Roadmap E8 — abort the in-flight slice if any. Returns true if
     * there was a slice to cancel, false if no slice was running. The
     * JNI flips libslic3r's atomic CancelStatus; the next call to
     * `Print::throw_if_canceled()` inside the slicing pipeline throws
     * `CanceledException` which the slice JNI catches at top level
     * and surfaces as a -3 / "canceled" return.
     *
     * Thread-safe — can be called from any thread (UI, MCP coroutine,
     * a notification-action BroadcastReceiver). No-op when no slice
     * is in flight.
     */
    private external fun nativeAbort(): Boolean

    /** Kotlin-side wrapper for [nativeAbort]. Renamed for clarity at
     *  the call site (`SlicerEngine.abort()` reads better than
     *  `SlicerEngine.nativeAbort()` for non-JNI callers). Returns
     *  false if no slice is in flight. */
    fun abort(): Boolean = runCatching { nativeAbort() }.getOrElse { false }

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
        /**
         * D16 — per-volume config overrides for the user-authored extra
         * volumes. Three parallel arrays in sparse encoding so volumes
         * with no overrides cost nothing across the JNI boundary:
         *   extraVolumeConfigVolIdx[i] → which extras-index (matching
         *                                 [extraVolumePaths]) the (k, v)
         *                                 below applies to.
         *   extraVolumeConfigKeys[i]   → config key.
         *   extraVolumeConfigValues[i] → config value.
         * Null = no per-volume overrides (existing behavior).
         */
        extraVolumeConfigVolIdx: IntArray?,
        extraVolumeConfigKeys: Array<String>?,
        extraVolumeConfigValues: Array<String>?,
        /**
         * A10 — per-object adaptive / variable layer-height profile.
         * Flat float[] of (z, h) pairs (must have even length >= 4 to
         * be applied; otherwise ignored with a log line). Authored onto
         * `mo->layer_height_profile` BEFORE Print::apply so libslic3r
         * uses it instead of the global / config-derived layer height.
         * Null / empty = no profile (legacy behavior).
         */
        layerHeightProfile: FloatArray?,
        /**
         * A11 — custom G-code per print Z. Five parallel arrays of
         * the same length (any may be null/empty for no ticks).
         * `customGcodeTypes` ordinals match
         * `Slic3r::CustomGCode::Type`:
         *   0 = ColorChange, 1 = PausePrint, 2 = ToolChange,
         *   3 = Template,    4 = Custom.
         * Authored onto `model.plates_custom_gcodes[curr_plate_index]`
         * BEFORE Print::apply.
         */
        customGcodeZmm: FloatArray?,
        customGcodeTypes: IntArray?,
        customGcodeExtruders: IntArray?,
        customGcodeColors: Array<String>?,
        customGcodeExtras: Array<String>?,
        /**
         * A12 — per-Z-band config overrides applied onto
         * `model.objects.front()->layer_config_ranges` BEFORE
         * Print::apply. Five sparse parallel arrays:
         *   layerRangeZmin[r]               = band r's zMin in mm
         *   layerRangeZmax[r]               = band r's zMax in mm
         *   layerRangeOverrideRangeIdx[i]   = band slot for the (k, v) below
         *   layerRangeOverrideKeys[i]       = config key
         *   layerRangeOverrideValues[i]     = config value
         * Null = no per-band overrides (legacy behavior). Bands with
         * `zMin >= zMax` are skipped server-side with a log line.
         */
        layerRangeZmin: FloatArray?,
        layerRangeZmax: FloatArray?,
        layerRangeOverrideRangeIdx: IntArray?,
        layerRangeOverrideKeys: Array<String>?,
        layerRangeOverrideValues: Array<String>?,
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

    private external fun nativeDumpModelJson(path: String): String?

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
    private external fun nativeRepairModel(
        inputPath: String,
        outputPath: String,
    ): IntArray?
    /** D17 — quadric edge collapse simplification. See [simplifyMesh]. */
    private external fun nativeSimplifyMesh(
        inputPath: String,
        outputPath: String,
        targetTriCount: Int,
        maxError: Float,
    ): IntArray?
    /** D4 — TTF text → extruded 3MF. See [buildTextMesh]. */
    private external fun nativeBuildTextMesh(
        fontPath: String,
        text: String,
        sizeMm: Float,
        depthMm: Float,
        outPath: String,
    ): Int
    /** D4 — SVG fills → extruded 3MF. See [buildSvgMesh]. */
    private external fun nativeBuildSvgMesh(
        svgPath: String,
        targetSizeMm: Float,
        depthMm: Float,
        outPath: String,
    ): Int
    /** D4 — host + emboss + mode → boolean'd 3MF. See [applyEmboss]. */
    private external fun nativeApplyEmboss(
        hostPath: String,
        embossPath: String,
        mode: Int,
        xform4x4RowMajor: FloatArray,
        outPath: String,
    ): Int
    private external fun nativeArrange(
        inputPaths: Array<String>,
        priorTransforms: FloatArray,
        bedWmm: Float,
        bedHmm: Float,
        gapMm: Float,
    ): FloatArray?
    /** D12 — build a stock primitive mesh and write it as a binary STL.
     *  Returns 0 on success, negative on failure. See [buildPrimitiveStl]. */
    private external fun nativeBuildPrimitiveStl(
        kind: Int,
        params: FloatArray,
        outPath: String,
    ): Int
    @Suppress("LongParameterList")
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
        /**
         * D9 — per-object config overrides applied onto
         * `model.objects.front()->config()` before store_3mf so the
         * 3MF carries them in `Metadata/model_settings.config`. Same
         * shape as [configKeys] / [configValues] but keys land on the
         * OBJECT's local config rather than the global Print config.
         * Null = no overrides.
         */
        objectConfigKeys: Array<String>?,
        objectConfigValues: Array<String>?,
        /**
         * D9 — per-volume config overrides on the first object's
         * volumes. Sparse `(volIdx, key, value)` triples; volIdx is
         * 0-based into `mo->volumes`. Null = no overrides.
         */
        extraVolumeConfigVolIdx: IntArray?,
        extraVolumeConfigKeys: Array<String>?,
        extraVolumeConfigValues: Array<String>?,
        /**
         * A11 — custom G-code ticks for the active plate. See
         * [nativeSlice]. Null = no ticks.
         */
        customGcodeZmm: FloatArray?,
        customGcodeTypes: IntArray?,
        customGcodeExtruders: IntArray?,
        customGcodeColors: Array<String>?,
        customGcodeExtras: Array<String>?,
        /**
         * A12 — per-Z-band config overrides authored onto
         * `mo->layer_config_ranges` BEFORE store_3mf. Same five sparse
         * parallel arrays as [nativeSlice]'s A12 surface.
         */
        layerRangeZmin: FloatArray?,
        layerRangeZmax: FloatArray?,
        layerRangeOverrideRangeIdx: IntArray?,
        layerRangeOverrideKeys: Array<String>?,
        layerRangeOverrideValues: Array<String>?,
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
        /**
         * A10 — per-input adaptive / variable layer-height profile,
         * parallel to [inputPaths]. Each entry is a flat float[] of
         * (z, h) pairs to author onto the cloned ModelObject's
         * `layer_height_profile`. Null entries skip the override for
         * that input; whole array null = no per-input profiles for any
         * input.
         */
        layerHeightProfilesPerInput: Array<FloatArray?>?,
        /**
         * A11 — custom G-code ticks for the active plate. See
         * [nativeSlice]. Null = no ticks.
         */
        customGcodeZmm: FloatArray?,
        customGcodeTypes: IntArray?,
        customGcodeExtruders: IntArray?,
        customGcodeColors: Array<String>?,
        customGcodeExtras: Array<String>?,
        /**
         * A12 — per-input height-range bands. Five Object[]s sized to
         * `inputPaths.size` (or null whole-array = no per-input ranges):
         *   layerRangeZminPerInput[i]              = float[K_i] of band zMins
         *   layerRangeZmaxPerInput[i]              = float[K_i] of band zMaxs
         *   layerRangeOverrideRangeIdxPerInput[i]  = int[M_i] band slot
         *   layerRangeOverrideKeysPerInput[i]      = String[M_i] config key
         *   layerRangeOverrideValuesPerInput[i]    = String[M_i] config value
         * Null per-input entries skip A12 for that input.
         */
        layerRangeZminPerInput: Array<FloatArray?>?,
        layerRangeZmaxPerInput: Array<FloatArray?>?,
        layerRangeOverrideRangeIdxPerInput: Array<IntArray?>?,
        layerRangeOverrideKeysPerInput: Array<Array<String>?>?,
        layerRangeOverrideValuesPerInput: Array<Array<String>?>?,
    ): Int

    /**
     * D9 / A12 — read per-object + per-volume `config` overrides plus
     * per-Z-band height ranges out of a 3MF and return them as a JSON
     * string. See [read3mfObjectConfigs].
     */
    private external fun nativeRead3mfObjectConfigs(path: String): String?

    /**
     * A11 — read the custom-gcode-per-print-Z ticks for a single plate
     * out of a 3MF and return them as a JSON string. See
     * [read3mfCustomGcodes].
     */
    private external fun nativeRead3mfCustomGcodes(
        path: String,
        plateIndex: Int,
    ): String?
}

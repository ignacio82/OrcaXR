package dev.orcaxr.app

import java.io.File
import kotlin.math.max
import kotlin.math.min

/**
 * Bare-minimum G-code reader for libslic3r's FDM output.
 *
 * Tracks the modal X/Y/Z/E state and emits an [ExtrusionSegment] each
 * time E grows along a `G1` move (i.e. plastic was deposited from the
 * previous head position to the new one). Travels (G0/G1 with unchanged
 * or decreasing E) are dropped — they're not visualized in Phase 1's
 * toolpath preview.
 *
 * G-code dialects vary; this parser handles the slice we know libslic3r
 * produces with our default config:
 *   - G1 with X/Y/Z/E/F arguments (E in absolute mode — we set
 *     `use_relative_e_distances=false` in slic3r_jni.cpp).
 *   - `;` comment lines, ignored.
 *   - All other tokens (G92, M-codes, G28, etc.) ignored — they don't
 *     contribute geometry.
 *
 * Out of scope for now: arc moves (G2/G3), relative E, multi-extruder
 * tool changes (T-codes), retract/de-retract bookkeeping for travel
 * filtering.
 */

data class Vec3f(val x: Float, val y: Float, val z: Float) {
    fun coerceMin(other: Vec3f) = Vec3f(min(x, other.x), min(y, other.y), min(z, other.z))
    fun coerceMax(other: Vec3f) = Vec3f(max(x, other.x), max(y, other.y), max(z, other.z))
}

/**
 * Per-segment classification, parsed from libslic3r's `;TYPE:<role>`
 * G-code comments. Matches `ExtrusionEntity::role_to_string` in
 * src/libslic3r/ExtrusionEntity.cpp at v2.3.2 — keep the spelling
 * exactly as libslic3r emits it (English locale; we don't see L10N
 * since libslic3r runs in our JNI context with no preset bundle).
 */
enum class ExtrusionRole(val tag: String) {
    InnerWall("Inner wall"),
    OuterWall("Outer wall"),
    OverhangWall("Overhang wall"),
    SparseInfill("Sparse infill"),
    InternalSolidInfill("Internal solid infill"),
    TopSurface("Top surface"),
    BottomSurface("Bottom surface"),
    Ironing("Ironing"),
    Bridge("Bridge"),
    InternalBridge("Internal Bridge"),
    GapInfill("Gap infill"),
    Skirt("Skirt"),
    Brim("Brim"),
    Support("Support"),
    SupportInterface("Support interface"),
    SupportTransition("Support transition"),
    PrimeTower("Prime tower"),
    Custom("Custom"),
    Multiple("Multiple"),
    Unknown("Undefined");

    companion object {
        private val byTag = entries.associateBy { it.tag }
        fun fromTag(tag: String): ExtrusionRole = byTag[tag.trim()] ?: Unknown
    }
}

data class ExtrusionSegment(
    val start: Vec3f,
    val end: Vec3f,
    val z: Float,
    val role: ExtrusionRole = ExtrusionRole.Unknown,
    /** Tool / extruder index active when the segment was emitted. 0 by default. */
    val extruder: Int = 0,
)

/**
 * A travel move (G0 or G1 without E increase). Not visualized by
 * default — toggle on via the panel UI when the user wants to see
 * where the print head moves between extrusions (retraction zones,
 * wasted travel, etc.).
 */
data class TravelSegment(val start: Vec3f, val end: Vec3f, val z: Float)

data class GcodeStats(
    val totalLines: Int,
    val extrusionSegments: Int,
    val travelSegments: Int,
    val distinctZLayers: Int,
    val bboxMin: Vec3f,
    val bboxMax: Vec3f,
    val totalExtrusionLengthMm: Double,
    /** Filament weight in grams from libslic3r's `; total filament used [g] = …`. */
    val filamentWeightG: Double? = null,
    /** Estimated print time as "1h 23m 45s" — libslic3r emits a placeholder tag. */
    val estimatedPrintTime: String? = null,
    /** Layer count emitted by libslic3r (ground truth) — not the parser's distinct-Z count. */
    val reportedLayerCount: Int? = null,
)

data class ParsedToolpath(
    val segments: List<ExtrusionSegment>,
    val travels: List<TravelSegment>,
    val stats: GcodeStats,
    /**
     * Sorted distinct Z values reached by extrusion moves. Each
     * segment's "layer index" is `layerZs.binarySearch(segment.z)`.
     * `layerZs.size == stats.distinctZLayers`. Useful for the layer
     * scrubber UI.
     */
    val layerZs: List<Float>,
)

object GcodeParser {

    /** Read [path] from disk and parse into segments + stats. */
    fun parse(path: File): ParsedToolpath = parse(path.bufferedReader().lineSequence())

    /** Parse a sequence of G-code lines. Streaming-friendly. */
    fun parse(lines: Sequence<String>): ParsedToolpath {
        var x = 0f; var y = 0f; var z = 0f; var e = 0f
        var bboxMin = Vec3f(Float.POSITIVE_INFINITY, Float.POSITIVE_INFINITY, Float.POSITIVE_INFINITY)
        var bboxMax = Vec3f(Float.NEGATIVE_INFINITY, Float.NEGATIVE_INFINITY, Float.NEGATIVE_INFINITY)
        var totalLines = 0
        var totalExtrusion = 0.0
        var currentRole: ExtrusionRole = ExtrusionRole.Unknown
        // Active extruder index. T0/T1/... or M104/M109 with T parameter
        // both update it; we treat the modal Tn line as canonical.
        var currentTool = 0
        val segments = mutableListOf<ExtrusionSegment>()
        val travels = mutableListOf<TravelSegment>()
        val zLayers = mutableSetOf<Float>()
        var filamentWeightG: Double? = null
        var estimatedTime: String? = null
        var reportedLayers: Int? = null

        for (raw in lines) {
            totalLines++
            // libslic3r tags extrusion-role transitions as `; TYPE:<role>`
            // comment lines. Capture before stripping comments.
            if (raw.length > 6) {
                val ti = raw.indexOf("TYPE:")
                if (ti >= 0 && raw.substring(0, ti).trimStart().startsWith(';')) {
                    currentRole = ExtrusionRole.fromTag(raw.substring(ti + 5))
                }
            }
            // libslic3r emits a small block of `; key = value` summary
            // lines near the end of the G-code (total filament used,
            // estimated time, layers). Catch them at parse time —
            // cheaper than re-reading the file later.
            val trimmed = raw.trimStart()
            if (trimmed.startsWith(';')) {
                val body = trimmed.removePrefix(";").trimStart()
                fun matchPrefix(prefix: String): String? =
                    if (body.startsWith(prefix)) body.removePrefix(prefix).trim() else null
                matchPrefix("total filament used [g] = ")?.toDoubleOrNull()?.let { filamentWeightG = it }
                matchPrefix("total layers count = ")?.toIntOrNull()?.let { reportedLayers = it }
                matchPrefix("estimated printing time (normal mode) = ")?.let { estimatedTime = it }
                matchPrefix("estimated printing time = ")?.let { estimatedTime = estimatedTime ?: it }
            }
            val line = raw.substringBefore(';').trim()
            if (line.isEmpty()) continue
            // Tool-change lines on multi-extruder/toolchanger printers.
            // OrcaSlicer emits bare "T0", "T1" etc. on its own line at
            // each tool change. We also accept M104/M109 with a `T<n>`
            // parameter (Marlin convention) — Klipper's macros pass
            // these through.
            if (line.length >= 2 && line[0] == 'T' && line[1].isDigit()) {
                line.substring(1).takeWhile { it.isDigit() }
                    .toIntOrNull()
                    ?.let { currentTool = it }
                continue
            }
            if (!line.startsWith("G0") && !line.startsWith("G1")) continue
            // Default for an unspecified arg is the modal value (so it
            // stays where it was). E with no E= keeps the current E,
            // which means no extrusion was added → travel.
            var nx = x; var ny = y; var nz = z; var ne = e
            for (token in line.split(Regex("\\s+"))) {
                if (token.length < 2) continue
                val v = token.substring(1).toFloatOrNull() ?: continue
                when (token[0]) {
                    'X' -> nx = v
                    'Y' -> ny = v
                    'Z' -> nz = v
                    'E' -> ne = v
                    // F (feedrate), G (already matched), etc. ignored.
                }
            }
            val extruded = ne > e + 1e-6f
            if (extruded) {
                val start = Vec3f(x, y, z)
                val end = Vec3f(nx, ny, nz)
                segments += ExtrusionSegment(start, end, z = nz, role = currentRole, extruder = currentTool)
                bboxMin = bboxMin.coerceMin(start).coerceMin(end)
                bboxMax = bboxMax.coerceMax(start).coerceMax(end)
                zLayers += nz
                val dx = (nx - x).toDouble(); val dy = (ny - y).toDouble(); val dz = (nz - z).toDouble()
                totalExtrusion += kotlin.math.sqrt(dx * dx + dy * dy + dz * dz)
            } else if (nx != x || ny != y || nz != z) {
                travels += TravelSegment(Vec3f(x, y, z), Vec3f(nx, ny, nz), z = nz)
            }
            x = nx; y = ny; z = nz; e = ne
        }

        val stats = GcodeStats(
            totalLines = totalLines,
            extrusionSegments = segments.size,
            travelSegments = travels.size,
            distinctZLayers = zLayers.size,
            bboxMin = if (bboxMin.x.isFinite()) bboxMin else Vec3f(0f, 0f, 0f),
            bboxMax = if (bboxMax.x.isFinite()) bboxMax else Vec3f(0f, 0f, 0f),
            totalExtrusionLengthMm = totalExtrusion,
            filamentWeightG = filamentWeightG,
            estimatedPrintTime = estimatedTime,
            reportedLayerCount = reportedLayers,
        )
        return ParsedToolpath(
            segments = segments,
            travels = travels,
            stats = stats,
            layerZs = zLayers.sorted(),
        )
    }
}
